## 2026-06-23 現行実装確認（2026-06-21 追補を訂正）

前回の 2026-06-21 追補は「MCP は APIキー認証・6ツール・type-check 落ちる・`docs/STATUS.md` なし」と記載していたが、実装を再確認した結果**該当部分は全て誤り**だった。OAuth 実装は現存し、type-check も通過する。下の既存本文にも古い状態（Vue MPA 等）が残っているため、現時点の判断ではこの追補を優先する。

### 現在地

- 実装済み: D1スキーマ、コレクション/ドキュメントCRUD、セクションAPI、append、履歴API、ドキュメントリンク、FTS5検索、Clerkセッション認証、APIキー認証、APIキー管理、`/me/entrypoint`、ワークスペース `/entrypoint`、files/R2、inbox承認フロー、HTMXベースWeb UI、MCP（OAuth 2.1・9ツール）。
- 未実装: `GET /collections/:id/export` は `501 NOT_IMPLEMENTED` を返す。
- 検索修正: FTS5 の `MATCH` に渡す検索語は空白区切りで phrase quote する。`context-mixer` のようなハイフン入り語を FTS 構文として誤解釈しないため。
- フロントエンド実態: README/古いspecの「Vue MPA」ではなく、`public/index.html` + `public/app.js` + `/ui/*` fragments による HTMX 構成。
- MCP実態: `src/index.ts` の `export default new OAuthProvider({...})` が `/mcp` を `McpApiHandler` へ流す。認証は OAuth 2.1（`@cloudflare/workers-oauth-provider` + Clerk）。ツールは9個: `search_docs`, `get_doc`, `write_doc`, `append_doc`, `list_collections`, `list_docs`, `get_entrypoint`, `delete_doc`, `create_collection`。
- `npm run type-check` は**通過**（`src/mcp/tools.ts` の型はローカル最小型で解決済み）。
- `docs/STATUS.md` は**存在**する。

### ドキュメント上の古い記述

- 直下の「現在地」には `files(R2)`, `inbox`, `GET /entrypoint`, `MCP server` が未実装とあるが、実装済み。
- スタック表の Frontend 行「Vue MPA」は古い。現行は HTMX + Workers Assets。
- スタック表の認証行に APIキー・OAuth が載っていない（現行は Clerk + APIキー + OAuth の3系統）。
- APIキーのハッシュは bcrypt ではなく SHA-256（`src/auth/apikey.ts`。キーは高エントロピーなので SHA-256 で十分、bcrypt は Workers 無料枠で重い）。

---

## 現在地

実装フェーズ1〜2の途中（2026-06-12時点）。

- 実装済み: スキーマ、ドキュメント/コレクションCRUD、FTS5検索、認証（Clerkセッション + APIキー二系統、スコープ/コレクション制限、書き込み署名）、APIキー管理API、/me/entrypoint、セクション単位API（GET/PATCH、slugは見出しテキスト由来・日本語可・コードフェンス内見出しは無視）、append、履歴API（/history・/history/:rev）
- 実装済み（追加）: ドキュメントリンク（`[[doc_xxx]]` 記法、書き込み時洗い替え、/links・/backlinks、link_warnings）
- 実装済み（追加）: 認証ルート（/auth/login・callback・logout）、Web UI最小構成（Workers Assetsで`public/`配信、Vue 3 CDN + clerk-js。index=コレクション/ドキュメント一覧/検索、doc=編集/プレビュー/リンク/履歴、keys=APIキー発行/失効）
- 未実装: files(R2)、inbox、エクスポート、GET /entrypoint（ワークスペース全体）、MCP server
- 注記: ローカルD1はwrangler.tomlのdatabase_id追加で識別キーが変わり再マイグレーション済み（旧DBファイルは残存するが未使用）
- 未検証: Clerkセッション認証の実トークンでの動作（APIキー系統はローカル検証済み）
- 注記: APIキーのハッシュはbcryptではなくSHA-256に変更（キーは高エントロピーなので十分。bcryptはWorkers無料枠のCPU制限に対して重い）
- ローカル開発の注意: リポジトリがSMB共有上にあるためwranglerのローカル状態（D1/SQLite）は `--persist-to %USERPROFILE%/.context-mixer/wrangler-state` でローカルディスクに保存する（npmスクリプト設定済み。共有上だとハングする）

---

## 概要

個人とAIが共同管理するナレッジベースサービス。Notionの代替として自作。AI書き込み8割・人間読み書き両方・モバイル対応を前提とした、AIアクセス効率を最優先した設計。

---

## スタック

| 要素 | 選択 | 理由 |
| --- | --- | --- |
| Runtime | Hono on Cloudflare Workers | 無料・軽量・エッジ |
| DB | D1（SQLite互換） | 無料・Workers統合 |
| Storage | R2 | 無料転送・画像保存 |
| Frontend | Vue MPA（同一サーバー） | 馴染みあり・単一サーバー完結 |
| 認証 | Clerk | 複数端末管理・APIキー管理・セッション失効 |

---

## ドキュメント構造

- ツリー構造（親子関係あり、フォルダ的）
- コレクション単位でグループ化
- バイナリ（画像等）はドキュメントに埋め込み、実体はR2に保存しURL参照
- CSV/JSONなど構造データはドキュメント内コードブロックに埋め込む

---

## API設計方針

**設計哲学：AIが探索しやすいAPI。検索精度より探索コストを下げる。**

### ドキュメント取得（粒度選択）

```
GET /docs/:id?view=meta        タイトル+概要+セクション一覧のみ
GET /docs/:id?view=outline     見出し構造のみ（目次）
GET /docs/:id?view=full        全文
GET /docs/:id/sections/:slug   特定セクションのみ
```

AIの典型的な探索フロー：

1. meta取得 → 必要か判断（数十トークン）
2. outline取得 → どのセクションか判断
3. sections/:slug → 必要な部分だけ取得

### 検索API

```
GET /search?q=キーワード&limit=5
→ ヒット箇所の前後3行のsnippetを返す

GET /search?q=キーワード&scope=collection:projects
→ コレクション絞り込み
```

レスポンスイメージ：

```json
[
  {
    "id": "doc_123",
    "title": "Elbow設計メモ",
    "snippet": "...コンテキスト圧縮の方針として...",
    "score": 0.92,
    "section": "設計方針"
  }
]
```

### 書き込みAPI

```
POST /docs                       新規作成
PUT  /docs/:id                   全文更新
PATCH /docs/:id/sections/:slug   セクション単位更新
POST /docs/:id/append            末尾追記
```

### 管理系

```
GET  /collections                コレクション一覧
GET  /docs?collection=x&cursor=  ページネーション付き一覧
GET  /docs/:id/history           変更履歴一覧
GET  /docs/:id/history/:rev      特定バージョン取得
POST /files                      バイナリアップロード（R2）
GET  /health                     死活監視
```

---

## アクセス制御

### 人間向け

- Clerk + Google OAuthによるセッション認証
- 複数端末のセッション管理・個別失効はClerkダッシュボードで操作
- Clerkへの依存はアダプターパターンで1ファイルに集約（移行コスト最小化）

### AI向け

- APIキー + スコープ（キーごとにread/write/collection指定）
- キーはD1にハッシュ化して保存（平文禁止）
- キーのローテーション機能を最初から実装

### 書き込み署名

全書き込みにrevisionテーブルへ以下を記録：

- `author_type`: `human` | `ai`
- `api_key_id`: 使用したAPIキーのID（キー名も）
- `timestamp`

信頼性判断・Prompt Injection調査・ロールバック判断に活用。

### エントリーポイント設計（A案＋B案の併用）

**A案：APIキーにエントリードキュメントを紐付け**

- キー作成時に `entry_doc_id` を任意指定
- `GET /me/entrypoint` → そのキーのエントリードキュメントを返す
- 信頼性の低いAIサービスへは限定的な入口だけ渡せる

**B案：エントリーポイント専用API**

```
GET /entrypoint                      ワークスペース全体のエントリー
GET /collections/:id/entrypoint      コレクション単位のエントリー
```

- Claude Code等の信頼できるエージェントが構造を自由に探索できる

**使い分け：**

- 信頼性微妙なサービス → A案でキーに入口を限定
- 信頼できるエージェント → B案で全体構造を探索

### セキュリティ上の特記事項

- **Prompt Injection対策**：AIがドキュメントを読んで行動するため、不正書き込みによるAI誤動作リスクあり
- 書き込み時にHTMLタグ・危険パターンをサニタイズ
- システム用読み取り専用コレクションを通常の書き込みコレクションから分離
- revisionテーブルで全書き込みを記録（不正検知・ロールバック用）

---

## 変更履歴

- D1のrevisionテーブルで管理
- gitは使わない
- セクション単位での差分保存も検討
- 各revisionに署名情報（author_type・api_key_id）を付与

---

## 全文検索

- D1 FTS5 + N-gram（日本語対応）
- フェーズ1：キーワード検索（snippet返却）
- フェーズ2（将来）：Cloudflare Vectorize追加（ベクトル検索）
- 検索精度の不足はAIの探索判断力で補う設計

---

## フロントエンド（Web UI）

- Vue MPA、Honoと同一サーバーで完結
- UXは最小限（読み書きできれば十分）
- エディタ：textarea + スニペット挿入ボタン
- タブ切り替えプレビュー（あれば、なくても可）
- モバイル対応必須

---

## コスト

| サービス | 無料枠 | 備考 |
| --- | --- | --- |
| CF Workers | 10万req/日 | APIサーバー |
| D1 | 5GB・500万read/月 | ドキュメントDB |
| R2 | 10GB・転送無料 | 画像保存 |
| CF Pages | 500build/月 | フロントエンド |
| Clerk | 1万MAU | 認証 |

**実質無料で運用可能**

---

## 実装コスト見積もり

| フェーズ | 内容 | 工数 |
| --- | --- | --- |
| 1 | APIコア（CRUD + 検索） | 1〜2日 |
| 2 | 認証（Clerk統合） | 半日 |
| 3 | Web UI（Vue最小限） | 1〜2日 |
| 4 | MCP server化 | 半日 |
| **合計** |  | **3〜5日** |

---

## 未決事項

- [ ]  プロジェクト名
- [ ]  フロントエンド最終決定（Vue MPA vs HTMX vs Svelte）
- [ ]  Elbowとの統合方針
- [ ]  エントリーポイントドキュメントの標準フォーマット定義

フェーズ2 アイデアメモ

---

## DBスキーマ（D1/SQLite）

### users

```sql
CREATE TABLE users (
  id          TEXT PRIMARY KEY,  -- Clerk user ID
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
```

### collections

```sql
CREATE TABLE collections (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  parent_id         TEXT REFERENCES collections(id),
  description       TEXT,
  is_system         INTEGER NOT NULL DEFAULT 0,
  entrypoint_doc_id TEXT REFERENCES documents(id),
  created_by_type   TEXT NOT NULL,  -- 'human' | 'ai'
  created_by_key_id TEXT REFERENCES api_keys(id),
  updated_by_type   TEXT NOT NULL,  -- 'human' | 'ai'
  updated_by_key_id TEXT REFERENCES api_keys(id),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
```

### documents

```sql
CREATE TABLE documents (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  content           TEXT NOT NULL,
  collection_id     TEXT NOT NULL REFERENCES collections(id),
  parent_id         TEXT REFERENCES documents(id),
  path              TEXT NOT NULL,
  -- 例: /col_abc/doc_001/doc_002
  -- LIKE検索で階層一括取得できる
  priority          TEXT NOT NULL DEFAULT 'normal',
  -- high / normal / archive
  status            TEXT NOT NULL DEFAULT 'published',
  -- published / archived
  created_by_type   TEXT NOT NULL,  -- 'human' | 'ai'
  created_by_key_id TEXT REFERENCES api_keys(id),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_documents_collection ON documents(collection_id);
CREATE INDEX idx_documents_parent     ON documents(parent_id);
CREATE INDEX idx_documents_path       ON documents(path);
CREATE INDEX idx_documents_updated    ON documents(updated_at DESC);
```

### document_revisions

最終更新者はrevisionから取得する（documentsテーブルには持たない）。

```sql
CREATE TABLE document_revisions (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  author_type   TEXT NOT NULL,  -- 'human' | 'ai'
  api_key_id    TEXT,
  api_key_name  TEXT,           -- キー削除後も追跡できるようスナップショット
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_revisions_document ON document_revisions(document_id, created_at DESC);
```

### api_keys

```sql
CREATE TABLE api_keys (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,  -- SHA-256ハッシュ（高エントロピーキーなのでbcrypt不要、Workers CPU制限対策）
  scopes          TEXT NOT NULL,         -- JSON: ["read","write"]
  collection_ids  TEXT,                  -- JSON: ["col_abc"], null=全許可
  entry_doc_id    TEXT REFERENCES documents(id),
  expires_at      INTEGER,
  last_used_at    INTEGER,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);
```

### files

```sql
CREATE TABLE files (
  id                TEXT PRIMARY KEY,
  document_id       TEXT REFERENCES documents(id),
  filename          TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  r2_key            TEXT NOT NULL UNIQUE,
  created_by_type   TEXT NOT NULL,
  api_key_id        TEXT REFERENCES api_keys(id),
  created_at        INTEGER NOT NULL
);
```

### inbox_tokens / inbox_items（承認フロー）

```sql
CREATE TABLE inbox_tokens (
  id          TEXT PRIMARY KEY,
  token       TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL REFERENCES documents(id),
  is_active   INTEGER NOT NULL DEFAULT 1,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE inbox_items (
  id              TEXT PRIMARY KEY,
  inbox_token_id  TEXT NOT NULL REFERENCES inbox_tokens(id),
  document_id     TEXT NOT NULL REFERENCES documents(id),
  content         TEXT NOT NULL,
  source_hint     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  -- pending / approved / rejected
  submitted_at    INTEGER NOT NULL,
  reviewed_at     INTEGER,
  ip_hash         TEXT
);

CREATE INDEX idx_inbox_items_status ON inbox_items(status, submitted_at DESC);
```

### FTS5（全文検索）

```sql
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title,
  content,
  content=documents,
  content_rowid=rowid,
  tokenize='trigram'
);

CREATE TRIGGER documents_fts_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER documents_fts_update AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO documents_fts(rowid, title, content)
  VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER documents_fts_delete AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
END;
```

### 設計上の判断メモ

- **pathカラム**: 再帰CTEより`LIKE`の方がD1で安定。移動時の一括更新も単純なUPDATEで済む
- **revisionにapi_key_nameをスナップショット**: キー削除・ローテーション後も追跡可能
- **inbox分離**: トークンの有効/無効を投稿履歴に影響なく切り替えられる
- **updated_byはrevisionから取得**: documentsテーブルには持たない

---

## 認証フロー

### 全体像

```
人間のアクセス        AIのアクセス
    │                     │
Clerk JWT            APIキー（Bearer）
    │                     │
    └──── auth middleware ────┘
              │
         context注入
    { user, keyId, scopes,
      allowedCollections }
```

### 人間向け：Clerkフロー

1. GET /login → Clerk Hosted UIにリダイレクト
2. Google OAuthで認証
3. Clerk → /auth/callback にJWT発行
4. middlewareでClerk SDKを使いJWT検証（Workers上で完結）
5. D1のusersテーブルに初回のみ自動登録
6. 以降はCookieのセッショントークンで認証

### AI向け：APIキーフロー

1. 人間がWeb UIからキーを発行（name/scopes/collection_ids/entry_doc_id指定）
2. 生キーを一度だけ表示（D1にはbcryptハッシュのみ保存）
3. AIはAuthorizationヘッダーで送信: `Bearer kb_xxxxxxxxxx`
4. middlewareでハッシュ照合 → scopeとcollection_idsをcontextに注入
5. last_used_atを更新（D1直接照合、KVキャッシュなし）

### アダプターパターン

Clerkへの依存を1ファイルに集約し、将来の差し替えコストを最小化。

```tsx
// src/auth/adapter.ts
export interface AuthAdapter {
  verifySessionToken(token: string): Promise<User | null>
  verifyApiKey(raw: string): Promise<ApiKeyContext | null>
}
```

### 認証不要エンドポイント（明示的に除外）

- POST /inbox/:token（承認フロー受付）
- GET /health

---

## ドキュメントリンク

### document_linksテーブル

```sql
CREATE TABLE document_links (
  id          TEXT PRIMARY KEY,
  from_doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  to_doc_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  UNIQUE(from_doc_id, to_doc_id)
);

CREATE INDEX idx_links_from ON document_links(from_doc_id);
CREATE INDEX idx_links_to   ON document_links(to_doc_id);
```

### 記法

```
[[doc_xxx]]           ID参照
[[doc_xxx|表示名]]    ラベル付き
```

タイトルではなくIDで参照するためタイトル変更に強い。コードフェンス内の記法は無視される。

### 更新タイミング

ドキュメント書き込み時（POST/PUT/セクションPATCH/append）にMarkdownをパースしてリンクを抽出し同期更新（DELETE→INSERT洗い替え）。存在しないdoc_idへのリンクはレスポンスの `link_warnings` 配列で返す（書き込み自体は成功）。

### API

```
GET /docs/:id/links       リンク先一覧
GET /docs/:id/backlinks   被リンク一覧（AI活用に特に有用）
```

---

## APIエンドポイント詳細

### 認証・キー管理

```
GET    /auth/login                Clerk UIへリダイレクト
GET    /auth/callback             Clerk認証後のコールバック
POST   /auth/logout               セッション破棄

GET    /api-keys                  キー一覧（ハッシュは返さない）
POST   /api-keys                  キー発行（生キーを一度だけ返す）
PATCH  /api-keys/:id              name/scopes/collection_ids/entry_doc_id更新
DELETE /api-keys/:id              キー失効
GET    /me/entrypoint             このキーのエントリーポイント取得
```

### コレクション

```
GET    /collections               一覧（ツリー構造で返す）
POST   /collections               作成
PATCH  /collections/:id           更新
DELETE /collections/:id           削除（配下ドキュメントがある場合はエラー）
GET    /collections/:id/entrypoint  エントリーポイント取得
GET    /collections/:id/export?format=text&flatten=true  配下を全結合
```

### ドキュメント

```
GET  /docs
  ?collection=:id
  &parent=:id
  &priority=high
  &limit=20&cursor=
  → メタ情報のみ（contentは含まない）

GET  /docs/:id?view=meta        タイトル+概要+セクション一覧
GET  /docs/:id?view=outline     見出し構造のみ
GET  /docs/:id?view=full        全文
GET  /docs/:id/sections/:slug   特定セクションのみ

POST   /docs                    新規作成
PUT    /docs/:id                全文更新
PATCH  /docs/:id/sections/:slug セクション単位更新
POST   /docs/:id/append         末尾追記
DELETE /docs/:id                削除（revisionは保持）

GET  /docs/:id/history          変更履歴一覧
GET  /docs/:id/history/:rev     特定バージョン取得
GET  /docs/:id/links            リンク先一覧
GET  /docs/:id/backlinks        被リンク一覧
```

### 検索

```
GET  /search
  ?q=キーワード
  &scope=collection:col_abc
  &priority=high
  &limit=10

→ レスポンス例
[{
  "id": "doc_123",
  "title": "Elbow設計メモ",
  "snippet": "...コンテキスト圧縮の方針として...",
  "score": 0.92,
  "section": "設計方針",
  "collection_id": "col_abc"
}]
```

### ファイル

```
POST   /files           アップロード（R2保存、メタはD1）
GET    /files/:id       メタ取得
GET    /files/:id/raw   ファイル本体取得
DELETE /files/:id       削除（R2とD1両方）
```

### 承認フロー（inbox）

```
POST   /inbox/:token          書き込みリクエスト送信（認証不要）
GET    /inbox                 pending一覧
POST   /inbox/:id/approve     承認 → documentsに反映
POST   /inbox/:id/reject      却下

POST   /inbox-tokens          受付URLトークン発行
PATCH  /inbox-tokens/:id      有効/無効切り替え
```

### システム

```
GET  /health          死活監視
GET  /entrypoint      ワークスペース全体のエントリーポイント
```

### レスポンス共通設計

エラー形式：

```json
{
  "error": {
    "code": "DOC_NOT_FOUND",
    "message": "Document not found"
  }
}
```

ページネーション：

```json
{
  "data": [...],
  "next_cursor": "doc_xyz",
  "has_more": true
}
```

---

## プロジェクト構成

```
/
├── src/
│   ├── index.ts              # エントリーポイント、ルート登録
│   ├── auth/
│   │   ├── adapter.ts        # AuthAdapterインターフェース
│   │   ├── clerk.ts          # Clerk実装
│   │   └── middleware.ts     # 認証middleware
│   │
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── collections.ts
│   │   ├── documents.ts
│   │   ├── search.ts
│   │   ├── files.ts
│   │   ├── inbox.ts
│   │   └── api-keys.ts
│   │
│   ├── services/             # ビジネスロジック
│   │   ├── documents.ts      # セクションパース・リンク抽出
│   │   ├── search.ts         # FTS5クエリ組み立て
│   │   ├── files.ts          # R2操作
│   │   └── inbox.ts          # 承認フロー
│   │
│   ├── db/
│   │   ├── schema.sql        # マイグレーション
│   │   └── queries/          # 型付きクエリ
│   │       ├── documents.ts
│   │       ├── collections.ts
│   │       └── ...
│   │
│   ├── ui/                   # Vue MPA
│   │   ├── pages/
│   │   │   ├── index.html
│   │   │   ├── doc.html
│   │   │   └── inbox.html
│   │   └── components/
│   │       ├── Editor.vue    # textarea + スニペット
│   │       └── Preview.vue   # Markdownプレビュー
│   │
│   └── mcp/
│       └── server.ts         # MCPサーバー定義
│
├── wrangler.toml
├── package.json
└── tsconfig.json
```

### wrangler.toml

```toml
name = "your-project-name"
main = "src/index.ts"
compatibility_date = "2026-01-01"

[[d1_databases]]
binding = "DB"
database_name = "kb-db"
database_id = "xxx"

[[r2_buckets]]
binding = "R2"
bucket_name = "kb-files"

[vars]
CLERK_PUBLISHABLE_KEY = "pk_xxx"

[secrets]
# CLERK_SECRET_KEY はwrangler secret putで設定
```

### 設計判断メモ

- **services層を挟む**: ビジネスロジックをroutesから分離しテスト可能にする。セクションパース・リンク抽出・FTS5クエリは複雑になりやすいので特に重要
- **mcp/server.tsを独立**: MCPは別インターフェースだが内部でservicesを呼ぶだけ。ロジックの重複なし
