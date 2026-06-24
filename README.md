# Context Mixer

AIと人間が共同管理する、AIファーストのナレッジベース。

AIが自分で必要な情報を探しに行き、読み、書き込める場所。プロンプトにコンテキストを手動で貼る作業がなくなります。

## なぜ作ったのか

個人開発のプロジェクトが20を超えたあたりで、Notionに溜めたドキュメントをAIツールから使うのがしんどくなりました。

少しの追記にもレイテンシがかかり、何度も読み書きしているとトークン消費も馬鹿になりません。ほかのサービスやアプリも検討しましたが、チャットアプリからもCLIのエージェントツールからもアクセスしやすく、AI向きに作られたものが見つかりませんでした。

Notionは人間が読むための道具としてはよくできています。ただ、リッチなブロック構造はAIにとっては邪魔で、ページ単位でしか情報を取れないから必要な1段落のためにページ全体のトークンを消費してしまいます。

ContextMixerは**AIが探索しやすいこと**を優先して設計したナレッジベースです。

## 何ができるか

### AIが自分でドキュメントを探して読み書きする

Claude DesktopやClaude CodeからMCP経由で直接アクセス。「このプロジェクトの設計方針を確認して」と言えば、AIが勝手に検索して必要なドキュメントを持ってきてくれます。プロンプトにコンテキストを貼る作業が不要になります。

### トークン消費を抑える粒度取得

ドキュメントを「どこまで読むか」を選べます。

```
GET /docs/:id?view=meta      → タイトル + 概要のみ（数十トークン）
GET /docs/:id?view=outline   → 見出し構造
GET /docs/:id?view=section   → 特定セクションだけ
GET /docs/:id?view=full      → 全文
```

AIはまずmetaを見て関係あるか判断し、必要ならsectionで必要な部分だけ取る。全文を毎回食わせないのでトークン消費が劇的に減ります。

### 人間もWeb UIで読み書きできる

ブラウザからコレクションツリーを閲覧、Markdownでドキュメントを編集、全文検索。HTMXで軽量に作られていて、サーバーサイドレンダリングのみで動きます。

### 3つの認証方式

| 相手 | 認証方式 | 用途 |
|------|----------|------|
| 人間（ブラウザ） | Clerk セッション認証 | Web UIへのログイン |
| AI（REST API） | APIキー（スコープ・コレクション制限あり） | 外部サービスからのアクセス |
| AI（MCP） | OAuth 2.1 | Claude.ai・ChatGPT等からの接続 |

APIキーは「このキーはこのプロジェクトのreadだけ」みたいな運用ができます。信頼度の低い外部サービスに渡すキーの権限を絞れるので安心です。

### そのほかの機能

- **全文検索** — D1のFTS5（trigram）による高速検索。ハイフン入り語にも対応
- **ドキュメントリンク** — `[[doc_xxx]]` 記法でドキュメント間リンク。backlinksも自動生成
- **リビジョン履歴** — 全書き込みに署名付きリビジョンを記録。誰が（人間/AI/OAuth）何を変更したか追跡可能
- **ファイル添付** — R2に画像等をアップロード、ドキュメントに埋め込み
- **Inbox** — 外部からの投稿を承認フロー経由で取り込み

## スタック

| 要素 | 選択 | 理由 |
|------|------|------|
| Runtime | Hono on Cloudflare Workers | エッジで動く・無料枠が大きい |
| DB | D1 (SQLite互換) | Workers統合・FTS5全文検索が使える |
| Storage | R2 | 転送無料・画像保存 |
| Frontend | HTMX + Workers Assets | ビルドステップ不要・サーバーサイドレンダリング |
| 認証 | Clerk + APIキー + OAuth 2.1 | 人間・AI・MCPクライアントの3系統 |
| MCP | workers-oauth-provider | Cloudflare公式・Streamable HTTP |

Cloudflareに全部寄せているのはコストが理由です。ナレッジベースは一度作ったら何年も使うものなので、ランニングコストがほぼゼロ（個人利用の範囲で無料枠内）なのは地味に大きいです。

## MCPツール一覧

AIがMCP経由で使えるツールは9個。

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

## 対応クライアント

| クライアント | 接続方法 |
|--------------|----------|
| Claude.ai | 設定 → Connectors → Custom Connector → URL入力 |
| Claude Code | `claude mcp add` でリモートMCPサーバーとして登録 |
| ChatGPT | Settings → Connectors → Add connector（ベータ） |
| MCP Inspector | `npx @modelcontextprotocol/inspector` でデバッグ |

## セルフホスト手順

### 前提

- Node.js 18+
- Wrangler CLI（`npm install -g wrangler`）
- Cloudflareアカウント（無料枠でOK）
- Clerkアカウント（認証用・無料枠でOK）

### 1. リポジトリをクローン

```bash
git clone https://github.com/iwabuchi404/context-mixer.git
cd context-mixer
npm install
cp wrangler.toml.example wrangler.toml
```

### 2. Cloudflareリソースを作成

```bash
# Cloudflareにログイン
npx wrangler login

# D1データベース作成
npm run d1:create
# → 出力された database_id を wrangler.toml に反映

# R2バケット作成
npm run r2:create

# KV名前空間作成（MCP OAuth用）
npx wrangler kv namespace create OAUTH_KV
# → 出力された id を wrangler.toml に反映
```

### 3. Clerkアプリを作成

1. [Clerk](https://clerk.com) でアプリを作成
2. 以下の値を取得:
   - `CLERK_SECRET_KEY`
   - `CLERK_PUBLISHABLE_KEY`
   - `CLERK_FRONTEND_API`（例: `https://your-app.clerk.accounts.dev`）
   - `CLERK_SIGN_IN_URL`（例: `https://your-app.clerk.accounts.dev/sign-in`）

### 4. シークレットを設定

ローカル開発用（`.dev.vars`）:

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

### 5. マイグレーション

```bash
# ローカル
npm run d1:migrate-local

# 本番
npm run d1:migrate
```

### 6. デプロイ

```bash
npm run deploy
```

これで `https://context-mixer.<your-subdomain>.workers.dev` で立ち上がります。

### 7. MCPクライアントから接続

デプロイ先の `/mcp` エンドポイントをMCPサーバーURLとして各クライアントに登録します。

例: Claude Codeの場合

```bash
claude mcp add context-mixer --transport http https://context-mixer.<your-subdomain>.workers.dev/mcp
```

## ローカル開発

```bash
npm run dev
```

`http://localhost:8787` で開発サーバーが立ち上がります。

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
