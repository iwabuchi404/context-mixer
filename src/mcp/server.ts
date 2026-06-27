// MCP Tool definitions for ContextMixer

// Tool definitions with JSON schemas for validation
export const toolDefinitions = {
  search_docs: {
    description: 'Search documents by keyword with full-text search',
    inputSchema: {
      type: 'object' as const,
      properties: {
        q: { type: 'string', description: 'Search query' },
        scope: { type: 'string', description: 'Optional scope (e.g., "collection:col_abc")' },
        limit: { type: 'number', description: 'Max results (default: 10)' }
      },
      required: ['q']
    }
  },
  get_doc: {
    description: 'Get a document with optional view mode (meta, outline, or full)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Document ID' },
        view: { type: 'string', description: 'View mode: meta, outline, or full (default: full)' }
      },
      required: ['id']
    }
  },
  write_doc: {
    description: 'Create or update a document. When creating, specify parent_id to create as a child document. Provide expected_version for optimistic concurrency control.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Document ID (omit to create new)' },
        title: { type: 'string', description: 'Document title' },
        content: { type: 'string', description: 'Document content (markdown)' },
        collection_id: { type: 'string', description: 'Collection ID' },
        parent_id: { type: 'string', description: 'Parent document ID (optional, for creating child documents)' },
        expected_version: { type: 'number', description: 'Expected current version for optimistic concurrency control' }
      },
      required: ['title', 'content', 'collection_id']
    }
  },
  append_doc: {
    description: 'Append content to the end of a document. Provide expected_version for optimistic concurrency control.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Document ID' },
        content: { type: 'string', description: 'Content to append' },
        expected_version: { type: 'number', description: 'Expected current version for optimistic concurrency control' }
      },
      required: ['id', 'content']
    }
  },
  list_collections: {
    description: 'List all collections as a tree structure with nested children',
    inputSchema: {
      type: 'object' as const,
      properties: {}
    }
  },
  list_docs: {
    description: 'List documents in a collection for navigation. Returns id, title, parent_id, priority, updated_at (lightweight — no content). Use this to discover documents before calling get_doc. Set parent_id="root" for top-level only, or a doc id to list its children.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        collection_id: { type: 'string', description: 'Collection ID (required)' },
        parent_id: { type: 'string', description: 'Optional: "root" for top-level docs only, or a document id to list its direct children. Omit to list all documents in the collection.' }
      },
      required: ['collection_id']
    }
  },
  get_entrypoint: {
    description: 'Get entry point document(s) for navigation',
    inputSchema: {
      type: 'object' as const,
      properties: {
        collection_id: { type: 'string', description: 'Optional collection ID to get specific entry point' }
      }
    }
  },
  delete_doc: {
    description: 'Delete a document permanently',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Document ID to delete' }
      },
      required: ['id']
    }
  },
  create_collection: {
    description: 'Create a new collection',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Collection name' },
        description: { type: 'string', description: 'Optional description' },
        parent_id: { type: 'string', description: 'Optional parent collection ID for nesting' }
      },
      required: ['name']
    }
  }
}

