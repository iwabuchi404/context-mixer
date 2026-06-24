-- マルチテナント化マイグレーション
-- 既存DBに owner_user_id カラムを追加し、既存レコードをバックフィルする
-- 実行前に SELECT id FROM users で自分のClerk IDを確認し、下の :OWNER_USER_ID を置き換えること

-- 1. カラム追加（DEFAULT '' でNOT NULL制約を満たす）
ALTER TABLE collections ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE api_keys ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE inbox_tokens ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT '';

-- 2. バックフィル: 既存レコードに現在のユーザーのClerk IDを設定
--    ※ :OWNER_USER_ID を自分のClerk user IDに置き換えてから実行すること
--    例: UPDATE collections SET owner_user_id = 'user_abc123' WHERE owner_user_id = '';
UPDATE collections SET owner_user_id = :OWNER_USER_ID WHERE owner_user_id = '';
UPDATE api_keys SET owner_user_id = :OWNER_USER_ID WHERE owner_user_id = '';
UPDATE inbox_tokens SET owner_user_id = :OWNER_USER_ID WHERE owner_user_id = '';

-- 3. インデックス追加
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_inbox_tokens_owner ON inbox_tokens(owner_user_id);
