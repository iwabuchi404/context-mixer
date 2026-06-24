// API key auth for AI clients.
// Keys are high-entropy random strings, so a single SHA-256 is sufficient
// (bcrypt is too CPU-heavy for the Workers free tier).
import type { AiAuth } from './adapter'

export const API_KEY_PREFIX = 'kb_'

const KEY_BYTES = 32

export const generateApiKey = (): string => {
  const bytes = new Uint8Array(KEY_BYTES)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${API_KEY_PREFIX}${hex}`
}

export const hashApiKey = async (raw: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

type ApiKeyRow = {
  id: string
  name: string
  scopes: string
  collection_ids: string | null
  entry_doc_id: string | null
  owner_user_id: string
  expires_at: number | null
  is_active: number
}

const parseJsonArray = (raw: string | null): string[] | null => {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Verifies a raw API key against D1. Returns the auth context or null.
export const verifyApiKey = async (db: D1Database, raw: string): Promise<AiAuth | null> => {
  if (!raw.startsWith(API_KEY_PREFIX)) return null

  const keyHash = await hashApiKey(raw)
  const row = await db.prepare(
    'SELECT id, name, scopes, collection_ids, entry_doc_id, owner_user_id, expires_at, is_active FROM api_keys WHERE key_hash = ?'
  ).bind(keyHash).first() as ApiKeyRow | null

  if (!row || !row.is_active) return null

  const now = Date.now()
  if (row.expires_at !== null && row.expires_at < now) return null

  // Fire-and-forget style update; failure here must not block the request
  await db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now, row.id).run()

  return {
    authorType: 'ai',
    keyId: row.id,
    keyName: row.name,
    scopes: parseJsonArray(row.scopes) ?? [],
    allowedCollections: parseJsonArray(row.collection_ids),
    entryDocId: row.entry_doc_id,
    ownerUserId: row.owner_user_id,
  }
}
