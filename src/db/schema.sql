-- Context Mixer Database Schema
-- D1 / SQLite

-- ============================================================
-- Users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,  -- Clerk user ID
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- ============================================================
-- Collections
-- ============================================================
CREATE TABLE IF NOT EXISTS collections (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  parent_id         TEXT REFERENCES collections(id) ON DELETE SET NULL,
  description       TEXT,
  is_system         INTEGER NOT NULL DEFAULT 0,
  entrypoint_doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  owner_user_id     TEXT NOT NULL REFERENCES users(id),  -- マルチテナント: コレクションの所有者
  created_by_type   TEXT NOT NULL,  -- 'human' | 'ai'
  created_by_key_id TEXT REFERENCES api_keys(id),
  updated_by_type   TEXT NOT NULL,  -- 'human' | 'ai'
  updated_by_key_id TEXT REFERENCES api_keys(id),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collections_parent ON collections(parent_id);
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_user_id);

-- ============================================================
-- Documents
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  content           TEXT NOT NULL,
  collection_id     TEXT NOT NULL REFERENCES collections(id),
  parent_id         TEXT REFERENCES documents(id) ON DELETE SET NULL,
  path              TEXT NOT NULL,
  -- Example: /col_abc/doc_001/doc_002
  -- LIKE search for hierarchical retrieval
  priority          TEXT NOT NULL DEFAULT 'normal',  -- high / normal / archive
  status            TEXT NOT NULL DEFAULT 'published',  -- published / archived
  created_by_type   TEXT NOT NULL,  -- 'human' | 'ai'
  created_by_key_id TEXT REFERENCES api_keys(id),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection_id);
CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_id);
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);

-- ============================================================
-- Document Revisions
-- ============================================================
CREATE TABLE IF NOT EXISTS document_revisions (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL,  -- no FK: revisions survive document deletion (audit/rollback)
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  author_type   TEXT NOT NULL,  -- 'human' | 'ai'
  api_key_id    TEXT,
  api_key_name  TEXT,           -- Snapshot for tracking after key deletion
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revisions_document ON document_revisions(document_id, created_at DESC);

-- ============================================================
-- API Keys
-- ============================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,  -- SHA-256 hex (keys are high-entropy; bcrypt too slow for Workers)
  scopes          TEXT NOT NULL,         -- JSON: ["read","write"]
  collection_ids  TEXT,                  -- JSON: ["col_abc"], null = all allowed
  entry_doc_id    TEXT REFERENCES documents(id),
  owner_user_id   TEXT NOT NULL REFERENCES users(id),  -- マルチテナント: キーの所有者
  expires_at      INTEGER,
  last_used_at    INTEGER,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner_user_id);

-- ============================================================
-- Files
-- ============================================================
CREATE TABLE IF NOT EXISTS files (
  id                TEXT PRIMARY KEY,
  document_id       TEXT REFERENCES documents(id) ON DELETE SET NULL,
  filename          TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  r2_key            TEXT NOT NULL UNIQUE,
  created_by_type   TEXT NOT NULL,
  api_key_id        TEXT REFERENCES api_keys(id),
  created_at        INTEGER NOT NULL
);

-- ============================================================
-- Inbox (Approval Flow)
-- ============================================================
CREATE TABLE IF NOT EXISTS inbox_tokens (
  id          TEXT PRIMARY KEY,
  token       TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),  -- マルチテナント: トークンの所有者
  is_active   INTEGER NOT NULL DEFAULT 1,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_tokens_owner ON inbox_tokens(owner_user_id);

CREATE TABLE IF NOT EXISTS inbox_items (
  id              TEXT PRIMARY KEY,
  inbox_token_id  TEXT NOT NULL REFERENCES inbox_tokens(id),
  document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  source_hint     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending / approved / rejected
  submitted_at    INTEGER NOT NULL,
  reviewed_at     INTEGER,
  ip_hash         TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbox_items_status ON inbox_items(status, submitted_at DESC);

-- ============================================================
-- Document Links
-- ============================================================
CREATE TABLE IF NOT EXISTS document_links (
  id          TEXT PRIMARY KEY,
  from_doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  to_doc_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  UNIQUE(from_doc_id, to_doc_id)
);

CREATE INDEX IF NOT EXISTS idx_links_from ON document_links(from_doc_id);
CREATE INDEX IF NOT EXISTS idx_links_to   ON document_links(to_doc_id);

-- ============================================================
-- Full-Text Search (FTS5)
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title,
  content,
  content=documents,
  content_rowid=rowid,
  tokenize='trigram'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS documents_fts_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_update AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO documents_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_delete AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
END;
