# Deploying

Read this before pushing to `main`. There is one ordering trap and it will
take the site down if you hit it.

## The trap

**Hostinger deploys the frontend on push to `main`. The database does not
follow automatically.**

Hostinger Deployments watches `main`, clones the repo onto the server, runs
`npm run build`, and copies the result into
`~/domains/goamazing.ai/public_html`. That happens on its own, with no secrets
and no GitHub Actions involved.

Migrations are applied by `.github/workflows/deploy-database.yml`, which
**skips silently** unless `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`
are set as repository secrets. They are not set today.

So a push to `main` right now would ship a frontend that expects `posts`,
`events`, `notifications` and nine other tables, against a production database
that has none of them. Every new page would show "We couldn't load the feed
just now."

**The database goes first. Always.**

## Deploy order

### 1. Get into Supabase

Dashboard: `https://supabase.com/dashboard/project/ppbpukefjvpwrwztsgyj`

You need Owner on the organisation that holds it. If you cannot get in, stop
here: nothing else in this document is possible.

While you are there:

- **Auth → Providers → Email → "Confirm email" must be OFF.** With it on,
  `signUp` returns no session, and a new connector or member cannot redeem
  their code. The CLI cannot change this setting.
- **Rotate or delete the demo accounts.** `moshe@valued.ventures`,
  `zalmytouger@gmail.com`, `mn26ventures@gmail.com` and
  `priya.raghavan@ramedia.dev` all share whatever `DEMO_PASSWORD` was set to
  when `scripts/seed-demo.mjs` last ran. That password is no longer in the
  repository, but anything seeded before this change still carries the old
  one, and it stays readable in the git history.

### 2. Set the repository secrets

GitHub → Settings → Secrets and variables → Actions.

| Secret | Where to find it |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Supabase → Account → Access Tokens → Generate |
| `SUPABASE_PROJECT_REF` | `ppbpukefjvpwrwztsgyj` |
| `SUPABASE_DB_PASSWORD` | Supabase → Project Settings → Database |

`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are **not** required.
Both are committed as defaults in `src/lib/supabase.ts` on purpose, so a build
succeeds from anywhere. Depending on build-time secrets is what left the first
production deploy rendering a blank page.

Do **not** set the `FTP_*` secrets. See "Two deployment systems" below.

### 3. Apply the migrations, before any frontend change

GitHub → Actions → **Deploy database** → Run workflow.

Running it by hand first, rather than letting a push trigger it, means you see
`supabase db push --dry-run` output before anything is applied, and the
frontend has not moved yet if something is wrong.

Thirteen migrations will apply. They are additive: new tables, new policies,
three new columns on existing tables. Nothing is dropped and no existing row
is rewritten.

Expect to see, in order:

    20260902000005_assign_waitlist
    20260907000001_platform_foundation
    20260907000002_social
    20260907000003_trust
    20260907000004_events
    20260907000005_circle_chat
    20260907000006_recommendations
    20260907000007_admin_reads_circles
    20260907000008_avatars
    20260907000009_retention
    20260907000010_audit_actor_survives_deletion
    20260907000011_mentions
    20260907000012_notifications

If `20260907000001` fails on the storage policies, see Troubleshooting.

### 4. Check the database took

    DEMO_PASSWORD=<pw> PUB=<publishable-key> \
      SUPABASE_URL=https://ppbpukefjvpwrwztsgyj.supabase.co \
      node scripts/check-rls.mjs

Twenty-one checks. They assert against whatever project you point them at, and
they need the seeded accounts to exist. On a production project with real
members rather than seed data, expect the first few to fail on names that are
not there; what matters is that none of the *refusals* pass wrongly.

### 5. Only now, the frontend

    git checkout main
    git merge feat/network-surfaces
    git push origin main

Hostinger picks it up within a minute or two. Watch hPanel → Deployments.

### 6. Check it

    curl -sI https://goamazing.ai | head -1        # expect 200
    curl -s https://goamazing.ai | grep -o '/assets/[^"]*js'

The asset hash should change from `index-73VVpB3Y.js`. If it has not, the
Hostinger build did not run or failed; the log is in hPanel → Deployments.

Then sign in and confirm the feed loads rather than showing the calm error.

### 7. Email, when you are ready

Nothing above depends on email, and password recovery does not work in
production until this is done. See `COMPLIANCE.md` gap 10.

- Pick a provider (Resend recommended).
- Add SPF, DKIM and DMARC in hPanel → Advanced → DNS Zone Editor. The domain
  currently has **no MX, no SPF, no DKIM and no DMARC** at all.
- Put the SMTP credentials in Supabase → Project Settings → Auth → SMTP.

### 8. The recommender, when you are ready

    supabase secrets set ANTHROPIC_API_KEY=... RECOMMEND_SECRET=...
    supabase functions deploy recommend

Then add `RECOMMEND_SECRET` as a repository secret so the weekly workflow can
call it. `ANTHROPIC_API_KEY` stays in Supabase and never enters GitHub.

## Two deployment systems

Both are defined in this project and only one runs.

| | State | Verdict |
| --- | --- | --- |
| Hostinger Deployments (git, builds on the server) | active, ships the site | keep |
| `.github/workflows/deploy-frontend.yml` (FTP) | never run, `FTP_*` unset | reduce to a build check |

Do not set the `FTP_*` secrets. If you do, both systems deploy on every push
and race each other. The workflow is still worth keeping for the build it runs
on pull requests, which is what catches a broken build before it reaches
`main`.

Note also that the workflow's `FTP_SERVER_DIR` defaults to `/public_html/`,
which **does not exist on this account**. The real web root is
`~/domains/goamazing.ai/public_html`.

## Rolling back

**Frontend.** Revert the merge on `main` and push. Hostinger rebuilds the
previous commit. hPanel → Deployments also keeps prior builds.

**Database.** There is no down migration, by design. Migrations are
append-only, and every one of these is additive: to undo a feature, add a
migration that drops what it added. Restoring a Supabase backup would lose
everything written since the backup, which is almost never the right trade.

This is why step 3 comes before step 5. A frontend rollback costs a minute; a
database rollback costs data.

## Troubleshooting

**`20260907000001_platform_foundation` fails on `storage.objects` policies.**
Some Supabase projects do not let the migration role create policies on
`storage.objects`. Create the three `media_*` policies by hand in
Dashboard → Storage → Policies, copying them out of the migration, then
re-run.

**The site shows "We couldn't load the feed just now."** The frontend is ahead
of the database. Step 3 did not run or did not finish. This is the trap at the
top of this document.

**A new member cannot redeem their code.** "Confirm email" is on in Supabase
Auth. See step 1.

**`supabase db push` reports a checksum mismatch.** Somebody edited a
migration that had already been applied. Migrations are append-only; add a new
file instead.
