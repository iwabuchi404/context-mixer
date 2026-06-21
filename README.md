# Context Mixer

AI-accessible knowledge base service.

## Description

A personal knowledge base service co-managed by humans and AI. Designed as a Notion alternative with AI-first optimization for efficient exploration and access.

## Current Status

As of 2026-06-21, the local implementation is past the initial skeleton stage.

- Implemented: D1 schema, collection/document CRUD, section API, append, history, document links, FTS search, Clerk session auth, API key auth, API key management, `/me/entrypoint`, workspace `/entrypoint`, files/R2, inbox approval flow, HTMX-based Web UI, and JSON-RPC MCP endpoint.
- Not implemented: collection export (`GET /collections/:id/export` currently returns `501`).
- Search fix note: FTS5 search terms are phrase-quoted before `MATCH` so symbols such as `-` are treated as text, not FTS syntax.
- Local development note: Wrangler state is persisted to `%USERPROFILE%/.context-mixer/wrangler-state` to avoid D1/SQLite issues on SMB/shared folders.

## Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| Runtime | Hono on Cloudflare Workers | Free, lightweight, edge |
| DB | D1 (SQLite-compatible) | Free, Workers integrated |
| Storage | R2 | Free transfer, image storage |
| Frontend | HTMX + static assets on Workers Assets | Small runtime, server-rendered fragments, same server |
| Auth | Clerk session + API keys | Human session auth and AI/REST API access |

## Setup

### Prerequisites

- Node.js 18+
- Wrangler CLI

### Installation

```bash
npm install
```

### Cloudflare Setup

1. Login to Cloudflare:
```bash
npx wrangler login
```

2. Create D1 database:
```bash
npm run d1:create
```
Update `database_id` in `wrangler.toml` with the returned ID.

3. Create R2 bucket:
```bash
npm run r2:create
```

4. Run migrations (local):
```bash
npm run d1:migrate-local
```

5. Set secrets:

For local development, create a `.dev.vars` file in the project root (loaded automatically by `wrangler dev`):

```ini
CLERK_SECRET_KEY=sk_test_xxxx
CLERK_PUBLISHABLE_KEY=pk_test_xxxx
```

For production:

```bash
npx wrangler secret put CLERK_SECRET_KEY
```

### Development

```bash
npm run dev
```

### Deployment

```bash
npm run deploy
```

## API Endpoints

### System
- `GET /health` - Health check
- `GET /` - API info

- `GET /auth/login` - Clerk auth redirect
- `GET /collections` - List collections
- `GET /docs` - List documents
- `GET /docs/:id?view=full` - Get document
- `GET /search?q=` - Search documents
- `POST /files` - Upload file
- `POST /inbox/:token` - Submit to inbox
- `GET /entrypoint` - Workspace entry point
- `POST /mcp` - JSON-RPC MCP endpoint using API key auth

See [docs/design-doc.md](./docs/design-doc.md) for full API specification.

## Documentation

See [docs/design-doc.md](./docs/design-doc.md) for detailed design documentation.

## License

MIT
