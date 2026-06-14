> ContextMixerをリモートMCPサーバー化し、Claude.ai等のMCP対応クライアントから直接利用できるようにするための実装プラン。
> 

## 目的

Chatツール（Claude.ai含む）からContextMixerへ自然にアクセスできるようにする。HTTP API単体ではweb_fetch系のセキュリティ制約で叩けないため、MCP化が必須。

---

## 前提・最新仕様（2026年6月時点）

- トランスポートは **Streamable HTTP**（`/mcp`）が標準。SSE（`/sse`）は非推奨
- Cloudflareは `workers-oauth-provider` でOAuth認可エンドポイントを自動提供
- 既存のClerk認証とは別レイヤー。MCPクライアント向けにはOAuth認可フローが必要
- Claude.aiはリモートMCP対応。設定画面からURL入力で接続可能

---

## 設計方針：ツールは絞る

Cloudflare公式が明示：「MCPサーバーをフルAPIのラッパーにするな。特定のユーザーゴールに最適化したツールを作れ。少数のよく設計されたツールの方が、多数の細粒度ツールより優れる」。

ContextMixerのAPIエンドポイントを全部ツール化せず、以下のツールに絞る：

| ツール | 役割 | 内部呼び出し |
| --- | --- | --- |
| `search_docs` | キーワード検索しsnippet返却 | services.search |
| `get_doc` | 粒度指定（meta/outline/full/section）で取得 | services.documents.get |
| `write_doc` | 新規作成・全文更新 | services.documents.create/update |
| `append_doc` | 末尾追記 | services.documents.append |
| `delete_doc` | ドキュメント削除 | services.documents.delete |
| `get_entrypoint` | エントリーポイント取得 | services.entrypoint |
| `list_collections` | コレクション一覧（ツリー） | services.collections.list |
| `create_collection` | コレクション作成 | services.collections.create |

---

## 実装ステップ

### Step 1: MCPハンドラの追加

`src/mcp/server.ts` を実装。既存のservices層をそのまま呼ぶラッパーとして作る。ロジックの重複はなし。

```tsx
// src/mcp/server.ts
import { McpAgent } from 'cloudflare:agents'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export class ContextMixerMCP extends McpAgent {
  server = new McpServer({ name: 'ContextMixer', version: '1.0' })

  async init() {
    this.server.tool('search_docs',
      { q: z.string(), scope: z.string().optional() },
      async ({ q, scope }) => services.search(q, scope))

    this.server.tool('get_doc',
      { id: z.string(), view: z.enum(['meta','outline','full']).optional() },
      async ({ id, view }) => services.documents.get(id, view))

    this.server.tool('write_doc',
      { title: z.string(), content: z.string(), collection_id: z.string() },
      async (args) => services.documents.create(args))

    // append_doc / get_entrypoint / list_collections 同様
  }
}
```

### Step 2: ルーティング登録

`src/index.ts` に `/mcp` エンドポイントを追加。Streamable HTTPトランスポートで公開。

### Step 3: 認証統合

MCPクライアント向けOAuth 2.1フローを `workers-oauth-provider` + Clerk で構築。

**Claude.aiとChatGPTの両方に同一実装で対応可能。**

両クライアントともOAuth 2.1 + PKCE + Streamable HTTPが仕様のため、1つのOAuthサーバーで両方をカバーできる。

ClerkのアプリにコールバックURLを2つ登録するだけ：

```
Claude.ai用:  https://claude.ai/oauth/callback
ChatGPT用:   https://chatgpt.com/oauth/callback
```

**対応クライアント整理：**

| クライアント | MCP接続 | 認証方式 |
| --- | --- | --- |
| Claude.ai | ✅ | OAuth 2.1必須 |
| ChatGPT | ✅（ベータ） | OAuth 2.1必須 |
| Gemini Chat | ❌ 未対応 | — |
| z.ai Chat | ❌ 未対応 | — |

### Step 4: ツールごとの署名付与

既存の書き込み署名（author_type / api_key_id）をMCP経由の書き込みにも適用。MCPツール経由は `author_type='ai'` として記録。

### Step 5: 接続テスト

Cloudflare AI Playground または MCP Inspector で疎通確認 → Claude.aiから接続テスト。

---

## 実装コスト見積もり

| ステップ | 内容 | 工数 |
| --- | --- | --- |
| 1 | MCPハンドラ（services流用） | 2〜3時間 |
| 2 | ルーティング | 1時間 |
| 3 | 認証統合 | 2〜3時間（方式次第） |
| 4 | 署名付与 | 1時間 |
| 5 | 接続テスト | 1〜2時間 |
| **合計** |  | **半日〜1日** |

services層が既にあるため低コスト。最大の不確実性はStep 3の認証方式。

---

## 未決事項

- [ ]  MCP認証方式（Cloudflare Access vs APIキー流用）
- [ ]  Claude.aiのリモートMCP接続でClerk認証とどう共存させるか
- [ ]  ツールの最終的な粒度（5〜6個で足りるか実運用で検証）

---

## 参考リンク

- Build a Remote MCP server: https://developers.cloudflare.com/agents/guides/remote-mcp-server/
- MCP概要: https://developers.cloudflare.com/agents/model-context-protocol/
- Securing MCP servers: https://developers.cloudflare.com/agents/guides/securing-mcp-server/