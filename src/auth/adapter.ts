// Auth abstraction layer.
// Keeps the session provider (Clerk) behind an interface so it can be
// swapped without touching routes. See docs/design-doc.md "アダプターパターン".

export type HumanAuth = {
  authorType: 'human'
  userId: string
}

export type AiAuth = {
  authorType: 'ai'
  keyId: string
  keyName: string
  scopes: string[] // e.g. ["read", "write"]
  allowedCollections: string[] | null // null = all collections allowed
  entryDocId: string | null
}

export type AuthContext = HumanAuth | AiAuth

export type Env = {
  DB: D1Database
  R2: R2Bucket
  CLERK_PUBLISHABLE_KEY: string
  CLERK_SECRET_KEY: string
  CLERK_FRONTEND_API: string
  CLERK_SIGN_IN_URL: string
}

export type AppEnv = {
  Bindings: Env
  Variables: {
    auth: AuthContext
  }
}

// Returns true if the given collection is accessible with this auth context.
// Humans and unrestricted AI keys can access everything.
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
