// ============================================================================
// recommend — the LLM layer
//
// Runs on a schedule. For each active member it asks Claude which people,
// posts and events are worth their attention, and why, then writes the answer
// into public.recommendations for the member to find on their feed.
//
// This runs as an edge function and not in the browser for one reason: the
// Anthropic key. Every other privileged write in this project goes through a
// SECURITY DEFINER function precisely so no secret has to reach the client,
// and an API key is no different. The browser never sees this code.
//
// What "learns and gets better" honestly means here:
//
//   Nothing is trained. Each run is handed the member's own history — what
//   they were shown last time and what they actually acted on — and Claude
//   adjusts from it in context. The measurable claim is the hit rate in
//   public.recommendation_performance: if the suggestions are improving,
//   that number goes up, and if it doesn't, they aren't.
//
// Deploy:  supabase functions deploy recommend
// Secrets: supabase secrets set ANTHROPIC_API_KEY=... RECOMMEND_SECRET=...
// ============================================================================

import Anthropic from 'npm:@anthropic-ai/sdk@0.124.0'
import { zodOutputFormat } from 'npm:@anthropic-ai/sdk@0.124.0/helpers/zod'
import { createClient } from 'npm:@supabase/supabase-js@2.116.0'
import { z } from 'npm:zod@4.5.4'

const MODEL = 'claude-opus-5'

/** Candidate ceilings. Small on purpose — see the note in the migration. */
const RECENT_POSTS = 60
const UPCOMING_EVENTS = 20
const PER_MEMBER = 6

const Recommendations = z.object({
  recommendations: z
    .array(
      z.object({
        kind: z.enum(['member', 'post', 'event']),
        id: z.string(),
        reason: z
          .string()
          .describe(
            'One sentence, addressed to the member, naming the specific thing they have in common. No flattery.',
          ),
      }),
    )
    .describe('Ranked, best first. Fewer good ones beats a full list.'),
})

const SYSTEM = `You choose what someone sees on AMAZING, a private invitation-only professional network.

Members do not sign up. An administrator appoints connectors, and connectors invite
everyone else, so every member is somebody's deliberate introduction. Treat that as
the standard: recommend what a thoughtful connector would actually put in front of
this person.

Rules:
- Only ever use ids from the candidates given to you. Never invent one.
- The candidate list includes this member and their own posts. Never recommend
  someone to themselves, or their own writing back to them.
- Recommend a member because of something concrete and shared — an interest, a
  profession, an event they were both at. Never because they are simply available.
- The reason is one sentence, addressed to the member as "you", naming the specific
  thing in common. No flattery, no filler, no "you might like".
- Silence beats padding. Return three good recommendations rather than six weak
  ones, and an empty list if nothing genuinely fits.
- You are told what this member was shown before and what they acted on. Move
  towards what they engaged with. Do not repeat a suggestion they ignored.`

interface Candidate {
  id: string
  [key: string]: unknown
}

Deno.serve(async (request: Request) => {
  // The schedule is the only caller. Without this the endpoint is an open
  // invitation to spend money.
  const secret = Deno.env.get('RECOMMEND_SECRET')
  if (!secret || request.headers.get('x-recommend-secret') !== secret) {
    return json({ error: 'Not authorised.' }, 401)
  }

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!anthropicKey) return json({ error: 'ANTHROPIC_API_KEY is not set.' }, 500)

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const claude = new Anthropic({ apiKey: anthropicKey })

  const batchId = crypto.randomUUID()
  const sinceIso = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()

  // One read of the whole candidate pool, shared across every member, rather
  // than the same query once per person.
  const [{ data: people }, { data: posts }, { data: events }, { data: history }] =
    await Promise.all([
      db
        .from('profiles')
        .select('id, full_name, current_profession, interests, profile_status, role')
        .eq('profile_status', 'active'),
      db
        .from('posts')
        .select('id, author_id, body, created_at')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(RECENT_POSTS),
      db
        .from('events')
        .select('id, title, description, location, starts_at')
        .gte('starts_at', new Date().toISOString())
        .order('starts_at', { ascending: true })
        .limit(UPCOMING_EVENTS),
      // What we suggested before, and whether it landed.
      db
        .from('recommendations')
        .select('profile_id, member_id, post_id, event_id, reason, acted_at')
        .gte('created_at', sinceIso),
    ])

  const members = people ?? []
  if (members.length === 0) return json({ batchId, written: 0, members: 0 })

  const nameOf = new Map(members.map((p) => [p.id, p.full_name as string]))

  // Built once and byte-identical for every member in the run, which is what
  // makes it cacheable. Excluding each member from their own candidate list
  // would change the block per member and throw the cache away for a filter
  // that is already enforced twice: below when validating ids, and by the
  // recommendations_not_self check constraint.
  const candidates = {
    people: members.map((p) => ({
      id: p.id,
      name: p.full_name,
      profession: p.current_profession,
      interests: p.interests,
    })),
    posts: (posts ?? []).map((p) => ({
      id: p.id,
      author_id: p.author_id,
      author: nameOf.get(p.author_id as string) ?? 'someone',
      // Enough to judge relevance without shipping the whole feed.
      excerpt: String(p.body ?? '').slice(0, 400),
    })),
    events: events ?? [],
  }

  const candidateIds = {
    member: new Set(candidates.people.map((p) => p.id)),
    post: new Set(candidates.posts.map((p) => p.id)),
    event: new Set((candidates.events as Candidate[]).map((e) => e.id)),
  }

  if (
    candidates.people.length <= 1 &&
    candidates.posts.length === 0 &&
    candidates.events.length === 0
  ) {
    return json({ batchId, members: members.length, written: 0, note: 'Nothing to recommend yet.' })
  }

  const authorOf = new Map(candidates.posts.map((p) => [p.id as string, p.author_id as string]))

  const written: Record<string, number> = {}
  const failures: Record<string, string> = {}

  for (const member of members) {
    try {
      const seen = (history ?? []).filter((h) => h.profile_id === member.id)

      const response = await claude.messages.parse({
        model: MODEL,
        max_tokens: 4000,
        // Caching is a prefix match, so everything shared goes first and the
        // one member's details go last. The candidate pool is the bulk of the
        // prompt and identical across the run: member two onwards reads it
        // from cache at a tenth of the price.
        system: [
          { type: 'text', text: SYSTEM },
          {
            type: 'text',
            text: `Candidates:
${JSON.stringify(candidates, null, 2)}`,
            cache_control: { type: 'ephemeral' },
          },
        ],
        // ponytail: low effort. This is ranking a short list against a short
        // profile, not a hard reasoning problem, and it runs once per member
        // per cycle. Raise it if the reasons start reading as generic.
        output_config: {
          effort: 'low',
          format: zodOutputFormat(Recommendations, 'recommendations'),
        },
        messages: [
          {
            role: 'user',
            content: JSON.stringify(
              {
                member: {
                  id: member.id,
                  name: member.full_name,
                  profession: member.current_profession,
                  interests: member.interests,
                },
                previously: {
                  acted_on: seen.filter((s) => s.acted_at).map((s) => s.reason),
                  ignored: seen.filter((s) => !s.acted_at).map((s) => s.reason),
                },
                pick_at_most: PER_MEMBER,
              },
              null,
              2,
            ),
          },
        ],
      })

      const picks = response.parsed_output?.recommendations ?? []

      // Trust the ids as far as the database will: anything the model invented
      // is dropped here rather than becoming a broken row. The candidate pool
      // includes this member, so their own id is filtered out here.
      const rows = picks
        .filter((pick) => candidateIds[pick.kind]?.has(pick.id))
        .filter((pick) => !(pick.kind === 'member' && pick.id === member.id))
        .filter((pick) => !(pick.kind === 'post' && authorOf.get(pick.id) === member.id))
        .slice(0, PER_MEMBER)
        .map((pick, index) => ({
          profile_id: member.id,
          member_id: pick.kind === 'member' ? pick.id : null,
          post_id: pick.kind === 'post' ? pick.id : null,
          event_id: pick.kind === 'event' ? pick.id : null,
          reason: pick.reason.slice(0, 400),
          rank: index + 1,
          batch_id: batchId,
        }))

      if (rows.length > 0) {
        const { error } = await db.from('recommendations').insert(rows)
        if (error) throw error
        written[member.id] = rows.length
      }
    } catch (error) {
      // One member's failure is not the run's failure.
      failures[member.id] = error instanceof Error ? error.message : String(error)
    }
  }

  return json({
    batchId,
    members: members.length,
    written: Object.values(written).reduce((a, b) => a + b, 0),
    failed: Object.keys(failures).length,
    failures,
  })
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
