// Generate wrangler.toml from environment variables for CI/CD builds.
// This keeps real Cloudflare resource IDs out of the repository while allowing
// Cloudflare's native deployment step to read a valid wrangler.toml.
//
// Required environment variables:
//   D1_DATABASE_ID - D1 database id
//   OAUTH_KV_ID    - KV namespace id for OAuth token store
//
// Optional environment variables:
//   WORKER_NAME       - defaults to "context-mixer"
//   COMPATIBILITY_DATE - defaults to "2026-06-22"

const fs = require('node:fs')
const path = require('node:path')

const required = ['D1_DATABASE_ID', 'OAUTH_KV_ID']
const missing = required.filter((key) => !process.env[key])
if (missing.length > 0) {
  console.error('Missing required environment variables:')
  for (const key of missing) {
    console.error(`  - ${key}`)
  }
  console.error(
    'Set them in your CI/CD environment (Cloudflare dashboard build settings or GitHub Secrets).'
  )
  process.exit(1)
}

const workerName = process.env.WORKER_NAME ?? 'context-mixer'
const compatibilityDate = process.env.COMPATIBILITY_DATE ?? '2026-06-22'

const config = `name = "${workerName}"
main = "src/index.ts"
compatibility_date = "${compatibilityDate}"

[assets]
directory = "./public"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "context-mixer-db"
database_id = "${process.env.D1_DATABASE_ID}"

[[r2_buckets]]
binding = "R2"
bucket_name = "context-mixer-files"

# MCP OAuth (workers-oauth-provider) grant/token store.
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "${process.env.OAUTH_KV_ID}"

# NOTE: Clerk config is intentionally NOT in [vars]. Plain-text [vars] are pushed
# on every \`wrangler deploy\` and overwrite the dashboard Secrets.
#   local      -> .dev.vars
#   production -> dashboard Secrets (survive deploys): CLERK_PUBLISHABLE_KEY,
#                 CLERK_FRONTEND_API, CLERK_SIGN_IN_URL, CLERK_SECRET_KEY
#
# Environment switch: set ENVIRONMENT=development in .dev.vars and
# ENVIRONMENT=production as a dashboard Secret. Code uses this to switch CORS,
# logging, etc. without relying on the presence of Clerk keys.
`

const configPath = path.join(process.cwd(), 'wrangler.toml')
fs.writeFileSync(configPath, config, { encoding: 'utf8' })
console.log(`Generated ${configPath} with production resource IDs`)
