// Auth abstraction layer.
// Keeps the session provider (Clerk) behind an interface so it can be
// swapped without touching routes. See docs/design-doc.md "アダプターパターン".

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

export type HumanAuth = {
  authorType: 'human'
  userId: string
  // マルチテナント: human の ownerUserId は自身の userId と同じ
}

export type AiAuth = {
  authorType: 'ai'
  // FK into api_keys(id). null for grants with no persisted key row (MCP OAuth),
  // where attribution lives in keyName instead. See authorOf / created_by_key_id.
  keyId: string | null
  keyName: string
  scopes: string[] // e.g. ["read", "write"]
  allowedCollections: string[] | null // null = all collections allowed
  entryDocId: string | null
  ownerUserId: string // マルチテナント: このAIキー/OAuth grantの所有者
}

export type AuthContext = HumanAuth | AiAuth

export type Env = {
  DB: D1Database
  R2: R2Bucket
  CLERK_PUBLISHABLE_KEY: string
  CLERK_SECRET_KEY: string
  CLERK_FRONTEND_API: string
  CLERK_SIGN_IN_URL: string
  // MCP OAuth (workers-oauth-provider): KV stores grants/tokens; OAUTH_PROVIDER
  // is the helper API the provider injects for parseAuthRequest/completeAuthorization.
  OAUTH_KV: KVNamespace
  OAUTH_PROVIDER: OAuthHelpers
}

// Props injected by the OAuth provider into McpApiHandler via ctx.props
export type McpProps = {
  userId: string
  keyName: string
  scopes: string[]
  allowedCollections: string[] | null
}

export type AppEnv = {
  Bindings: Env
  Variables: {
    auth: AuthContext
  }
}

// Returns the owner user ID for this auth context (human = own userId, ai = ownerUserId).
export const ownerUserIdOf = (auth: AuthContext): string =>
  auth.authorType === 'human' ? auth.userId : auth.ownerUserId

// Returns true if the given collection is accessible with this auth context.
// Humans and unrestricted AI keys can access everything (within their own tenant).
export const isCollectionAllowed = (auth: AuthContext, collectionId: string): boolean => {
  if (auth.authorType === 'human') return true
  if (auth.allowedCollections === null) return true
  return auth.allowedCollections.includes(collectionId)
}

// Attribution fields for INSERT/UPDATE statements.
export const authorOf = (auth: AuthContext) => ({
  authorType: auth.authorType,
  apiKeyId: auth.authorType === 'ai' ? auth.keyId : null,
  apiKeyName: auth.authorType === 'ai' ? auth.keyName : null,
})
