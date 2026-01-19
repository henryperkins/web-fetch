# web-fetch-mcp

A Model Context Protocol (MCP) server that provides safe, high-signal web browsing and content fetching for LLM agents.

## Features

- **Multi-format support**: HTML, JavaScript-rendered pages (SPA), Markdown, PDF, JSON, RSS/Atom/XML feeds
- **Intelligent extraction**: Uses Readability + Turndown for clean markdown output
- **Security first**: SSRF protection, prompt injection detection, rate limiting
- **LLM-optimized output**: Structured packets with citations, outlines, and metadata
- **Context management**: Semantic chunking and intelligent compaction
- **AI Search ingestion**: Optional Cloudflare R2 uploads for AI Search indexing

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
│  │  fetch() │ extract() │ chunk() │ compact()              │   │
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

Copy `.env.example` to `.env` and customize:

```bash
# Fetch limits
MAX_BYTES=10485760          # 10MB max response
TIMEOUT_MS=30000            # 30s timeout
MAX_REDIRECTS=5

# Security
BLOCK_PRIVATE_IP=true       # SSRF protection
RATE_LIMIT_PER_HOST=60      # Requests per minute

# Features
PLAYWRIGHT_ENABLED=false    # Enable browser rendering
PDF_ENABLED=true            # Enable PDF extraction
RESPECT_ROBOTS=true         # Honor robots.txt

# Processing
DEFAULT_MAX_TOKENS=4000
CHUNK_MARGIN_RATIO=0.10

# Cloudflare AI Search (optional)
AI_SEARCH_ENABLED=false
CF_ACCOUNT_ID=your_account_id
CF_AI_SEARCH_NAME=your_ai_search_name
CF_AI_SEARCH_API_TOKEN=your_api_token
CF_R2_BUCKET=your_r2_bucket
CF_R2_ACCESS_KEY_ID=your_r2_access_key_id
CF_R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
CF_R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
CF_R2_PREFIX=ai-search/
AI_SEARCH_MAX_FILE_BYTES=4194304
AI_SEARCH_QUERY_TIMEOUT_MS=15000
AI_SEARCH_QUERY_WAIT_MS=0
AI_SEARCH_MAX_QUERY_WAIT_MS=15000
```

## MCP Tools

### 1. `fetch(url, options)`

Fetch and extract content from a URL.

**Options:**
- `mode`: `"auto" | "http" | "render"` - Fetch mode (render uses Playwright)
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
  - `prefix`: Optional R2 key prefix
  - `max_file_bytes`: Per-file byte cap before splitting
  - `wait_ms`: Optional delay before running AI Search query (note: AI Search indexes asynchronously, so immediate queries after upload may not include new content)
  - `skip_if_exists`: Skip upload if the first part exists
  - `require_success`: Fail the fetch tool if upload or query fails
  - `query`: Optional AI Search query (REST API)
    - `query`: Query string
    - `mode`: `"search" | "ai_search"` (retrieval only or retrieval+generation)
    - `rewrite_query`, `max_num_results`, `ranking_options`, `reranking`, `filters`, `model`, `system_prompt`
  - Note: `ai_search` is skipped when `format.output` is `raw`

### 2. `extract(input, options)`

Extract content from raw bytes or URL.

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
- `strategy`: `"headings_first" | "balanced"`

### 4. `compact(input, options)`

Intelligently compress content.

**Options:**
- `max_tokens`: Target output size
- `mode`: Compaction strategy
  - `"structural"`: Remove boilerplate
  - `"salience"`: Keep high-density content
  - `"map_reduce"`: Summarize per-chunk
  - `"question_focused"`: Relevant to question
- `question`: Focus question (for question_focused mode)
- `preserve`: Content types to keep: `["numbers", "dates", "names", "definitions", "procedures"]`

## MCP Prompts

This server exposes static prompt templates for user-invoked workflows:

- `fetch_url`: args `url` (required), `mode`, `extraction` (JSON string)
- `fetch_and_chunk`: args `url` (required), `max_tokens`, `strategy`
- `fetch_and_compact`: args `url` (required), `max_tokens`, `mode`, `question`
- `fetch_ai_search`: args `url` (required), `query` (required), `wait_ms`, `mode`

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

This server exposes recently fetched packets as MCP resources using a custom `webfetch://` URI scheme. Resources are stored in-memory (TTL follows `CACHE_TTL_S`), so they are not persisted across restarts.

Resource list entries use `webfetch://packet/{source_id}` and include metadata like title, lastModified, and size. Reads support:

- `webfetch://packet/{source_id}`: Full LLMPacket JSON (`application/json`)
- `webfetch://content/{source_id}`: Markdown content (`text/markdown`)
- `webfetch://normalized/{source_id}`: NormalizedContent JSON (`application/json`)
- `webfetch://screenshot/{source_id}`: Screenshot blob (`image/png`, only if captured)

The server emits `notifications/resources/list_changed` when new resources are stored.

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
    "Key numbers mentioned: 42%, $1.5M",
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

## Usage Examples

### Basic HTML Fetch

```javascript
// Fetch an article
const result = await mcp.callTool('fetch', {
  url: 'https://example.com/article',
  options: {
    mode: 'http'
  }
});

console.log(result.packet.content);
console.log(result.packet.metadata.title);
```

### JavaScript-Rendered Page

```javascript
// Fetch a SPA page
const result = await mcp.callTool('fetch', {
  url: 'https://spa-site.com/page',
  options: {
    mode: 'render',
    render: {
      wait_until: 'networkidle',
      wait_ms: 2000,
      screenshot: true
    }
  }
});
```

### PDF Extraction

```javascript
// Fetch and extract PDF
const result = await mcp.callTool('fetch', {
  url: 'https://example.com/document.pdf',
  options: {
    mode: 'http'
  }
});

// result.packet.metadata.page_count
// result.packet.content contains extracted text
```

### Chunking for Context Limits

```javascript
// First fetch
const fetchResult = await mcp.callTool('fetch', {
  url: 'https://example.com/long-article'
});

// Then chunk for 4K context
const chunkResult = await mcp.callTool('chunk', {
  packet: fetchResult.packet,
  options: {
    max_tokens: 4000,
    strategy: 'headings_first'
  }
});

// Process chunks
for (const chunk of chunkResult.chunks.chunks) {
  console.log(`Chunk ${chunk.chunk_index}: ${chunk.headings_path}`);
  // Use chunk.text for processing
}
```

### Question-Focused Compaction

```javascript
// Fetch content
const fetchResult = await mcp.callTool('fetch', {
  url: 'https://example.com/research-paper'
});

// Compact focused on a question
const compactResult = await mcp.callTool('compact', {
  input: fetchResult.packet,
  options: {
    max_tokens: 1000,
    mode: 'question_focused',
    question: 'What are the main findings of this research?',
    preserve: ['numbers', 'dates', 'names']
  }
});

console.log(compactResult.compacted.summary);
console.log(compactResult.compacted.key_points);
```

### Fetch + AI Search upload

```javascript
const result = await mcp.callTool('fetch', {
  url: 'https://example.com/guide',
  options: {
    mode: 'http',
    ai_search: {
      enabled: true,
      prefix: 'docs/',
      query: {
        query: 'pricing limits',
        mode: 'search',
        max_num_results: 5
      }
    }
  }
});

console.log(result.ai_search);
```

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

# Integration tests (requires network)
npm test -- --testPathPattern=integration

# Coverage
npm run test:coverage
```

## File Structure

```
web-fetch-mcp/
├── src/
│   ├── index.ts              # MCP server entry
│   ├── config.ts             # Configuration
│   ├── types.ts              # TypeScript types
│   ├── ai-search/
│   │   └── index.ts           # Cloudflare AI Search ingestion
│   ├── tools/
│   │   ├── fetch.ts          # fetch tool
│   │   ├── extract.ts        # extract tool
│   │   ├── chunk.ts          # chunk tool
│   │   └── compact.ts        # compact tool
│   ├── fetcher/
│   │   ├── http-fetcher.ts   # HTTP fetching
│   │   ├── browser-renderer.ts # Playwright
│   │   └── robots.ts         # robots.txt
│   ├── extractors/
│   │   ├── html-extractor.ts
│   │   ├── markdown-extractor.ts
│   │   ├── pdf-extractor.ts
│   │   ├── json-extractor.ts
│   │   ├── xml-extractor.ts
│   │   └── text-extractor.ts
│   ├── processing/
│   │   ├── normalizer.ts
│   │   ├── chunker.ts
│   │   ├── compactor.ts
│   │   └── outline.ts
│   ├── security/
│   │   ├── ssrf-guard.ts
│   │   ├── injection-detector.ts
│   │   ├── content-sanitizer.ts
│   │   └── rate-limiter.ts
│   └── utils/
│       ├── hash.ts
│       ├── url.ts
│       ├── tokens.ts
│       └── cache.ts
├── tests/
│   ├── unit/
│   └── integration/
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
