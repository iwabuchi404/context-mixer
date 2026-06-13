// Token management for MCP OAuth using D1
// Tokens are stored persistently and can be verified across requests

const TOKEN_TTL = 3600 * 1000 // 1 hour in milliseconds

export async function generateToken(db: D1Database, userId: string = 'user-123'): Promise<string> {
  const token = `mcp_token_${Date.now()}_${Math.random().toString(36).substr(2, 16)}`
  const now = Date.now()
  const expiresAt = now + TOKEN_TTL

  await db.prepare(`
    INSERT INTO oauth_tokens (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(token, userId, expiresAt, now).run()

  // Cleanup expired tokens (best effort)
  await db.prepare(`DELETE FROM oauth_tokens WHERE expires_at < ?`).bind(now).run()

  return token
}

export async function verifyToken(db: D1Database, token: string): Promise<boolean> {
  const result = await db.prepare(`
    SELECT user_id, expires_at FROM oauth_tokens WHERE token = ?
  `).bind(token).first() as { user_id: string; expires_at: number } | null

  if (!result) return false

  // Check expiration
  if (result.expires_at < Date.now()) {
    // Delete expired token
    await db.prepare(`DELETE FROM oauth_tokens WHERE token = ?`).bind(token).run()
    return false
  }

  return true
}

export async function cleanupExpiredTokens(db: D1Database): Promise<void> {
  const now = Date.now()
  await db.prepare(`DELETE FROM oauth_tokens WHERE expires_at < ?`).bind(now).run()
}
