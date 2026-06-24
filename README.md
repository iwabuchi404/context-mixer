# Context Mixer

AIと人間が共同管理する、AIファーストのナレッジベース。Notion代替。

AIが自分で必要な情報を探しに行き、読み、書き込める場所。プロンプトにコンテキストを手動で貼る作業がなくなる。

## 何ができるか

- **ドキュメントの粒度取得** — AIは「タイトルと概要だけ」「見出し構造だけ」「特定セクションだけ」「全文」を選んで取得できる。トークン消費を最小限に抑えられる
- **MCP対応** — Claude.ai・Claude Code・ChatGPT等のMCPクライアントからOAuth認証で直接ドキュメントを検索・取得・書き込みできる。9つのツールを提供
- **REST API** — APIキー認証でAI・外部サービスからアクセス可能。スコープ（read/write）とコレクション単位のアクセス制限を設定できる
- **Web UI** — 人間がブラウザから読み書きするためのUI。HTMXで軽量・サーバーサイドレンダリング
- **全文検索** — D1のFTS5（trigram）による高速検索。ハイフン入り語にも対応
- **ドキュメントリンク** — `[[doc_xxx]]` 記法でドキュメント間リンク。backlinksも自動生成
- **リビジョン履歴** — 全書き込みに署名付きリビジョンを記録。誰が（人間/AI/OAuth）何を変更したか追跡可能
- **ファイル添付** — R2に画像等をアップロード、ドキュメントに埋め込み
- **Inbox** — 外部からの投稿を承認フロー経由で取り込み

## 設計思想

Notionは人間が使いやすいことを優先している。ContextMixerは**AIが探索しやすいこと**を優先している。

- ドキュメント取得の粒度を分ける（`meta` / `outline` / `full` / `section`）ことで、AIは必要な分だけ読める
- MCP経由でAIが直接アクセス。プロンプトへの手動コピペが不要
- 書き込みには必ず署名付きリビジョンを作成。AIの書き込みも人間の書き込みも同等に記録
- Cloudflare Workers + D1 + R2でランニングコストほぼゼロ（個人利用の範囲で無料枠内）

## スタック

| 要素 | 選択 | 理由 |
|------|------|------|
| Runtime | Hono on Cloudflare Workers | エッジで動く・無料枠が大きい |
| DB | D1 (SQLite互換) | Workers統合・FTS5全文検索が使える |
| Storage | R2 | 転送無料・画像保存 |
| Frontend | HTMX + Workers Assets | ビルドステップ不要・サーバーサイドレンダリング |
| 認証 | Clerk + APIキー + OAuth 2.1 | 人間・AI・MCPクライアントの3系統 |
| MCP | workers-oauth-provider | Cloudflare公式・Streamable HTTP |

## 対応クライアント

### MCP接続（OAuth 2.1）

| クライアント | 接続方法 |
|--------------|----------|
| Claude.ai | 設定 → Connectors → Custom Connector → URL入力 |
| Claude Code | `claude mcp add` でリモートMCPサーバーとして登録 |
| ChatGPT | Settings → Connectors → Add connector（ベータ） |
| MCP Inspector | `npx @modelcontextprotocol/inspector` でデバッグ |

MCPサーバーURL: `https://context-mixer.flog404.work/mcp`

### REST API（APIキー認証）

APIキーはWeb UIの「API Keys」ページから発行。スコープ（read/write）とアクセス可能なコレクションを指定可能。

```
Authorization: Bearer kb_xxxxxxxx
```

## MCPツール一覧

| ツール | 説明 | スコープ |
|--------|------|----------|
| `search_docs` | キーワード全文検索。スニペット付き | read |
| `get_doc` | ドキュメント取得（meta/outline/full/section） | read |
| `list_collections` | コレクション一覧（ツリー構造） | read |
| `list_docs` | コレクション内のドキュメント一覧（軽量・本文なし） | read |
| `get_entrypoint` | エントリーポイントドキュメント取得 | read |
| `write_doc` | ドキュメント作成・更新 | write |
| `append_doc` | ドキュメント末尾に追記 | write |
| `delete_doc` | ドキュメント削除 | write |
| `create_collection` | コレクション作成 | write |

詳細な使い方は [docs/USAGE.md](./docs/USAGE.md) を参照。

## セットアップ

### 前提

- Node.js 18+
- Wrangler CLI
- Clerkアカウント（認証用）

### インストール

```bash
npm install
```

### Cloudflare リソース作成

1. ログイン:
```bash
npx wrangler login
```

2. D1データベース作成:
```bash
npm run d1:create
```
`wrangler.toml` の `database_id` を更新。

3. R2バケット作成:
```bash
npm run r2:create
```

4. KV名前空間作成（MCP OAuth用）:
```bash
npx wrangler kv namespace create OAUTH_KV
```
`wrangler.toml` の `OAUTH_KV` の `id` を更新。

5. ローカルマイグレーション:
```bash
npm run d1:migrate-local
```

6. シークレット設定:

ローカル開発用 `.dev.vars`:
```ini
CLERK_SECRET_KEY=sk_test_xxxx
CLERK_PUBLISHABLE_KEY=pk_test_xxxx
CLERK_FRONTEND_API=https://your-clerk-app.clerk.accounts.dev
CLERK_SIGN_IN_URL=https://your-clerk-app.clerk.accounts.dev/sign-in
```

本番用:
```bash
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_PUBLISHABLE_KEY
npx wrangler secret put CLERK_FRONTEND_API
npx wrangler secret put CLERK_SIGN_IN_URL
```

> **注意**: Clerkの値は `wrangler.toml` の `[vars]` に書かないこと。デプロイのたびに本番ダッシュボードのSecretを上書きしてしまいます。

### 開発

```bash
npm run dev
```

### デプロイ

```bash
npm run deploy
```

## API エンドポイント

### システム
- `GET /health` — ヘルスチェック
- `GET /` — API情報

### 認証
- `GET /auth/login` — Clerkログインへリダイレクト

### コレクション
- `GET /collections` — コレクション一覧（ツリー）
- `POST /collections` — コレクション作成
- `PATCH /collections/:id` — コレクション更新
- `DELETE /collections/:id` — コレクション削除

### ドキュメント
- `GET /docs` — ドキュメント一覧
- `GET /docs/:id?view=meta|outline|full` — ドキュメント取得
- `POST /docs` — ドキュメント作成
- `PATCH /docs/:id` — ドキュメント更新
- `DELETE /docs/:id` — ドキュメント削除
- `POST /docs/:id/append` — 末尾追記
- `GET /docs/:id/history` — リビジョン履歴

### その他
- `GET /search?q=` — 全文検索
- `POST /files` — ファイルアップロード
- `POST /inbox/:token` — Inboxへ投稿
- `GET /entrypoint` — ワークスペースエントリーポイント
- `GET /me/entrypoint` — ユーザー個人エントリーポイント
- `POST /mcp` — MCP JSON-RPCエンドポイント（OAuth認証）

詳細は [docs/design-doc.md](./docs/design-doc.md) を参照。

## ドキュメント

- [docs/USAGE.md](./docs/USAGE.md) — 使い方ガイド（Web UI・APIキー・MCP接続）
- [docs/design-doc.md](./docs/design-doc.md) — 詳細設計
- [docs/MCP.md](./docs/MCP.md) — MCP実装方針
- [docs/STATUS.md](./docs/STATUS.md) — 開発進捗・引き継ぎ

## ライセンス

MIT
