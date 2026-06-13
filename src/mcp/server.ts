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
    description: 'Create or update a document',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Document ID (omit to create new)' },
        title: { type: 'string', description: 'Document title' },
        content: { type: 'string', description: 'Document content (markdown)' },
        collection_id: { type: 'string', description: 'Collection ID' }
      },
      required: ['title', 'content', 'collection_id']
    }
  },
  append_doc: {
    description: 'Append content to the end of a document',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Document ID' },
        content: { type: 'string', description: 'Content to append' }
      },
      required: ['id', 'content']
    }
  },
  list_collections: {
    description: 'List all collections',
    inputSchema: {
      type: 'object' as const,
      properties: {}
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
  }
}

