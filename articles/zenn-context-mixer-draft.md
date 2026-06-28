# Context Mixer: AI と人間が共同管理するナレッジベースを作った話

## タイトル案

1. **Context Mixer: AI と人間が共同管理する AI ファーストなナレッジベースを Cloudflare Workers で作った**
2. **Notion から卒業 — AI が自分で書き換えるナレッジベースを作った**
3. **MCP 対応のセルフホスト型ナレッジベース「Context Mixer」をリリースした**

---

## はじめに

個人開発のプロジェクトが 20 を超えたあたりで、Notion にためたドキュメントを AI ツールから使うのがしんどくなりました。

- 少しの追記にもレイテンシがかかる
- 何度も読み書きしているとトークン消費が馬鹿にならない
- チャットアプリからも CLI のエージェントからもアクセスしやすい、AI 向けのナレッジベースがない

そこで作ったのが **Context Mixer** です。

AI が自分で必要な情報を探しに行き、読み、書き込める場所。プロンプトにコンテキストを手動で貼る作業がなくなります。

---

## 何が違うのか

### 1. AI が主体で情報を探索する

MCP（Model Context Protocol）対応により、Claude Desktop や Claude Code、Claude.ai から直接アクセスできます。

「このプロジェクトの設計方針を確認して」と言えば、AI が勝手に検索して必要なドキュメントを持ってきます。

### 2. トークン消費を抑える粒度取得

ドキュメントを「どこまで読むか」を選べます。

```
GET /docs/:id?view=meta      → タイトル + 概要のみ（数十トークン）
GET /docs/:id?view=outline   → 見出し構造
GET /docs/:id?view=section   → 特定セクションだけ
GET /docs/:id?view=full      → 全文
```

AI はまず `meta` を見て関係あるか判断し、必要なら `section` で必要な部分だけ取ります。全文を毎回食わせないのでトークン消費が劇的に減ります。

### 3. 人間も Web UI で読み書きできる

ブラウザからコレクションツリーを閲覧、Markdown でドキュメントを編集、全文検索。HTMX で軽量に作られていて、サーバーサイドレンダリングのみで動きます。

### 4. 3 系統の認証

| 相手 | 認証方式 | 用途 |
|---|---|---|
| 人間（ブラウザ） | Clerk セッション認証 | Web UI へのログイン |
| AI（REST API） | API キー（スコープ・コレクション制限あり） | 外部サービスからのアクセス |
| AI（MCP） | OAuth 2.1 | Claude.ai・ChatGPT 等からの接続 |

API キーは「このキーはこのプロジェクトの read だけ」みたいな運用ができます。信頼度の低い外部サービスに渡すキーの権限を絞れるので安心です。

---

## 技術スタック

| 要素 | 選択 | 理由 |
|---|---|---|
| Runtime | Hono on Cloudflare Workers | エッジで動く・無料枠が大きい |
| DB | D1 (SQLite 互換) | Workers 統合・FTS5 全文検索が使える |
| Storage | R2 | 転送無料・画像保存 |
| Frontend | HTMX + Workers Assets | ビルドステップ不要・サーバーサイドレンダリング |
| 認証 | Clerk + API キー + OAuth 2.1 | 人間・AI・MCP クライアントの 3 系統 |
| MCP | workers-oauth-provider | Cloudflare 公式・Streamable HTTP |

Cloudflare に全部寄せているのはコストが理由です。ナレッジベースは一度作ったら何年も使うものなので、ランニングコストがほぼゼロ（個人利用の範囲で無料枠内）なのは地味に大きいです。

---

## 主な機能

- **全文検索** — D1 の FTS5（trigram）による高速検索。ハイフン入り語にも対応
- **ドキュメントリンク** — `[[doc_xxx]]` 記法でドキュメント間リンク。backlinks も自動生成
- **リビジョン履歴** — 全書き込みに署名付きリビジョンを記録。誰が（人間/AI/OAuth）何を変更したか追跡可能
- **ファイル添付** — R2 に画像等をアップロード、ドキュメントに埋め込み
- **Inbox** — 外部からの投稿を承認フロー経由で取り込み

---

## 開発でこだわった点

### 1. 書き込みの信頼性

ドキュメント書き込みは全経路（REST・UI・MCP・inbox）で共通の `createDocument` / `updateDocument` を通します。

- 楽観的ロック（version + expected_version）
- 冪等性（同じ内容なら revision スキップ）
- 直近 20 件の revision 保持

### 2. MCP ツールは REST 同等の制限を適用

MCP 経由のツールは `AiAuth` を受け取り、REST API と同じスコープ・コレクション制限を適用します。AI だからといって特別な権限は与えません。

### 3. サーバーサイドレンダリング

フロントエンドは HTMX + サーバーサイドレンダリングのみ。ビルドステップがなく、Cloudflare Workers Assets で静的ファイルを配信しています。SPA 化の複雑さを避け、AI 向けの軽量な UI を目指しました。

---

## セルフホスト

```bash
git clone https://github.com/iwabuchi404/context-mixer.git
cd context-mixer
npm install

# Cloudflare にログイン
npx wrangler login

# D1 データベース作成
npm run d1:create

# R2 バケット作成
npm run r2:create

# KV 名前空間作成（MCP OAuth 用）
npx wrangler kv namespace create OAUTH_KV

# マイグレーション
npm run d1:migrate

# デプロイ
npm run deploy
```

Clerk アプリの作成と Secret 設定も必要です。詳細は README を参照してください。

---

## 開発で苦労した点

### 1. SMB 上での開発

リポジトリが SMB 共有上にあったため、SQLite がハングしたり、wrangler のファイル監視がクラッシュしたりしました。対策として、ローカル D1 は `%USERPROFILE%` 直下に逃がし、編集後は `npm run dev` を再起動する運用にしています。

### 2. MCP OAuth 2.1 の実装

自前の OAuth 実装は脆弱だったため、Cloudflare 公式の `@cloudflare/workers-oauth-provider` に移行しました。Clerk で認証し、consent 画面で権限（read/write・対象コレクション）を選択できる設計にしました。

### 3. OSS 公開前の整備

デプロイ設定や本番 URL、リソース ID、Clerk キー等がコードに入っていたため、履歴を書き換えてから公開しました。Cloudflare 的には D1/KV の ID は公開しても問題ないとのことですが、ドメイン名や Clerk キーは慎重に扱いました。

---

## 今後の展望

- より細かい検索（コレクション内検索、タグ検索）
- AI 向けの自動要約・タグ付け
- モバイル UI のさらなる改善
- コラボレーション機能（複数人間での編集）

---

## まとめ

Context Mixer は、AI ファーストのナレッジベースを個人開発者でもセルフホストできることを目指したプロジェクトです。

Notion のように人間が読むことを前提にせず、AI が探索しやすい構造を優先することで、トークン消費を抑えつつ、AI との協業をスムーズにしています。

興味があれば、GitHub リポジトリを覗いてみてください。

---

## リンク

- GitHub: https://github.com/iwabuchi404/context-mixer
- 作者のデモ環境: https://context-mixer.frog404.work

---

## 補足：Zenn 投稿用メモ

- 公開範囲: 技術説明 + セルフホスト手順
- デモサイトへのリンクは「作者のデモ環境」として補足に入れる
- スクリーンショットは Web UI のツリー・編集画面・MCP 接続例を入れる
- コードブロックは実際の API リクエスト例を少し入れる
