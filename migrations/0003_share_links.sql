-- 共有リンク機能マイグレーション
-- ドキュメント単位の予測困難な共有URLを発行する
-- 1ドキュメントにつき有効なリンクは1つ（トグル式）

CREATE TABLE IF NOT EXISTS share_links (
  id            TEXT PRIMARY KEY,      -- share_xxxxx (予測困難なランダム文字列)
  doc_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  UNIQUE(doc_id)  -- 1ドキュメントにつき1つの有効なリンク
);

CREATE INDEX IF NOT EXISTS idx_share_links_doc ON share_links(doc_id);
CREATE INDEX IF NOT EXISTS idx_share_links_owner ON share_links(owner_user_id);
