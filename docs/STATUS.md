# 進捗 / 引き継ぎ (STATUS)

> 次セッション向けの「現在地」。最終更新: 2026-06-13。CLAUDE.md と併せて読むこと。

## 完成して本番稼働中のもの

本番 `https://context-mixer.flog404.work` にデプロイ済み・動作確認済み:

- コアAPI: ドキュメント(CRUD・view=meta/outline/full・セクション単位GET/PATCH・append・履歴)、コレクション(ツリー・CRUD)、全文検索(FTS5 + 3文字未満LIKEフォールバック)、ドキュメントリンク(`[[doc_xxx]]` + backlinks)
- 認証: Clerk(本番インスタンス `accounts.flog404.work` / `pk_live`)、APIキー(`kb_`、SHA-256、scope + コレクション制限、失効)
- Web UI(デザインシステム「台所」v0.3): ツリー+本文の読み画面、コレクション一覧(追加/リネーム/削除)、APIキー管理、inbox承認、ファイル、検索、システム行(sysline)
- files(R2)、inbox(承認フロー)、entrypoint、/me/entrypoint
- セキュリティ対策(済): 全HTML出力のエスケープ、レート制限([rate-limit.ts](../src/auth/rate-limit.ts):inbox20/auth30/その他600 per min)、inbox本文10万字・ファイル10MB上限、inbox-token認証バイパス修正、ルート/アセット衝突修正(inbox/filesフラグメントを `/ui/*` へ)
- APIキーのreadスコープ取りこぼし修正(parseBody `all:true`)

## 進行中: MCP の OAuth 実装(claude.ai 対応) ← ここから再開

### 背景
claude.ai からMCP接続するにはOAuth 2.1(PKCE/DCR/メタデータ公開)が必須。前回の自前OAuthは脆弱で全廃済み。今回は **Cloudflare公式 `@cloudflare/workers-oauth-provider`** を採用し、認証はClerkに委譲、consent画面で**権限(read/write・対象コレクション)を選択**できる設計。プランは [.claude/plans/goofy-coalescing-emerson.md](../../.claude/plans/goofy-coalescing-emerson.md) に承認済みで残っている。

### コード変更: 完了済み(型チェック `npm run type-check` 通過・ローカル検証済み 2026-06-13)
> 注: 前セッションで配線部(index.ts のOAuthラップ・oauth-handler.ts・adapter.ts Env・middleware.ts・wrangler.toml)がSMB保存不安定で失われていた。本セッションで承認済みプランに沿って再実装・復旧した。
- [package.json](../package.json): `@cloudflare/workers-oauth-provider` 追加済み
- [src/index.ts](../src/index.ts): `export default new OAuthProvider({...})` でラップ。`apiRoute:'/mcp'` → `McpApiHandler`、`defaultHandler:` 既存Honoアプリ、`authorizeEndpoint:'/oauth/authorize'`、`tokenEndpoint:'/oauth/token'`、`clientRegistrationEndpoint:'/oauth/register'`、`scopesSupported:['read','write']`。Honoアプリに `app.route('/oauth', oauthRoute)` を追加
- [src/mcp/handler.ts](../src/mcp/handler.ts): `McpApiHandler`(WorkerEntrypoint)。`this.ctx.props`(McpProps)から `AiAuth` を組み立て、initialize/ping/tools/list/tools/call/notifications を処理。ツール単位scope判定(TOOL_SCOPE)
- [src/mcp/oauth-handler.ts](../src/mcp/oauth-handler.ts): `/oauth/authorize`(GET/POST)の consent UI。`parseAuthRequest` → Clerkログイン確認(未ログインは `CLERK_SIGN_IN_URL?redirect_url=` でサインインへ往復)→ read/write + コレクション選択(「すべて」=null)→ `completeAuthorization({props})`。CSRFは txn を `OAUTH_KV`(10分TTL)+ SameSite cookie の二重送信で検証、deny時は `error=access_denied` でリダイレクト
- [src/mcp/tools.ts](../src/mcp/tools.ts): 各ツールが `AiAuth` を受け、isCollectionAllowed・署名・リンク同期を適用(REST同等)。writeDocは親ドキュメント(parent_id)対応済み
- [src/auth/adapter.ts](../src/auth/adapter.ts): Env に `OAUTH_KV: KVNamespace` と `OAUTH_PROVIDER: OAuthHelpers`(`@cloudflare/workers-oauth-provider` からimport)、型 `McpProps` 追加
- [src/auth/middleware.ts](../src/auth/middleware.ts): 公開パスを `/oauth/` 配下に(旧 `/mcp` skipは除去 — /mcp・token・register・metadata は OAuthProvider が defaultHandler 前に処理しHonoに来ない)
- [wrangler.toml](../wrangler.toml): `[[kv_namespaces]] OAUTH_KV` 追加(旧自前OAuthの `[vars] OAUTH_CLIENT_ID` は削除)。**id は `REPLACE_WITH_PRODUCTION_KV_ID` のまま(本番デプロイ前に要差し替え)**

### ローカル検証: 完了(2026-06-13、`npm run dev` ポート8788で実施)
- ✅ `/.well-known/oauth-authorization-server` 200(issuer/endpoints/`scopes_supported:[read,write]` 正常)
- ✅ `/.well-known/oauth-protected-resource` 200
- ✅ 回帰: `/health` 200、`/`(UI)200、`/collections`(APIキー)200、`/docs`(無認証)401 ← OAuthProviderラップ後もREST/UI健在
- ✅ `/mcp`(トークン無し)401(ライブラリのトークン検証が機能)
- ✅ DCR(`POST /oauth/register`)→ client_id発行 → `GET /oauth/authorize`(登録済みclient・セッション無し)で **302 → Clerkサインイン**(`redirect_url` に元のOAuthパラメータを保持)。未登録clientは `parseAuthRequest` が400(仕様通り)
- dev起動ログにランタイムエラー無し

### 残作業(次セッションのTODO)
1. **ブラウザ/Inspectorでの対話フロー検証**(ローカルの自動curlでは不可 = Clerkログインが必要):
   - `npx @modelcontextprotocol/inspector` で OAuthフロー全体(DCR→authorize→**Clerkログイン→consent画面で権限選択**→token→tools/call)
   - consent画面が描画されるか、read-only選択時に write_doc が `-32003` で拒否されるか、コレクション限定が効くか
2. **本番KV作成**: ダッシュボード(Storage→KV→Create)or `npx wrangler kv namespace create OAUTH_KV` → 出た id を wrangler.toml の `OAUTH_KV` に記入(現状プレースホルダ)
3. **本番デプロイ** → claude.ai のコネクタに `https://context-mixer.flog404.work/mcp` を登録 → ブラウザOAuthフローで接続しツール実行を確認
4. 確認できたら STATUS を更新(MCP完了へ)

### 注意・既知の判断
- **MCP接続はOAuthに一本化**。段階1のAPIキーBearer方式のMCP接続(Claude Code向け)は廃止。Claude Code もOAuthフローで繋ぐ。REST APIのAPIキーは従来どおり有効
- `export default` の構造変更はアプリ全体の入口。デプロイ後に**UI/REST/Clerkログインの回帰確認**を必ず行う
- 本番のClerk値(pk_live・accounts.flog404.work)はダッシュボード側で管理されている。wrangler.toml の `[vars]` はローカル用の開発キー(pk_test)のまま — これは正常(ローカルは開発インスタンス)

## 他に保留中のもの(優先度低)
- observability(`[observability] enabled=true`)未追加、compatibility_date が `2024-01-01` と古い
- WAFレート制限(ダッシュボード)未設定
- SMB共有 → ローカルclone + git remote 化(開発環境改善。ずっと懸案)
