-- Phase A: 書き込み信頼性 — idempotency / version / revision retention
-- Apply to production D1 before deploying the code.

-- 1. 楽観的ロック用 version カラム
ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- 2. リビジョン冪等判定用 content_hash
-- 既存 revision はハッシュが計算できないため 'legacy' マーカーを入れておく。
-- 次回書き込み時に最新 revision と比較して、新しい content_hash で revision が作成される。
ALTER TABLE document_revisions ADD COLUMN content_hash TEXT NOT NULL DEFAULT 'legacy';
