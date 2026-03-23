# web-fetch-mcp

A Model Context Protocol (MCP) server that provides safe, high-signal web browsing and content fetching for LLM agents.

## Features

- **Multi-format support**: HTML, JavaScript-rendered pages (SPA), Markdown, PDF, JSON, RSS/Atom/XML feeds
- **Intelligent extraction**: Uses Readability + Turndown for clean markdown output
- **Security first**: SSRF protection, prompt injection detection, rate limiting
- **LLM-optimized output**: Structured packets with citations, outlines, and metadata
- **Context management**: Semantic chunking and intelligent compaction
- **AI Search**: Conversation-scoped knowledge base via Cloudflare R2 + AI Search
- **AI Gateway**: Optional LLM-powered compaction via Cloudflare AI Gateway

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Client (LLM)                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      web-fetch-mcp Server                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                      MCP Tools                           │   │
│  │  fetch │ extract │ chunk │ compact │ ai_search_query     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│  ┌───────────────────────────┼───────────────────────────────┐ │
│  │                    Security Layer                         │ │
│  │  SSRF Guard │ Rate Limiter │ Injection Detector          │ │
│  └───────────────────────────┼───────────────────────────────┘ │
│                              │                                  │
│  ┌───────────────────────────┼───────────────────────────────┐ │
│  │                    Fetcher Layer                          │ │
│  │  HTTP (undici) │ Browser (Playwright) │ robots.txt       │ │
│  └───────────────────────────┼───────────────────────────────┘ │
│                              │                                  │
│  ┌───────────────────────────┼───────────────────────────────┐ │
│  │                  Extractor Layer                          │ │
│  │  HTML │ Markdown │ PDF │ JSON │ XML/RSS │ Text           │ │
│  └───────────────────────────┼───────────────────────────────┘ │
│                              │                                  │
│  ┌───────────────────────────┼───────────────────────────────┐ │
│  │                 Processing Layer                          │ │
│  │  Normalizer │ Chunker │ Compactor │ Outline Generator    │ │
│  └───────────────────────────┼───────────────────────────────┘ │
│                              │                                  │
│  ┌───────────────────────────┼───────────────────────────────┐ │
│  │               AI Search / AI Gateway                     │ │
│  │  R2 Upload │ Scoped Queries │ LLM Compaction             │ │
│  └───────────────────────────┴───────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

```bash
npm install
npm run build

# Optional: Install Playwright for JS-rendered pages
npx playwright install chromium
```

## Configuration

Copy `.env.example` to `.env` and customize. All settings have sensible defaults.

See [`.env.example`](.env.example) for the full annotated list. Key sections:

| Section | Variables | Purpose |
|---------|-----------|---------|
| Fetch limits | `MAX_BYTES`, `TIMEOUT_MS`, `MAX_REDIRECTS` | Control request size, timing, redirects |
| Security | `BLOCK_PRIVATE_IP`, `ALLOWLIST_DOMAINS`, `RATE_LIMIT_PER_HOST` | SSRF protection, domain filtering, rate limiting |
| Processing | `DEFAULT_MAX_TOKENS`, `CHUNK_MARGIN_RATIO`, `RESPECT_ROBOTS` | Chunking/compaction defaults |
| Features | `PLAYWRIGHT_ENABLED`, `PDF_ENABLED` | Toggle optional capabilities |
| Caching | `CACHE_TTL_S` | In-memory resource cache TTL (default: 300s) |
| Rendering | `RENDER_BLOCK_THIRD_PARTY`, `RENDER_TIMEOUT_MS`, `USER_AGENT` | Browser rendering settings |
| AI Gateway | `CF_AI_GATEWAY_ENDPOINT`, `CF_AIG_TOKEN`, `CF_AI_GATEWAY_MODEL` | LLM-powered compaction |
| AI Search | `AI_SEARCH_ENABLED`, `CF_ACCOUNT_ID`, `CF_R2_BUCKET`, ... | Cloudflare AI Search ingestion |
| AI Search Scoping | `AI_SEARCH_SCOPE`, `WEB_FETCH_THREAD_KEY`, `AI_SEARCH_STATE_DIR` | Conversation/workspace isolation |

## MCP Tools

### 1. `fetch(url|raw_bytes, options)`

Fetch and extract content from a URL or raw bytes.

**Top-level input:**
- `url`: URL to fetch
- `raw_bytes`: Base64-encoded raw content to normalize instead of fetching
- `content_type`: MIME type for `raw_bytes`
- `canonical_url`: Canonical URL for `raw_bytes`

**Options:**
- `mode`: `"auto" | "http" | "render"` — Fetch mode (render uses Playwright)
- `headers`: Custom HTTP headers
- `timeout_ms`: Request timeout
- `max_bytes`: Maximum response size
- `render`: Browser rendering options
  - `wait_until`: `"load" | "domcontentloaded" | "networkidle"`
  - `wait_ms`: Additional wait time
  - `block_third_party`: Block tracking requests
  - `screenshot`: Capture screenshot
  - `selector`: Wait for specific element
- `extraction`: Content extraction options
  - `prefer_readability`: Use Mozilla Readability
  - `keep_tables`: Preserve table content
  - `keep_code_blocks`: Preserve code blocks
  - `remove_selectors`: CSS selectors to remove
- `cache_ttl_s`: Cache TTL in seconds for the HTTP fetch (set to 0 to disable)
- `format`: Output format options
  - `output`: `"llm_packet" | "raw" | "normalized"`
  - `include_raw_excerpt`: Include raw HTML snippet
- `ai_search`: Cloudflare AI Search ingestion options
  - `enabled`: Upload extracted content to R2 for AI Search indexing
  - `thread_key`: Conversation/thread identifier for scoping
  - `prefix`: Optional R2 key prefix
  - `max_file_bytes`: Per-file byte cap before splitting
  - `wait_ms`: Delay before running AI Search query (indexes asynchronously)
  - `skip_if_exists`: Skip upload if content already exists in R2
  - `require_success`: Fail the fetch tool if upload or query fails
  - `query`: Optional AI Search query (REST API)
    - `query`: Query string
    - `mode`: `"search" | "ai_search"` (retrieval only or retrieval+generation)
    - `rewrite_query`, `max_num_results`, `ranking_options`, `reranking`, `filters`, `model`, `system_prompt`
  - Note: `ai_search` is skipped when `format.output` is `raw`

**Response diagnostics:**
- `request_id`: Unique ID for the fetch request
- `duration_ms`: End-to-end request duration in milliseconds
- `retry_count`: Number of HTTP retries performed

When `success` is false, `error.details` may include `url`, `status_code`, and `retry_after` (from 429 responses).

### 2. `extract(input, options)`

Extract content from raw bytes or URL. Consider using `fetch` instead for the full pipeline (caching, AI Search, diagnostics).

**Input:**
- `url`: URL to fetch and extract
- `raw_bytes`: Base64-encoded raw content
- `content_type`: MIME type of raw_bytes
- `canonical_url`: Canonical URL for citations

### 3. `chunk(packet, options)`

Split content into semantic chunks.

**Options:**
- `max_tokens`: Maximum tokens per chunk
- `margin_ratio`: Safety margin (0-0.5)
- `overlap_tokens`: Approximate token overlap between adjacent chunks
- `strategy`: `"headings_first" | "balanced"`

### 4. `compact(input, options)`

Intelligently compress content. When AI Gateway is configured, `map_reduce` and `question_focused` modes use LLM-powered summarization.

**Options:**
- `max_tokens`: Target output size
- `mode`: Compaction strategy
  - `"structural"`: Remove boilerplate
  - `"salience"`: Keep high-density content
  - `"map_reduce"`: Summarize per-chunk
  - `"question_focused"`: Relevant to question
- `question`: Focus question (for question_focused mode)
- `preserve`: Content types to keep: `["numbers", "dates", "names", "definitions", "procedures"]`

### 5. `ai_search_query(query, options)`

Query the conversation-scoped knowledge base built by `fetch()`. Results are automatically scoped based on `AI_SEARCH_SCOPE` configuration.

**Input:**
- `query`: AI Search query options (auto-scoped)
  - `query`: Query string (required)
  - `mode`: `"search" | "ai_search"`
  - `rewrite_query`: Boolean
  - `max_num_results`: Number
  - `ranking_options`: `{ score_threshold: number }`
  - `reranking`: `{ enabled: boolean, model: string }`
  - `filters`: Additional filter object
  - `model`: Custom model name
  - `system_prompt`: Custom system prompt
- `thread_key`: Override the conversation thread key for this request

## AI Search Scoping

When AI Search is enabled, uploaded content and queries are scoped to prevent cross-conversation leakage. This is configured via environment variables and persisted across server restarts.

### Scope modes

| Mode | Env Value | Behavior |
|------|-----------|----------|
| **Conversation** (default) | `AI_SEARCH_SCOPE=conversation` | Each conversation gets its own isolated namespace via `thread_key` |
| **Workspace** | `AI_SEARCH_SCOPE=workspace` | Shared per workspace (git repo root or `AI_SEARCH_WORKSPACE_ROOT`) |
| **Global** | `AI_SEARCH_SCOPE=global` | No isolation — all content is shared |

### Thread key resolution

The thread key is resolved in order:
1. Per-request `thread_key` parameter (in `ai_search` options)
2. `WEB_FETCH_THREAD_KEY` env var (aliases: `AI_SEARCH_THREAD_KEY`, `MCP_THREAD_KEY`)
3. Auto-generated from workspace if no key is provided

### State persistence

The mapping from `(workspace_id, thread_key)` → `conversation_id` is persisted to `~/.config/web-fetch-mcp/ai-search-state.json` (configurable via `AI_SEARCH_STATE_DIR`). This means conversation scoping survives server restarts.

### R2 prefix structure

Uploads are automatically prefixed based on scope:
- **Global**: `{prefix}/`
- **Workspace**: `{prefix}/workspaces/{workspace_id}/`
- **Conversation**: `{prefix}/workspaces/{workspace_id}/conversations/{conversation_id}/`

## AI Gateway (LLM-Powered Compaction)

When configured, `compact` modes `map_reduce` and `question_focused` use an LLM via Cloudflare AI Gateway for higher-quality summarization.

```bash
CF_AI_GATEWAY_ENDPOINT=https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions
CF_AIG_TOKEN=your_token
CF_AI_GATEWAY_MODEL=your_model
CF_AI_GATEWAY_TIMEOUT_MS=60000
```

The gateway uses OpenAI-compatible chat completions. Without AI Gateway configured, compaction falls back to local heuristic-based processing.

## MCP Prompts

This server exposes prompt templates for user-invoked workflows:

- `fetch_url`: args `url` (required), `mode`, `extraction` (JSON string)
- `fetch_and_chunk`: args `url` (required), `max_tokens`, `strategy`
- `fetch_and_compact`: args `url` (required), `max_tokens`, `mode`, `question`
- `fetch_ai_search`: args `url` (required), `query` (required), `wait_ms`, `mode`
- `ai_search_query`: args `query` (required), `mode`, `thread_key`
- `resources_tips`: no args — guidance on reusing fetched content via MCP resources

Prompts are discoverable via `prompts/list` and retrievable via `prompts/get`.

## MCP Completions

This server supports `completion/complete` to provide argument suggestions for prompts and resource URIs.

Example prompt argument completion:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "completion/complete",
  "params": {
    "ref": { "type": "ref/prompt", "name": "fetch_url" },
    "argument": { "name": "mode", "value": "re" }
  }
}
```

Example resource URI completion (source_id suggestions):

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "completion/complete",
  "params": {
    "ref": { "type": "ref/resource", "uri": "webfetch://packet/{source_id}" },
    "argument": { "name": "source_id", "value": "" }
  }
}
```

## MCP Resources

Recently fetched packets are exposed as MCP resources using a custom `webfetch://` URI scheme. Resources are stored in-memory with TTL controlled by `CACHE_TTL_S` (default: 300s) and are not persisted across restarts.

Resource list entries use `webfetch://packet/{source_id}` and include metadata like title, lastModified, and size. Reads support:

- `webfetch://packet/{source_id}`: Full LLMPacket JSON (`application/json`)
- `webfetch://content/{source_id}`: Markdown content (`text/markdown`)
- `webfetch://normalized/{source_id}`: NormalizedContent JSON (`application/json`)
- `webfetch://screenshot/{source_id}`: Screenshot blob (`image/png`, only if captured)

The server emits `notifications/resources/list_changed` when new resources are stored. Tool, prompt, and resource lists support cursor-based pagination (page size: 50).

## Output Format: LLMPacket

```json
{
  "source_id": "abc123...",
  "original_url": "https://example.com/page",
  "canonical_url": "https://example.com/page",
  "retrieved_at": "2024-01-15T10:30:00Z",
  "status": 200,
  "content_type": "text/html",
  "metadata": {
    "title": "Page Title",
    "author": "John Doe",
    "published_at": "2024-01-10T00:00:00Z",
    "estimated_reading_time_min": 5
  },
  "outline": [
    {"level": 1, "text": "Introduction", "path": "Introduction"},
    {"level": 2, "text": "Background", "path": "Introduction > Background"}
  ],
  "key_blocks": [
    {"block_id": "b0", "kind": "heading", "text": "# Introduction", "char_len": 14},
    {"block_id": "b1", "kind": "paragraph", "text": "Content...", "char_len": 500}
  ],
  "content": "# Introduction\n\nContent in markdown format...",
  "source_summary": [
    "Main topics: Introduction, Background, Results",
    "Key figures: $53m, 700 jobs",
    "Content length: ~2500 words"
  ],
  "unsafe_instructions_detected": [],
  "warnings": [],
  "hashes": {
    "content_hash": "sha256...",
    "raw_hash": "sha256..."
  }
}
```

## Security Features

### SSRF Protection
- Blocks localhost and loopback addresses
- Blocks private IP ranges (10.x, 172.16-31.x, 192.168.x)
- Validates DNS resolution to prevent rebinding attacks
- Only allows http:// and https:// protocols

### Prompt Injection Detection
- Scans for instruction override patterns
- Detects role reassignment attempts
- Identifies fake message delimiters
- Quarantines suspicious content in `unsafe_instructions_detected`

### Rate Limiting
- Per-host request limits
- Exponential backoff on errors
- Respects Retry-After headers

### Content Sanitization
- Removes scripts and styles
- Strips event handlers
- Removes hidden content
- Detects paywalled pages

## Threat Model & Mitigations

| Threat | Mitigation |
|--------|------------|
| SSRF to internal services | Block private IPs, validate DNS resolution |
| DNS rebinding | Re-validate IPs after each redirect |
| Prompt injection in content | Detect and quarantine suspicious patterns |
| Malicious scripts in HTML | Remove all scripts, styles, event handlers |
| Hidden content attacks | Remove display:none and aria-hidden content |
| Resource exhaustion | Enforce max_bytes, timeouts, rate limits |
| Redirect loops | Limit redirect count, track visited URLs |
| Paywall bypass | Detect paywalls, do not attempt bypass |
| CAPTCHA bypass | Return error, do not attempt bypass |
| Browser sandbox escape | Use isolated contexts, block file:// protocol |

## Running Tests

```bash
# Unit tests
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

## File Structure

```
web-fetch-mcp/
├── src/
│   ├── index.ts                  # MCP server entry, tool/prompt/resource registration
│   ├── config.ts                 # Configuration from env vars
│   ├── types.ts                  # TypeScript types
│   ├── completions.ts            # MCP completion/complete handler
│   ├── pagination.ts             # Cursor-based pagination for list endpoints
│   ├── ai-gateway/
│   │   └── client.ts             # Cloudflare AI Gateway (LLM compaction)
│   ├── ai-search/
│   │   ├── index.ts              # R2 upload, AI Search query, content quality gating
│   │   └── state.ts              # Conversation-scope persistence
│   ├── tools/
│   │   ├── fetch.ts              # fetch tool
│   │   ├── fetch-contract.ts     # Fetch input parsing/validation
│   │   ├── extract.ts            # extract tool
│   │   ├── chunk.ts              # chunk tool
│   │   ├── compact.ts            # compact tool
│   │   └── ai-search-query.ts    # ai_search_query tool
│   ├── fetcher/
│   │   ├── http-fetcher.ts       # HTTP fetching (undici)
│   │   ├── browser-renderer.ts   # Playwright rendering
│   │   └── robots.ts             # robots.txt handling
│   ├── extractors/
│   │   ├── html-extractor.ts
│   │   ├── markdown-extractor.ts
│   │   ├── pdf-extractor.ts
│   │   ├── json-extractor.ts
│   │   ├── xml-extractor.ts
│   │   └── text-extractor.ts
│   ├── processing/
│   │   ├── normalizer.ts         # Content normalization, key_blocks, source_summary
│   │   ├── chunker.ts            # Semantic chunking
│   │   ├── compactor.ts          # Content compaction (4 modes)
│   │   ├── outline.ts            # Document outline generation
│   │   └── synonyms.ts           # Synonym expansion for question-focused compaction
│   ├── security/
│   │   ├── ssrf-guard.ts
│   │   ├── injection-detector.ts
│   │   ├── content-sanitizer.ts
│   │   └── rate-limiter.ts
│   ├── resources/
│   │   ├── handlers.ts           # MCP resource read/list handlers
│   │   ├── store.ts              # In-memory resource store with TTL
│   │   └── uri.ts                # webfetch:// URI parsing
│   └── utils/
│       ├── hash.ts
│       ├── url.ts
│       ├── tokens.ts
│       └── cache.ts
├── tests/
│   ├── unit/
│   └── integration/
├── scripts/
│   └── batch-fetch-wp-docs.ts    # Batch document fetcher utility
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
