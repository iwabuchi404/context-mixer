# ContextMixer 使い方ガイド

ContextMixerの使い方を、目的別に説明する。

- [Web UI（人間向け）](#web-ui人間向け)
- [APIキー（AI・外部サービス向け）](#apiキーai外部サービス向け)
- [MCP接続（Claude.ai・ChatGPT等）](#mcp接続claudeaichatgpt等)
- [ドキュメントリンク記法](#ドキュメントリンク記法)
- [トラブルシューティング](#トラブルシューティング)

---

## Web UI（人間向け）

ブラウザで `https://context-mixer.flog404.work` にアクセス。Clerkアカウントでログインする。

### コレクション・ドキュメントの閲覧

- 左側にコレクションツリー、右側にドキュメント本文が表示される
- コレクション・ドキュメントとも先頭の ▾ で開閉できる
- 初回ロード時はコレクションが閉じた状態。現在開いているドキュメントの親コレクションは自動的に開く
- ドキュメントを開くと URL が `/ui/doc/<id>` になる。直接共有可能

### ドキュメントの編集

- ドキュメント右上の「編集」ボタンで編集モードに切り替え
- Markdownで本文を書く
- 保存すると自動的にリビジョンが作成される（差分は履歴ページで確認）
- コピーボタンでMarkdownソースをクリップボードにコピー可能
- コードブロックにホバーするとコピーボタンが表示される

### コレクションの操作

- コレクション一覧ページ（`/ui/collections`）で追加・リネーム・削除
- コレクションは階層化できる（親コレクションを持てる）
- 各コレクションにエントリーポイントドキュメントを設定可能（`/entrypoint` で表示される）

### 検索

- 検索バーにキーワードを入力。FTS5による全文検索
- 3文字未満のクエリはLIKE検索にフォールバック
- ハイフン入り語（`context-mixer` 等）もそのまま検索可能

### ファイル添付

- ドキュメント編集中に画像等をアップロード可能
- ファイルはR2に保存され、Markdownに埋め込める

### Inbox

- 外部システムからの投稿を受け取る仕組み
- Inboxトークンを発行し、そのトークンに対してPOSTで投稿
- 投稿は承認フローを経てドキュメントに取り込まれる

---

## APIキー（AI・外部サービス向け）

REST APIにアクセスするためのAPIキーを発行する。

### APIキーの発行

1. Web UIにログイン
2. 「API Keys」ページ（`/ui/keys`）を開く
3. 「新規作成」をクリック
4. 以下を設定:
   - **名前**: キーの用途が分かる名前（例: `claude-code-read`）
   - **スコープ**: `read` または `read/write`
   - **アクセス可能なコレクション**: 全コレクション または 特定のコレクションのみ
5. 作成すると `kb_xxxxxxxxxxxx...` 形式のキーが表示される。**この画面でしか見られないので必ずコピーして保存**

### APIキーの使い方

リクエストヘッダーに `Authorization: Bearer` で指定:

```bash
curl https://context-mixer.flog404.work/docs \
  -H "Authorization: Bearer kb_xxxxxxxx"
```

### スコープとコレクション制限

| 設定 | 動作 |
|------|------|
| `read` スコープ | GET系エンドポイントのみアクセス可能 |
| `read/write` スコープ | 全エンドポイントにアクセス可能 |
| コレクション制限なし | 全コレクションのドキュメントにアクセス可能 |
| コレクション制限あり | 指定したコレクション配下のみアクセス可能 |

### APIキーの管理

- APIキーハッシュはSHA-256で保存（平文では保存しない）
- 不要になったキーは「失効」ボタンで無効化
- 失効したキーは復元できない

### ドキュメント取得の粒度

AIがトークンを節約するため、取得粒度を選べる:

| view | 内容 | トークン消費 |
|------|------|------------|
| `meta` | タイトル + 概要のみ | 最小 |
| `outline` | 見出し構造（h1-h6） | 小 |
| `full` | 全文 | 大 |
| `section` | 特定セクションのみ | 中 |

```
GET /docs/doc_123?view=meta
GET /docs/doc_123?view=outline
GET /docs/doc_123?view=full
GET /docs/doc_123?view=section&section=intro
```

AIの典型的なフロー:
1. `search_docs` でキーワード検索 → タイトルとスニペットを得る
2. `get_doc?view=meta` で関連性を判断
3. 必要なら `get_doc?view=outline` で構造を把握
4. 必要なセクションだけ `get_doc?view=section` で取得

---

## MCP接続（Claude.ai・ChatGPT等）

MCP（Model Context Protocol）経由でAIチャットクライアントから直接ContextMixerにアクセスできる。OAuth 2.1認証を使用。

### Claude.ai

1. Claude.aiの設定を開く
2. **Connectors** → **Add custom connector**
3. MCPサーバーURLを入力: `https://context-mixer.flog404.work/mcp`
4. ブラウザでOAuth認可フローが開く:
   - Clerkログイン（未ログインの場合）
   - 権限選択画面で **read** または **read/write** を選択
   - アクセスするコレクションを選択（「すべて」も可）
   - 「許可」をクリック
5. Claude.aiに戻り、コネクタが有効になる
6. チャットで「ContextMixerのドキュメントを検索して」等と依頼すると、AIがMCPツールを呼び出す

### Claude Code

CLIからMCPサーバーを登録:

```bash
claude mcp add context-mixer --transport http https://context-mixer.flog404.work/mcp
```

初回呼び出し時にブラウザでOAuth認可フローが開く。

### ChatGPT

1. Settings → Connectors → Add connector（ベータ機能）
2. MCPサーバーURLを入力: `https://context-mixer.flog404.work/mcp`
3. OAuth認可フローで認証

### MCP Inspector（デバッグ用）

MCPツールの動作を直接確認したい場合:

```bash
npx @modelcontextprotocol/inspector
```

InspectorにMCPサーバーURLを入力し、OAuth認証後にツールを手動で呼び出せる。

### MCPツール一覧

#### 読み取り（read スコープ）

| ツール | 引数 | 説明 |
|--------|------|------|
| `search_docs` | `q`（必須）, `scope?`, `limit?` | キーワード全文検索。スニペット付きで結果返却 |
| `get_doc` | `id`（必須）, `view?` | ドキュメント取得。`view` は `meta`/`outline`/`full`（デフォルト: full） |
| `list_collections` | なし | コレクション一覧をツリー構造で返却 |
| `list_docs` | `collection_id`（必須）, `parent_id?` | コレクション内のドキュメント一覧。本文なし・軽量。`parent_id="root"` でトップレベルのみ |
| `get_entrypoint` | `collection_id?` | エントリーポイントドキュメントを取得 |

#### 書き込み（write スコープ）

| ツール | 引数 | 説明 |
|--------|------|------|
| `write_doc` | `title`, `content`, `collection_id`（必須）, `id?`, `parent_id?` | ドキュメント作成・更新。`id` 省略で新規作成。`parent_id` で子ドキュメント作成 |
| `append_doc` | `id`, `content`（必須） | ドキュメント末尾に追記 |
| `delete_doc` | `id`（必須） | ドキュメント削除。子ドキュメントの `parent_id` は NULL になる |
| `create_collection` | `name`（必須）, `description?`, `parent_id?` | コレクション作成。`parent_id` で階層化 |

### 権限の仕組み

- OAuth認可時に選択したスコープ（read または read/write）に基づいてツールの使用可否が決まる
- read スコープで write系ツールを呼ぶとエラー（`-32003`）が返る
- コレクション制限をかけた場合、そのコレクション配下のドキュメントのみアクセス可能
- 書き込みには必ず署名付きリビジョンが作成される。OAuth経由の書き込みは `author_type='ai'`、`keyName='oauth:email'` で記録

---

## ドキュメントリンク記法

ドキュメント間をリンクできる。

### 書き方

本文中に `[[doc_xxx]]` と書くと、該当ドキュメントへのリンクに変換される。

```markdown
設計方針は [[doc_abc123]] を参照。
```

### backlinks

リンク先のドキュメントには、誰からリンクされているか（backlinks）が自動表示される。リンクの追加・削除はドキュメント保存時に自動で同期される。

---

## トラブルシューティング

### MCP接続で認証エラーになる

- Clerkアカウントでログインできるか確認
- OAuth認可画面で権限を正しく選択したか確認
- トークンの有効期限が切れた場合はコネクタを一度削除して再接続

### 検索結果が0件になる

- クエリが3文字未満の場合はLIKE検索にフォールバックするが、完全一致に近い場合のみヒットする
- FTS5のマイグレーションが未適用の場合はLIKE検索にフォールバックする
- コレクション制限をかけている場合、そのコレクション配下にドキュメントがあるか確認

### APIキーで401になる

- キーが失効していないか確認
- `Authorization: Bearer kb_xxx` の形式になっているか確認（`Bearer` と `kb_` の間にスペース）
- スコープに対して適切なエンドポイントを叩いているか確認（read キーで POST は不可）

### 書き込みが反映されない

- Web UIで編集後、保存ボタンを押したか確認
- MCP経由の書き込みはリビジョンとして記録される。履歴ページで変更が確認できる
- コレクション制限をかけている場合、そのコレクションへの書き込み権限があるか確認（read スコープでは書き込み不可）

### ハイフン入り語で検索エラーが出る

- ContextMixerは検索語をフレーズクォートしてFTS5に渡すため、`context-mixer` のようなハイフン入り語もそのまま検索可能
- もしエラーが出る場合は、FTS5インデックスのマイグレーションが未適用の可能性がある
