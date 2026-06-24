# Context Mixer

個人とAIが共同管理するAIファーストのナレッジベース。Notion代替。AI書き込み8割・人間読み書き両方・モバイル対応前提で、AIの探索コストを下げる設計。

## スタック / 配置

- **Runtime**: Hono on Cloudflare Workers
- **DB**: D1 (SQLite)。スキーマは [src/db/schema.sql](src/db/schema.sql)
- **Storage**: R2(ファイル添付)
- **認証**: Clerk(人間セッション) + APIキー(AI)。MCPはOAuth(下記)
- **フロント**: 静的アセット(`public/`)を Workers Assets で配信。HTMX + Vue無し。Markdownはサーバー側(marked)でレンダリング
- **本番**: デプロイ先のWorkers URL（Clerk本番インスタンス使用、pk_live）

## アーキテクチャの要点

- **3系統の認証**(全て [src/auth/](src/auth/)):
  - 人間 = Clerkセッション。AI(REST) = APIキー `kb_...`(SHA-256ハッシュ保存、[apikey.ts](src/auth/apikey.ts))。MCP = OAuth(workers-oauth-provider)
  - [middleware.ts](src/auth/middleware.ts) が REST/UI を保護。公開パス: `/`・`/health`・`/config`・`/favicon.svg`・`/auth/*`・`/public/*`・`/oauth/authorize`・`POST /inbox/:token`
  - 認証コンテキストは `AuthContext`([adapter.ts](src/auth/adapter.ts)):human(全権限)/ ai(scope + allowedCollections制限)。`isCollectionAllowed` / `authorOf` で権限と署名を一元化
- **ルートとサービス**: [src/routes/](src/routes/) が薄いハンドラ、[src/services/](src/services/) に共通ロジック(`sections.ts` 見出し解析、`links.ts` `[[doc_xxx]]`リンク同期、`markdown.ts` 安全なSSR+`escapeHtml`)
- **書き込みの不変条件**: ドキュメント書き込みは必ず `createRevision`(署名付きリビジョン)+ `syncDocumentLinks` を通す。REST・UI・MCP全経路で共通(documents.ts の `createRevision` をexportして再利用)
- **MCP**([src/mcp/](src/mcp/)): `tools.ts` のツールは `AiAuth` を受け取りREST同等の制限を適用。`handler.ts` は OAuthProvider の apiHandler(WorkerEntrypoint)。`server.ts` がツール定義
- **デザインシステム「台所」v0.3**([docs/design-system.md](docs/design-system.md) / [public/tokens.css](public/tokens.css)): 生成り背景+墨+藍の二色、UIクロームのみ等幅/直角/強い罫線でCLI感、本文はアナログ。「機械の事実(日時・ID・作者)は等幅」。本文末に終止符「了」を打つ癖あり。コンポーネントから生の色値を使わずトークン参照

## 開発(重要な環境注意)

- **このリポジトリはSMB共有(`y:`)上にある**。詳細は永続メモリ参照。要点:
  - wranglerのローカルD1は `--persist-to %USERPROFILE%/.context-mixer/wrangler-state` でCドライブに逃がす(共有上だとSQLiteがハングする)。npm scripts設定済み
  - `wrangler dev` のファイル監視がSMB上で時々クラッシュする。**ファイルを編集したら `npm run dev` を再起動**
  - エディタ(IDE)のファイル保存/Reapplyが不安定。編集後は内容を読み直して確認する
  - gitは「dubious ownership」で要 `safe.directory` 設定
- **コマンド**: `npm run dev`(ローカル)/ `npm run type-check`(tsc) / `npm run d1:migrate-local`(ローカルDBスキーマ適用) / `npm run deploy`(本番)
- **ローカル用テストAPIキー**(seed済み): full=`kb_d1960894350234423d709ddc10df2239d710d471ccf5e336e79bfd2023eada58`、read-only=`kb_aeeb...`、コレクション制限=`kb_c075...`(詳細は永続メモリ)
- **デプロイ**: CLIは未認証。ユーザーがWebUI/GitHub連携で本番反映している。**コード変更は再デプロイされるまで本番に反映されない**

## 規約

- TypeScript strict。`npm run type-check` を通す
- 動的値をHTMLに出すときは必ず `escapeHtml`(markdown.ts)。AI/外部入力を信用しない
- D1クエリは必ずプレースホルダ(`?`)バインド
- 全文検索は3文字未満でFTS5が効かないため LIKE フォールバック(search.ts / tools.ts に既存)
- 詳細設計は [docs/design-doc.md](docs/design-doc.md)、MCP方針は [docs/MCP.md](docs/MCP.md)

## 現在地

到達点と進行中タスクは [docs/STATUS.md](docs/STATUS.md) を参照(セッション引き継ぎ用)。
