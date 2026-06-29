# Context Mixer

> **English** | [日本語](./README.ja.md)

An AI-first knowledge base co-managed by AI and humans.

A place where AI can search, read, and write the information it needs on its own. No more manually pasting context into prompts.

## Why I Built This

After my personal projects surpassed 20, using documents stored in Notion from AI tools became painful.

Even a small edit incurred latency, and repeated read/write cycles consumed non-trivial tokens. I looked at other services and apps, but couldn't find one that was both accessible from chat apps and CLI agent tools, and designed with AI in mind.

Notion is great as a tool for humans to read. But its rich block structure gets in the way for AI — you can only retrieve information per page, so fetching a single paragraph costs the tokens of the entire page.

Context Mixer is a knowledge base designed with **AI explorability** as the top priority.

## What It Does

### AI Searches, Reads, and Writes Documents Autonomously

Access directly from Claude Desktop or Claude Code via MCP. Just say "check this project's design policy" and the AI will search and fetch the relevant documents for you. No need to paste context into prompts.

### Granular Retrieval to Reduce Token Consumption

Choose "how much" of a document to read:

```
GET /docs/:id?view=meta      → title + summary only (tens of tokens)
GET /docs/:id?view=outline   → heading structure
GET /docs/:id?view=section   → specific section only
GET /docs/:id?view=full      → full text
```

The AI first checks `meta` to judge relevance, then fetches only the needed parts via `section`. Since it doesn't ingest the full text every time, token consumption drops dramatically.

### Humans Can Also Read and Write via Web UI

Browse the collection tree, edit documents in Markdown, and full-text search — all from the browser. Built lightweight with HTMX, running on server-side rendering only.

### Three Authentication Methods

| Who | Auth Method | Use Case |
|-----|-------------|----------|
| Human (browser) | Clerk session auth | Web UI login |
| AI (REST API) | API key (scope + collection restrictions) | Access from external services |
| AI (MCP) | OAuth 2.1 | Connections from Claude.ai, ChatGPT, etc. |

API keys support policies like "this key can only read this project." You can restrict permissions for keys handed to less trusted external services, giving you peace of mind.

### Other Features

- **Full-text search** — Fast search via D1's FTS5 (trigram). Handles hyphenated terms
- **Document links** — `[[doc_xxx]]` syntax for inter-document links. Backlinks auto-generated
- **Revision history** — Signed revisions recorded for every write. Track who (human/AI/OAuth) changed what
- **File attachments** — Upload images etc. to R2, embed in documents
- **Inbox** — Ingest external submissions via an approval flow

## Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| Runtime | Hono on Cloudflare Workers | Runs on edge, generous free tier |
| DB | D1 (SQLite-compatible) | Workers integration, FTS5 full-text search |
| Storage | R2 | Free egress, image storage |
| Frontend | HTMX + Workers Assets | No build step, server-side rendering |
| Auth | Clerk + API key + OAuth 2.1 | Three auth systems for humans, AI, and MCP clients |
| MCP | workers-oauth-provider | Cloudflare official, Streamable HTTP |

Everything is on Cloudflare for cost reasons. A knowledge base is something you use for years once built, so having running costs near zero (within the free tier for personal use) is quietly significant.

## MCP Tools

9 tools available to AI via MCP:

| Tool | Description | Scope |
|------|-------------|-------|
| `search_docs` | Keyword full-text search with snippets | read |
| `get_doc` | Get document (meta/outline/full/section) | read |
| `list_collections` | List collections (tree structure) | read |
| `list_docs` | List documents in a collection (lightweight, no body) | read |
| `get_entrypoint` | Get entrypoint document | read |
| `write_doc` | Create or update document | write |
| `append_doc` | Append content to end of document | write |
| `delete_doc` | Delete document | write |
| `create_collection` | Create collection | write |

## Supported Clients

| Client | Connection Method |
|--------|-------------------|
| Claude.ai | Settings → Connectors → Custom Connector → Enter URL |
| Claude Code | Register as remote MCP server via `claude mcp add` |
| ChatGPT | Settings → Connectors → Add connector (beta) |
| MCP Inspector | Debug with `npx @modelcontextprotocol/inspector` |

## Self-Hosting

### Prerequisites

- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account (free tier is fine)
- Clerk account (for auth, free tier is fine)

### 1. Clone the repository

```bash
git clone https://github.com/iwabuchi404/context-mixer.git
cd context-mixer
npm install
```

### 2. Create Cloudflare resources

```bash
# Log in to Cloudflare
npx wrangler login

# Create D1 database
npm run d1:create
# → Note the outputted database_id

# Create R2 bucket
npm run r2:create

# Create KV namespace (for MCP OAuth)
npx wrangler kv namespace create OAUTH_KV
# → Note the outputted id
```

Do not write the obtained IDs into `wrangler.toml` — use them as environment variables or CI/CD Secrets as described below.

### 3. Create a Clerk app

1. Create an app at [Clerk](https://clerk.com)
2. Obtain the following values:
   - `CLERK_SECRET_KEY`
   - `CLERK_PUBLISHABLE_KEY`
   - `CLERK_FRONTEND_API` (e.g. `https://your-app.clerk.accounts.dev`)
   - `CLERK_SIGN_IN_URL` (e.g. `https://your-app.clerk.accounts.dev/sign-in`)

### 4. Set secrets

For local development (`.dev.vars`):

```ini
ENVIRONMENT=development
CLERK_SECRET_KEY=sk_test_xxxx
CLERK_PUBLISHABLE_KEY=pk_test_xxxx
CLERK_FRONTEND_API=https://your-clerk-app.clerk.accounts.dev
CLERK_SIGN_IN_URL=https://your-clerk-app.clerk.accounts.dev/sign-in
```

For production:

```bash
npx wrangler secret put ENVIRONMENT
# value: production
npx wrangler secret put CORS_ORIGIN
# value: your production URL (e.g. https://your-app.example.com)
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_PUBLISHABLE_KEY
npx wrangler secret put CLERK_FRONTEND_API
npx wrangler secret put CLERK_SIGN_IN_URL
```

> **Note**: Do not put Clerk values and `CORS_ORIGIN` in `[vars]` in `wrangler.toml`. Every deploy will overwrite the production dashboard Secrets.
>
> **Dev/Prod switching**: Previously, production was detected by the presence of `CLERK_FRONTEND_API`, but since `.dev.vars` can have the same variable name, the detection was ambiguous. Use the `ENVIRONMENT` variable explicitly to switch. You can check the current value via the `environment` field in `GET /auth/config` or `GET /health/config`.

### 5. Run migrations

```bash
# Local
npm run d1:migrate-local

# Production
npm run d1:migrate
```

### 6. Deploy

#### A. Using Cloudflare Builds (Git integration)

Configure the following in the dashboard:

| Setting | Value |
|---------|-------|
| **Deploy command** | `npm run deploy` |
| **Build variables** | `D1_DATABASE_ID`, `OAUTH_KV_ID` |

Pushing to the `main` branch triggers automatic deployment.

#### B. Manual deployment

Set environment variables, then run:

```bash
# macOS/Linux
export D1_DATABASE_ID="your-d1-database-id"
export OAUTH_KV_ID="your-oauth-kv-id"
npm run deploy

# Windows PowerShell
$env:D1_DATABASE_ID="your-d1-database-id"
$env:OAUTH_KV_ID="your-oauth-kv-id"
npm run deploy
```

`npm run deploy` runs `scripts/make-wrangler-toml.js`, which generates `wrangler.toml` from environment variables before deploying. The local `wrangler.toml` remains with placeholders.

> **Note**: The generated `wrangler.toml` includes only D1/KV/R2/ASSETS. If you have custom `routes` or `vars` configured in the Cloudflare dashboard, they may be overwritten on deploy. If you use custom domains or additional `vars`, reconfigure them in the dashboard or fork `scripts/make-wrangler-toml.js` to extend it.

#### C. Using GitHub Actions

Create `.github/workflows/deploy.yml` and register the following in GitHub Secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `D1_DATABASE_ID`
- `OAUTH_KV_ID`
- Clerk-related Secrets as needed

See the official docs for detailed setup: [GitHub Actions · Cloudflare Workers](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

After deployment, access via the Workers URL (e.g. `https://context-mixer.<your-subdomain>.workers.dev`).

### 7. Connect from MCP clients

Register the `/mcp` endpoint of your deployment as the MCP server URL in each client.

Example — Claude Code:

```bash
claude mcp add context-mixer --transport http https://context-mixer.<your-subdomain>.workers.dev/mcp
```

## Local Development

```bash
npm run dev
```

The dev server starts at `http://localhost:8787`.

## API Endpoints

### System
- `GET /health` — Health check
- `GET /` — API info

### Auth
- `GET /auth/login` — Redirect to Clerk login

### Collections
- `GET /collections` — List collections (tree)
- `POST /collections` — Create collection
- `PATCH /collections/:id` — Update collection
- `DELETE /collections/:id` — Delete collection

### Documents
- `GET /docs` — List documents
- `GET /docs/:id?view=meta|outline|full` — Get document
- `POST /docs` — Create document
- `PATCH /docs/:id` — Update document
- `DELETE /docs/:id` — Delete document
- `POST /docs/:id/append` — Append to end
- `GET /docs/:id/history` — Revision history

### Others
- `GET /search?q=` — Full-text search
- `POST /files` — File upload
- `POST /inbox/:token` — Post to Inbox
- `GET /entrypoint` — Workspace entrypoint
- `GET /me/entrypoint` — User's personal entrypoint
- `POST /mcp` — MCP JSON-RPC endpoint (OAuth auth)

See [docs/design-doc.md](./docs/design-doc.md) for details.

## Documentation

- [docs/USAGE.md](./docs/USAGE.md) — Usage guide (Web UI, API keys, MCP connection)
- [docs/design-doc.md](./docs/design-doc.md) — Detailed design
- [docs/MCP.md](./docs/MCP.md) — MCP implementation policy
- [docs/STATUS.md](./docs/STATUS.md) — Development progress and handoff

## License

MIT
