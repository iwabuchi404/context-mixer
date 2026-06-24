// マルチテナント対応のクエリヘルパー
// 各ルートでユーザーフィルタを追加する際、このヘルパーを使って
// SQL片とバインドパラメータを一貫した形で追加する

/**
 * collections テーブルに直接アクセスする際の WHERE 句
 * 例: SELECT * FROM collections WHERE owner_user_id = ? AND ${userCollectionsFilter()}
 * ※ 現状は単純なプレースホルダのみ（auth から取り出すのは呼び出し元の責務）
 */
export const userCollectionsFilter = (): string => `1=1`

/**
 * documents テーブルにアクセスする際の WHERE 句（collections 経由でオーナー判定）
 */
export const userDocsFilter = (): string =>
  `collection_id IN (SELECT id FROM collections WHERE owner_user_id = ?)`

/**
 * files テーブルにアクセスする際の WHERE 句（documents → collections 経由）
 */
export const userFilesFilter = (): string =>
  `document_id IN (SELECT d.id FROM documents d JOIN collections c ON d.collection_id = c.id WHERE c.owner_user_id = ?)`

/**
 * inbox_tokens テーブルに直接アクセスする際の WHERE 句
 */
export const userInboxTokensFilter = (): string => `owner_user_id = ?`

/**
 * api_keys テーブルに直接アクセスする際の WHERE 句
 */
export const userApiKeysFilter = (): string => `owner_user_id = ?`
