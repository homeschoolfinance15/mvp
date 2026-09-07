import { supabase } from './supabase'
import type { MediaItem } from './types'

/**
 * Uploads into the private `media` bucket and hands back viewable URLs.
 *
 * The real ceilings — 25 MB, and which mime types are allowed — live on the
 * bucket itself, set in the foundation migration. The checks here are there
 * to fail fast with a readable message, not to be the boundary; a request
 * that skips this file still hits the bucket's own limits.
 */

const BUCKET = 'media'

export const MAX_BYTES = 25 * 1024 * 1024

export const ACCEPTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
]

/** For an <input type="file"> accept attribute. Convenience only. */
export const ACCEPT_ATTR = ACCEPTED_TYPES.join(',')

function extensionOf(file: File): string {
  const fromName = file.name.includes('.') ? file.name.split('.').pop() : ''
  const ext = (fromName || file.type.split('/')[1] || 'bin').toLowerCase()
  // Keep it to something that cannot escape the path.
  return ext.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
}

/**
 * Path convention is `{uid}/{uuid}.{ext}`. The first segment is the owner,
 * and the bucket's insert policy asserts it matches auth.uid() — which is
 * what makes ownership provable from the path alone, with no table to keep
 * in step.
 */
export async function uploadMedia(files: File[]): Promise<MediaItem[]> {
  const { data: auth } = await supabase.auth.getUser()
  const uid = auth.user?.id
  if (!uid) throw new Error('You need to be signed in to upload.')

  const uploaded: MediaItem[] = []

  for (const file of files) {
    if (file.size > MAX_BYTES) {
      throw new Error(`${file.name} is larger than 25 MB.`)
    }
    if (!ACCEPTED_TYPES.includes(file.type)) {
      throw new Error(`${file.name} isn't an image or video we accept.`)
    }

    const path = `${uid}/${crypto.randomUUID()}.${extensionOf(file)}`
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { contentType: file.type, upsert: false })

    if (error) throw error

    uploaded.push({
      path,
      mime: file.type,
      kind: file.type.startsWith('video/') ? 'video' : 'image',
    })
  }

  return uploaded
}

/**
 * The bucket is private, so every render needs signed URLs. Batched into one
 * request per page of content rather than one per image.
 *
 * ponytail: an hour-long signature, refreshed by the next fetch. Long enough
 * that nothing expires while someone reads; short enough that a link pasted
 * elsewhere stops working. Cache these if the feed ever refetches often.
 */
export async function signMedia(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {}

  const unique = [...new Set(paths)]
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(unique, 3600)
  if (error) throw error

  const urls: Record<string, string> = {}
  for (const row of data ?? []) {
    if (row.signedUrl && row.path) urls[row.path] = row.signedUrl
  }
  return urls
}

/** Removing the row leaves the object behind, so callers clean up explicitly. */
export async function removeMedia(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await supabase.storage.from(BUCKET).remove(paths)
}
