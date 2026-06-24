# マルチテナント化 実装プラン

> 2026-06-24 作成。ContextMixerをユーザーごとのデータ分離構造に変更する設計・工数見積もり。

## 背景

現状はClerkインスタンスにサインアップできる人なら誰でも全データにアクセスできる。マルチテナント化でユーザーごとにデータを分離する。

## 設計方針

`collections` に `owner_user_id` を持たせ、`documents`・`files`・`document_links`・`document_revisions`・`inbox_tokens`・`inbox_items` はすべて `collections` 経由でオーナーを判定。`api_keys` にも `owner_user_id` を持たせる。

## スキーマ変更

### 追加カラム

| テーブル | 追加カラム | 備考 |
|----------|-----------|------|
| `collections` | `owner_user_id TEXT NOT NULL REFERENCES users(id)` | ルートコレクションの所有者 |
| `api_keys` | `owner_user_id TEXT NOT NULL REFERENCES users(id)` | 各ユーザーが自分のキーのみ管理 |
| `inbox_tokens` | `owner_user_id TEXT NOT NULL REFERENCES users(id)` | 各ユーザーが自分のinboxのみ管理 |

`documents`・`files`・`document_links`・`document_revisions`・`inbox_items` は直接カラム追加不要。`collections` 経由でオーナーを判定する。

### マイグレーション

```sql
-- migrations/0002_multi_tenant.sql
ALTER TABLE collections ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE api_keys ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE inbox_tokens ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT '';

-- バックフィル: 現在のユーザー（自分）のClerk IDを設定
-- 実行前に SELECT id FROM users でClerk IDを確認すること
UPDATE collections SET owner_user_id = '<自分のClerk ID>' WHERE owner_user_id = '';
UPDATE api_keys SET owner_user_id = '<自分のClerk ID>' WHERE owner_user_id = '';
UPDATE inbox_tokens SET owner_user_id = '<自分のClerk ID>' WHERE owner_user_id = '';

CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_inbox_tokens_owner ON inbox_tokens(owner_user_id);
```

## 認証コンテキスト変更

### `src/auth/adapter.ts`

- `HumanAuth` は既に `userId` を持つ → そのまま `ownerUserId` として使用
- `AiAuth` に `ownerUserId: string` を追加
- `isCollectionAllowed` に「オーナー判定」を追加: human は `collection.owner_user_id === auth.userId`、ai は `=== auth.ownerUserId`

### `src/auth/apikey.ts`

- `verifyApiKey` の SELECT に `owner_user_id` を追加
- `AiAuth` に `ownerUserId` をセット

### `src/mcp/handler.ts`

- `McpProps` に `userId` は既にある → `AiAuth.ownerUserId = props.userId` にマッピング

### `src/mcp/oauth-handler.ts`

- consent画面のコレクション一覧クエリ（99行目）に `WHERE owner_user_id = ?` を追加
- コレクション検証クエリ（195行目）に `WHERE owner_user_id = ?` を追加
- `completeAuthorization` の `props` に `userId` は既に含まれる

## クエリ変更（最大の工数）

### クエリパターン分類

#### パターンA: `collections` 直接参照（`WHERE owner_user_id = ?` 追加）

| ファイル | 行 | 箇所数 |
|----------|-----|--------|
| `routes/collections.ts` | 41,69,89,101,146,172,196,229,262 | 9 |
| `routes/entrypoint.ts` | 21,31,95,109 | 4 |
| `routes/api-keys.ts` | 37,195 | 2（`findInvalidCollectionIds`） |
| `mcp/oauth-handler.ts` | 99,195 | 2 |
| `mcp/tools.ts` | 158,218,274,280,329 | 5 |
| `routes/ui.ts` | 59,187,259,668,687,707,725 | 7 |
| **小計** | | **29** |

#### パターンB: `documents` 直接参照（`JOIN collections` または サブクエリ追加）

| ファイル | 行 | 箇所数 |
|----------|-----|--------|
| `routes/documents.ts` | 74,90,108,331,381,452,481,532,557,572,573,596,618 | 13 |
| `routes/ui.ts` | 60,189,261,310,318,322,369,371,375,410,445,451,486,500,534,554,574,579,580,592,628 | 21 |
| `mcp/tools.ts` | 72,85,109,138,150,158,166,185,196,212,221,246,274,276,282,297,305,306 | 18 |
| `routes/entrypoint.ts` | 57,67,103,117 | 4 |
| `routes/search.ts` | 52,65 | 2 |
| `routes/inbox.ts` | 38,76,84,101,125,163,180,215,231,245,287 | 11 |
| `routes/files.ts` | 40,71,131,145,152,162 | 6 |
| `routes/me.ts` | 18 | 1 |
| `services/links.ts` | 60 | 1 |
| **小計** | | **77** |

#### パターンC: `api_keys` 直接参照（`WHERE owner_user_id = ?` 追加）

| ファイル | 行 | 箇所数 |
|----------|-----|--------|
| `routes/api-keys.ts` | 52,89,125,140,177,226,243,253 | 8 |
| `auth/apikey.ts` | 48 | 1 |
| **小計** | | **9** |

#### パターンD: `inbox_tokens` 直接参照

| ファイル | 行 | 箇所数 |
|----------|-----|--------|
| `routes/inbox.ts` | 52,57,76,84,101,124 | 6 |
| **小計** | | **6** |

### 合計: 121箇所（重複カウント含む）

## ヘルパー関数化で工数削減

各パターンのクエリをヘルパー関数にまとめることで、実質的な編集箇所を約80箇所に圧縮。

```typescript
// src/services/queries.ts（新規）
export const userCollectionsWhere = (userId: string) =>
  `owner_user_id = ?` // プレースホルダ版

export const userDocsSubquery = (userId: string) =>
  `collection_id IN (SELECT id FROM collections WHERE owner_user_id = ?)`
```

各ルートの変更は「クエリに `AND ${userDocsSubquery()}` を追加 + `params.push(auth.ownerUserId)`」の2行追加で済む。

### `loadDoc` ヘルパーの修正が特に効果的

`documents.ts` の `loadDoc` は複数ファイルで使われる共通ヘルパー。ここにオーナーチェックを入れれば `documents` 直接参照の13箇所は一括で対応可能。

## Clerk・Cloudflare設定変更

### Clerk（変更なし）

- マルチテナント化すれば、サインアップを許可したまま各ユーザーのデータが分離される
- 現状のClerk設定のまま運用可能。追加設定不要

### Cloudflare（変更なし）

- `wrangler.toml`: 変更不要（D1・R2・KVは既存のまま）
- D1のマイグレーション実行のみ（`npm run d1:migrate-local` + 本番は `wrangler d1 migrations apply`）
- R2: ファイルは `documents` 経由でオーナー判定されるため、R2キーの変更不要
- KV（OAUTH_KV）: OAuth grantに `userId` は既に含まれるため変更不要

## リスクと注意点

1. **既存データのバックフィル**: 自分のClerk IDを間違えると全データが見えなくなる。マイグレーション前に `SELECT id FROM users` でClerk IDを確認必須
2. **FTS5検索**: `documents_fts` は `documents` とrowidで JOIN済み。ユーザーフィルタは `JOIN documents d` の後に `JOIN collections c ON d.collection_id = c.id WHERE c.owner_user_id = ?` を追加すれば良い
3. **`isCollectionAllowed` の二重チェック**: 現在の `allowedCollections` チェックに加えて `owner_user_id` チェックが必要。AIキーが「コレクション制限なし」でも他ユーザーのコレクションにはアクセスできないようにする
4. **`loadDoc` ヘルパー**: `documents.ts` の `loadDoc` は複数ファイルで使われる共通ヘルパー。ここにオーナーチェックを入れれば `documents` 直接参照の13箇所は一括で対応可能

## 実装フェーズ

### Phase 1: スキーマ + 認証コンテキスト + マイグレーション（1.25日）

1. `migrations/0002_multi_tenant.sql` 作成
2. `src/db/schema.sql` に `owner_user_id` カラムを追加
3. `src/auth/adapter.ts` に `AiAuth.ownerUserId` を追加
4. `src/auth/apikey.ts` の `verifyApiKey` に `owner_user_id` を追加
5. `src/mcp/handler.ts` で `AiAuth.ownerUserId = props.userId` を設定
6. `src/mcp/oauth-handler.ts` のコレクション一覧クエリにユーザーフィルタを追加
7. ローカルでマイグレーション実行 + 型チェック

### Phase 2: ヘルパー関数 + 共通チェック修正（0.5日）

1. `src/services/queries.ts` 新規作成
2. `src/auth/adapter.ts` の `isCollectionAllowed` にオーナー判定を追加
3. `src/routes/documents.ts` の `loadDoc` にオーナーチェックを追加

### Phase 3: 各ルートのクエリにユーザーフィルタ追加（2日）

1. `routes/collections.ts`（9箇所）
2. `routes/documents.ts`（残り・loadDoc以外）
3. `routes/ui.ts`（21箇所）
4. `mcp/tools.ts`（18箇所）
5. `routes/entrypoint.ts`（4箇所）
6. `routes/search.ts`（2箇所）
7. `routes/inbox.ts`（11箇所）
8. `routes/files.ts`（6箇所）
9. `routes/api-keys.ts`（8箇所）
10. `routes/me.ts`（1箇所）
11. `services/links.ts`（1箇所）

### Phase 4: テスト・検証（1日）

1. 型チェック（`npm run type-check`）
2. ローカルで2ユーザーでの分離テスト
3. MCP OAuth経路のユーザー分離テスト
4. APIキー経路のユーザー分離テスト
5. 既存データの移行確認（自分のデータが見えるか）

## 工数まとめ

| 工程 | 工数 | 内容 |
|------|------|------|
| Phase 1: スキーマ + 認証 | 1.25日 | 3テーブルに `owner_user_id` 追加 + マイグレーション + 認証コンテキスト |
| Phase 2: ヘルパー + 共通チェック | 0.5日 | `queries.ts` 新規 + `isCollectionAllowed`・`loadDoc` 修正 |
| Phase 3: クエリ変更 | 2日 | 約80箇所（ヘルパー関数化後）にユーザーフィルタ追加 |
| Phase 4: テスト・検証 | 1日 | 型チェック・2ユーザーテスト・3経路テスト |
| **合計** | **約4.75日** | |

段階的に進めることで、途中で型チェックを通しながら進められる。Phase 1完了時点で「自分のデータしか見えない」状態になり、残りは他ユーザーのデータが見えないようにする追加チェック。
