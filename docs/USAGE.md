# Context Mixer Usage Guide

> **English** | [日本語](./USAGE.ja.md)

A purpose-oriented guide to using Context Mixer.

- [Web UI (for humans)](#web-ui-for-humans)
- [API Keys (for AI / external services)](#api-keys-for-ai--external-services)
- [MCP Connection (Claude.ai, ChatGPT, etc.)](#mcp-connection-claudeai-chatgpt-etc)
- [Document Link Syntax](#document-link-syntax)
- [Troubleshooting](#troubleshooting)

---

## Web UI (for humans)

Open your deployment URL in a browser. Log in with your Clerk account.

### Browsing Collections and Documents

- The collection tree appears on the left, document content on the right
- Both collections and documents can be expanded/collapsed via the ▾ toggle
- On initial load, collections are collapsed. The parent collection of the currently open document expands automatically
- Opening a document changes the URL to `/ui/doc/<id>`, which can be shared directly

### Editing Documents

- Click the "Edit" button in the top-right of a document to enter edit mode
- Write content in Markdown
- Saving automatically creates a revision (diffs visible on the history page)
- A copy button lets you copy the Markdown source to the clipboard
- Hovering over code blocks reveals a copy button

### Collection Operations

- Add, rename, and delete collections on the collection list page (`/ui/collections`)
- Collections can be nested (a collection can have a parent)
- Each collection can have an entrypoint document set (shown via `/entrypoint`)

### Search

- Type keywords into the search bar. Full-text search powered by FTS5
- Queries shorter than 3 characters fall back to LIKE search
- Hyphenated terms (e.g. `context-mixer`) can be searched as-is

### File Attachments

- Upload images etc. while editing a document
- Files are stored in R2 and can be embedded in Markdown

### Inbox

- A mechanism to receive submissions from external systems
- Issue an Inbox token, then POST to that token
- Submissions go through an approval flow before being ingested as documents

---

## API Keys (for AI / external services)

Issue API keys to access the REST API.

### Creating an API Key

1. Log in to the Web UI
2. Open the "API Keys" page (`/ui/keys`)
3. Click "Create new"
4. Configure the following:
   - **Name**: A descriptive name for the key's purpose (e.g. `claude-code-read`)
   - **Scope**: `read` or `read/write`
   - **Accessible collections**: All collections or specific ones only
5. A key in the format `kb_xxxxxxxxxxxx...` is displayed. **It is only shown once — make sure to copy and save it**

### Using an API Key

Specify it in the `Authorization: Bearer` request header:

```bash
curl https://your-instance.example.com/docs \
  -H "Authorization: Bearer kb_xxxxxxxx"
```

### Scopes and Collection Restrictions

| Setting | Behavior |
|---------|----------|
| `read` scope | Can only access GET endpoints |
| `read/write` scope | Can access all endpoints |
| No collection restriction | Can access documents in all collections |
| Collection restriction | Can only access documents under the specified collections |

### Managing API Keys

- API key hashes are stored with SHA-256 (never stored in plaintext)
- Revoke unneeded keys via the "Revoke" button
- Revoked keys cannot be restored

### Document Retrieval Granularity

AI can choose retrieval granularity to save tokens:

| view | Content | Token Cost |
|------|---------|------------|
| `meta` | Title + summary only | Minimal |
| `outline` | Heading structure (h1-h6) | Small |
| `full` | Full text | Large |
| `section` | Specific section only | Medium |

```
GET /docs/doc_123?view=meta
GET /docs/doc_123?view=outline
GET /docs/doc_123?view=full
GET /docs/doc_123?view=section&section=intro
```

Typical AI flow:
1. `search_docs` for keyword search → get titles and snippets
2. `get_doc?view=meta` to judge relevance
3. If needed, `get_doc?view=outline` to grasp structure
4. Fetch only the needed section via `get_doc?view=section`

---

## MCP Connection (Claude.ai, ChatGPT, etc.)

Access Context Mixer directly from AI chat clients via MCP (Model Context Protocol). Uses OAuth 2.1 authentication.

### Claude.ai

1. Open Claude.ai settings
2. **Connectors** → **Add custom connector**
3. Enter the MCP server URL: `https://your-instance.example.com/mcp`
4. The OAuth authorization flow opens in the browser:
   - Clerk login (if not logged in)
   - On the permissions screen, select **read** or **read/write**
   - Select which collections to access (or "All")
   - Click "Allow"
5. Return to Claude.ai — the connector is now active
6. In chat, ask things like "search Context Mixer documents" and the AI will call MCP tools

### Claude Code

Register the MCP server from the CLI:

```bash
claude mcp add context-mixer --transport http https://your-instance.example.com/mcp
```

The OAuth authorization flow opens in the browser on first call.

### ChatGPT

1. Settings → Connectors → Add connector (beta feature)
2. Enter the MCP server URL: `https://your-instance.example.com/mcp`
3. Authenticate via the OAuth authorization flow

### MCP Inspector (for debugging)

To directly test MCP tool behavior:

```bash
npx @modelcontextprotocol/inspector
```

Enter the MCP server URL in the Inspector, authenticate via OAuth, then manually call tools.

### MCP Tools

#### Read (read scope)

| Tool | Arguments | Description |
|------|-----------|-------------|
| `search_docs` | `q` (required), `scope?`, `limit?` | Keyword full-text search. Returns results with snippets |
| `get_doc` | `id` (required), `view?` | Get document. `view` is `meta`/`outline`/`full` (default: full) |
| `list_collections` | none | Returns collection list as a tree structure |
| `list_docs` | `collection_id` (required), `parent_id?` | Lists documents in a collection. Lightweight, no body. `parent_id="root"` for top-level only |
| `get_entrypoint` | `collection_id?` | Get entrypoint document |

#### Write (write scope)

| Tool | Arguments | Description |
|------|-----------|-------------|
| `write_doc` | `title`, `content`, `collection_id` (required), `id?`, `parent_id?` | Create or update document. Omit `id` to create new. Use `parent_id` to create a child document |
| `append_doc` | `id`, `content` (required) | Append content to the end of a document |
| `delete_doc` | `id` (required) | Delete a document. Child documents' `parent_id` becomes NULL |
| `create_collection` | `name` (required), `description?`, `parent_id?` | Create a collection. Use `parent_id` to nest |

### How Permissions Work

- Tool availability is determined by the scope (read or read/write) selected during OAuth authorization
- Calling a write tool with a read scope returns an error (`-32003`)
- If collection restrictions are set, only documents under those collections are accessible
- Every write creates a signed revision. OAuth writes are recorded with `author_type='ai'`, `keyName='oauth:email'`

---

## Document Link Syntax

You can link documents to each other.

### Syntax

Writing `[[doc_xxx]]` in the body converts it into a link to that document.

```markdown
See [[doc_abc123]] for the design policy.
```

### Backlinks

The linked document automatically displays who links to it (backlinks). Links are automatically synced when a document is saved.

---

## Troubleshooting

### MCP connection authentication errors

- Verify you can log in with your Clerk account
- Check that you selected the correct permissions on the OAuth authorization screen
- If the token has expired, remove the connector and reconnect

### Search returns zero results

- Queries shorter than 3 characters fall back to LIKE search, which only matches near-exact matches
- If the FTS5 migration hasn't been applied, it falls back to LIKE search
- If collection restrictions are set, check that documents exist under those collections

### 401 with API key

- Check that the key hasn't been revoked
- Verify the format is `Authorization: Bearer kb_xxx` (space between `Bearer` and `kb_`)
- Verify you're hitting the right endpoint for the key's scope (read keys cannot POST)

### Writes not reflected

- Check that you pressed the save button after editing in the Web UI
- MCP writes are recorded as revisions. Check the history page to see changes
- If collection restrictions are set, verify you have write access to that collection (read scope cannot write)

### Search errors with hyphenated terms

- Context Mixer wraps search terms in phrase quotes before passing to FTS5, so hyphenated terms like `context-mixer` can be searched as-is
- If you get errors, the FTS5 index migration may not be applied
