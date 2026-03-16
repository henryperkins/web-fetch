# Web-Fetch MCP Evaluation

Date: 2026-01-23

## Scope

Direct tests of the `web-fetch` MCP server tools (fetch/extract/chunk/compact/ai_search/resources) against a variety of content types, error paths, and options. Evaluation is aligned to the provided criteria.

## Test Matrix (Representative Calls)

- HTML fetch with readability and `remove_selectors` (example.com)
- JSON fetch (jsonplaceholder.typicode.com/todos/1)
- PDF fetch (W3C dummy.pdf)
- RSS/XML fetch (hnrss.org/frontpage)
- Rendered fetch with screenshot (example.com, render mode)
- Robots enforcement and override (reddit search and robots.txt)
- Size limit error (`max_bytes` with httpbin bytes)
- SSRF and protocol guardrails (127.0.0.1 and file://)
- Extract from raw bytes (inline HTML)
- `read_mcp_resource` for content/packet/normalized/screenshot
- `chunk` with small `max_tokens`
- `compact` in `question_focused` and `map_reduce`
- `ai_search_query` in semantic mode
- `list_mcp_resources` after fetches
- JS-heavy SPA render vs non-render (spa5.scrape.center, `render.selector`)
- Robots allow/deny with httpbin (`/get` allowed, `/deny` disallowed)
- Prompt-injection detection via `extract` on crafted HTML

## Findings by Criteria

### 1) Functionality and Design

- Clear purpose and good task coverage: `fetch` produces a rich packet (outline/key_blocks/hashes), `extract` does the same from raw bytes, and `read_mcp_resource` provides consistent access via `webfetch://` URIs.
- Multi-format handling works: HTML, JSON, PDF, and RSS were all normalized into useful markdown, with metadata and warnings where appropriate.
- PDF extraction is cautious and informative: low-confidence warnings (`scanned_pdf`, `extraction_fallback`) surfaced clearly.
- JSON normalization adds structured summaries and a sample block, which is helpful for downstream use.
- Render mode returns a screenshot (inline base64 and a `webfetch://screenshot/...` resource) and retains the normalized content.
- `remove_selectors` behaves predictably: removing `h1` produced no outline and only paragraph key blocks for example.com.

### 2) Interface and Usability

- Parameters are intuitive and scoped: `url`, `options.format`, `options.extraction`, `respect_robots`, `cache_ttl_s`, `max_bytes`, `render`.
- Output schema is consistent across content types (packet + metadata + hashes + warnings).
- Resources are easy to navigate: `webfetch://packet/...`, `webfetch://content/...`, `webfetch://normalized/...`, `webfetch://screenshot/...`.
- `ai_search` appears enabled by default (uploads occurred without explicit opt-in); should be documented clearly.
- Robots enforcement blocks `https://www.reddit.com/robots.txt` itself when `respect_robots=true`, which is surprising for debugging.

### 3) Reliability and Performance

- Error handling is strong and actionable:
  - `SSRF_BLOCKED` for private IPs.
  - `INVALID_PROTOCOL` for `file://`.
  - `CONTENT_TOO_LARGE` for `max_bytes` limits.
  - `ROBOTS_BLOCKED` when disallowed by robots.txt.
- Caching behavior is opaque: repeated fetches with `cache_ttl_s` returned stable `source_id`/hashes but `retrieved_at` changed; there is no `from_cache` indicator.
- Render mode returns a very large response due to inline screenshot base64; response size can be heavy without a toggle.

### 4) Security and Privacy

- Strong default safety controls:
  - Private IPs blocked.
  - Non-http(s) blocked.
  - Robots enforcement active when requested.
  - Size limits enforced.
- `unsafe_instructions_detected` and `warnings` fields exist in packets (good for prompt-injection visibility).
- Respecting robots is good, but the inability to fetch robots.txt itself when blocked is a usability edge case.

### 5) Integration and Compatibility

- Clean URI scheme for cached resources; `read_mcp_resource` works reliably.
- `list_mcp_resources` lists stored packets with metadata and timestamps; helpful for cache introspection.
- Outputs are chainable: `fetch` -> `read` -> `chunk`/`compact` works without additional parsing.
- `ai_search_query` is workspace-scoped and can return unrelated results without additional filters.

### 6) Developer Experience and Governance

- Observability is minimal (no trace IDs or timing info). Hashes help, but cache hits are not indicated.
- Versioning/ownership is not discoverable from tool outputs.
- Debugging is decent via warnings and error codes; otherwise no structured diagnostics.

## Quality Observations (Tool-Specific)

- `chunk` with `max_tokens=20` split `Section C` mid-sentence into two chunks, despite `heading-aware` strategy. It respects headings but does not guarantee sentence integrity.
- `compact` with `question_focused` kept unrelated headings and truncated the target content; the focus quality is weaker than expected.
- `compact` with `map_reduce` returned an empty summary/key_points from non-empty chunks. This is likely a bug or undocumented requirement.
- `respect_robots=false` allowed a fetch of Reddit but the returned content indicated network security blocking. This surfaced as normal content, not a structured error.

## Strengths

- Broad, deterministic normalization across formats.
- Strong safety defaults and explicit error codes.
- Composable resource URIs and consistent packet schema.
- Useful warnings for low-confidence extraction (PDF).
- Prompt-injection detection flags suspicious content with explicit reasons and warnings.

## Gaps and Risks

- `map_reduce` compaction can return empty output on valid input.
- Cache hits are not transparent (`from_cache` is absent).
- Robots enforcement blocks direct access to robots.txt itself.
- AI Search relevance is broad without explicit filtering; results can be unexpected.
- Render mode embeds large base64 payloads by default, increasing response size.
- Non-render extraction can fail for JS-heavy SPAs while render succeeds; requires clear guidance.

## Recommendations

- Add an explicit cache indicator (`from_cache`, `cache_age_ms`).
- Clarify or fix `compact` `map_reduce` behavior.
- Allow robots.txt fetch even when robots blocks the target (or provide a way to bypass for robots.txt only).
- Provide optional toggles for inline screenshot payloads.
- Add guidance for `ai_search` scoping and filters in tool documentation.

## Repro Notes (Selected Outputs)

- SSRF block: `SSRF_BLOCKED` for `http://127.0.0.1:1`.
- Protocol guard: `INVALID_PROTOCOL` for `file:///etc/passwd`.
- Size limit: `CONTENT_TOO_LARGE` for `https://httpbin.org/bytes/2048` with `max_bytes=1024`.
- Robots: `ROBOTS_BLOCKED` for `https://www.reddit.com/robots.txt` and `https://www.reddit.com/search?q=tarot` when `respect_robots=true`.
- Robots override: `respect_robots=false` returned content indicating network security blocking.
- Render screenshot: screenshot accessible via `webfetch://screenshot/<source_id>`.
- Robots allow/deny (httpbin): `robots.txt` disallows `/deny`; `https://httpbin.org/deny` blocked with `respect_robots=true`, allowed with `respect_robots=false`; `https://httpbin.org/get` allowed.
- JS-heavy SPA: `https://spa5.scrape.center/` with `mode=http` returned `EXTRACTION_FAILED`; `mode=render` + `render.selector=#app` succeeded with content.
- Prompt-injection detection: crafted HTML flagged 5 patterns with `warnings: injection_detected` and populated `unsafe_instructions_detected`.
