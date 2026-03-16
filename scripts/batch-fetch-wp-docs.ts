#!/usr/bin/env tsx
/**
 * Batch fetch and index WordPress developer docs into Cloudflare AI Search.
 *
 * Discovers all URLs from the WordPress developer docs sitemaps,
 * fetches each page, extracts clean markdown, and uploads to R2
 * for Cloudflare AutoRAG indexing.
 *
 * Usage:
 *   npx tsx scripts/batch-fetch-wp-docs.ts [options]
 *
 * Options:
 *   --profile <name>     Content profile (default: essential)
 *                          guides    — handbooks, tutorials, CLI docs only (~1,500 URLs)
 *                          essential — guides + functions + hooks + public classes (~7,500 URLs)
 *                          full      — everything, no filtering (~12,800 URLs)
 *   --concurrency <n>    Concurrent fetches (default: 10)
 *   --delay-ms <ms>      Per-worker delay between requests (default: 200)
 *   --resume             Resume from previous state file
 *   --dry-run            Discover URLs only, don't fetch
 *   --filter <pattern>   Only process URLs containing this string
 *   --limit <n>          Max URLs to process in this run
 *   --retry-failed       Retry previously failed URLs
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { resetConfig } from '../src/config.js';
import { executeFetch } from '../src/tools/fetch.js';

// ---------------------------------------------------------------------------
// Force global AI Search scope so docs land in a shared, query-able namespace
// (not scoped per-conversation). Must be set before config is first loaded.
// ---------------------------------------------------------------------------
process.env['AI_SEARCH_SCOPE'] = 'global';
resetConfig();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SITEMAP_INDEX_URL = 'https://developer.wordpress.org/sitemap-index-1.xml';
const STATE_FILE = path.join(import.meta.dirname ?? process.cwd(), '.wp-docs-state.json');
const AI_SEARCH_PREFIX = 'wp-dev-docs/';
const BATCH_USER_AGENT = 'web-fetch-mcp-batch/1.0 (WordPress dev docs indexer)';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    'profile':      { type: 'string',  default: 'essential' },
    'concurrency':  { type: 'string',  default: '10' },
    'delay-ms':     { type: 'string',  default: '200' },
    'resume':       { type: 'boolean', default: false },
    'dry-run':      { type: 'boolean', default: false },
    'filter':       { type: 'string' },
    'limit':        { type: 'string' },
    'retry-failed': { type: 'boolean', default: false },
  },
});

const PROFILE       = args['profile'] as 'guides' | 'essential' | 'full';
const CONCURRENCY   = Math.max(1, parseInt(args['concurrency']!, 10));
const DELAY_MS      = parseInt(args['delay-ms']!, 10);
const RESUME        = args['resume']!;
const DRY_RUN       = args['dry-run']!;
const FILTER        = args['filter'];
const LIMIT         = args['limit'] ? parseInt(args['limit'], 10) : undefined;
const RETRY_FAILED  = args['retry-failed']!;

// Bump the internal rate limiter to accommodate concurrent workers.
// Each worker does ~1 req/sec, so N workers ≈ N*60 req/min.
process.env['RATE_LIMIT_PER_HOST'] = String(Math.max(60, CONCURRENCY * 80));
resetConfig();

// ---------------------------------------------------------------------------
// Profile-based URL filtering
// ---------------------------------------------------------------------------

// Internal library class prefixes — never useful for WP plugin/theme developers
const EXCLUDED_CLASS_PREFIXES = [
  // HTTP Requests library (old and new namespace)
  'requests_', 'requests-', 'wporg-requests-', 'wporg_requests_',
  // RSS/Feed parsing
  'simplepie', 'wp_simplepie_',
  // XML-RPC library
  'ixr_',
  // Email
  'pop3', 'phpmailer', 'smtp',
  // Archive/compression
  'pclzip',
  // Diff engine
  'text_diff',
  // Legacy HTTP
  'snoopy',
  // FTP
  'ftp_base', 'ftp_pure', 'ftp_sockets', 'ftp ',
  // Atom publishing (legacy)
  'atomparser', 'atomfeed', 'atomentry', 'atomcategory',
  // getID3 (media metadata — internals)
  'getid3',
  // Sodium compat (crypto polyfill internals)
  'paragonie_sodium_',
];

// Deprecated Customizer classes
const DEPRECATED_CLASS_PREFIXES = [
  'wp_customize_',
];

// Internal WP classes whose individual methods are rarely needed
const INTERNAL_CLASS_PREFIXES = [
  // HTML parser internals (keep wp_html_tag_processor, skip internal data structures)
  'wp_html_token', 'wp_html_span', 'wp_html_text_replacement',
  'wp_html_attribute_token', 'wp_html_open_elements',
  'wp_html_active_formatting_elements', 'wp_html_stack_event',
  'wp_html_processor_state', 'wp_html_decoder',
  'wp_html_unsupported_exception',
  // Duotone internals
  'wp_duotone',
  // Navigation fallback internals
  'wp_classic_to_block_menu_converter',
  // Locale switcher internals
  'wp_locale_switcher',
  // Translation file internals
  'wp_translation_file', 'noop_translations', 'mo', 'po',
  // Upgrader internals
  'wp_upgrader', 'plugin_upgrader', 'theme_upgrader', 'core_upgrader',
  'language_pack_upgrader', 'wp_automatic_updater',
  'plugin_installer_skin', 'theme_installer_skin',
  'bulk_upgrader_skin', 'bulk_plugin_upgrader_skin',
  'bulk_theme_upgrader_skin', 'wp_upgrader_skin',
  'automatic_upgrader_skin',
  // List table internals (admin UI plumbing)
  'wp_posts_list_table', 'wp_comments_list_table', 'wp_terms_list_table',
  'wp_media_list_table', 'wp_links_list_table', 'wp_users_list_table',
  'wp_plugins_list_table', 'wp_themes_list_table', 'wp_ms_sites_list_table',
  'wp_ms_users_list_table', 'wp_ms_themes_list_table',
  'wp_plugin_install_list_table', 'wp_theme_install_list_table',
  'wp_privacy_requests_table',
  // Filesystem internals
  'wp_filesystem_ftpext', 'wp_filesystem_ftpsockets',
  'wp_filesystem_ssh2', 'wp_filesystem_direct',
  // Image editor internals
  'wp_image_editor_gd', 'wp_image_editor_imagick',
  // Recovery mode internals
  'wp_recovery_mode', 'wp_recovery_mode_',
  // Sitemaps internals
  'wp_sitemaps_',
  // Metadata lazyloader
  'wp_metadata_lazyloader',
  // Textdomain registry
  'wp_textdomain_registry',
  // Network query internals
  'wp_network_query', 'wp_network ',
];

function extractClassName(url: string): string | null {
  const match = url.match(/\/reference\/classes\/([^/]+)\//);
  return match ? match[1]!.toLowerCase() : null;
}

/** Returns true if URL is a class method page (has class + method segments). */
function isClassMethodPage(url: string): boolean {
  const match = url.match(/\/reference\/classes\/([^/]+)\/([^/]+)\//);
  return match !== null;
}

function isExcludedClass(className: string): boolean {
  return EXCLUDED_CLASS_PREFIXES.some(p => className.startsWith(p));
}

function isDeprecatedClass(className: string): boolean {
  return DEPRECATED_CLASS_PREFIXES.some(p => className.startsWith(p));
}

function isInternalClass(className: string): boolean {
  return INTERNAL_CLASS_PREFIXES.some(p => className.startsWith(p));
}

type Profile = 'guides' | 'essential' | 'full';

function applyProfile(urls: string[], profile: Profile): { kept: string[]; excluded: number; breakdown: Record<string, number> } {
  if (profile === 'full') {
    return { kept: urls, excluded: 0, breakdown: {} };
  }

  const breakdown: Record<string, number> = {};
  const inc = (reason: string) => { breakdown[reason] = (breakdown[reason] ?? 0) + 1; };

  const kept = urls.filter(url => {
    const pathname = new URL(url).pathname;

    // guides profile: skip all /reference/ pages
    if (profile === 'guides') {
      if (pathname.startsWith('/reference/')) {
        inc('code-reference');
        return false;
      }
      return true;
    }

    // essential profile: keep functions + hooks, filter classes aggressively
    if (pathname.startsWith('/reference/classes/')) {
      const cls = extractClassName(url);
      if (!cls) return true;

      // Always exclude internal library classes (overview + methods)
      if (isExcludedClass(cls)) {
        inc('internal-library');
        return false;
      }
      if (isDeprecatedClass(cls)) {
        inc('deprecated-customizer');
        return false;
      }
      if (isInternalClass(cls)) {
        inc('internal-class');
        return false;
      }

      // For remaining classes: keep overview pages, skip individual method pages.
      // The class overview lists all methods with signatures — that's enough for search.
      // Individual method pages are granular detail that bloats the index.
      if (isClassMethodPage(url)) {
        inc('class-method-pages');
        return false;
      }
    }

    // Skip classic themes in essential (block themes are the modern standard)
    if (pathname.startsWith('/themes/classic-themes/')) {
      inc('classic-themes');
      return false;
    }

    return true;
  });

  return { kept, excluded: urls.length - kept.length, breakdown };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface FailEntry {
  error: string;
  attempts: number;
  last_attempt: string;
}

interface BatchState {
  started_at: string;
  last_updated_at: string;
  total_discovered: number;
  completed: string[];
  failed: Record<string, FailEntry>;
}

async function loadState(): Promise<BatchState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as BatchState;
  } catch {
    return {
      started_at: new Date().toISOString(),
      last_updated_at: new Date().toISOString(),
      total_discovered: 0,
      completed: [],
      failed: {},
    };
  }
}

async function saveState(state: BatchState): Promise<void> {
  state.last_updated_at = new Date().toISOString();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Sitemap discovery
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

async function fetchXml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': BATCH_USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function discoverUrls(): Promise<string[]> {
  console.log('Fetching sitemap index...');
  const indexXml = await fetchXml(SITEMAP_INDEX_URL);
  const indexDoc = xmlParser.parse(indexXml);

  // sitemap-index-1.xml is a <sitemapindex> with <sitemap> children
  const sitemaps = indexDoc['sitemapindex']?.['sitemap'];
  if (!sitemaps) throw new Error('No <sitemap> entries in sitemap index');

  const sitemapList: Array<{ loc: string }> = Array.isArray(sitemaps) ? sitemaps : [sitemaps];
  const sitemapUrls = sitemapList.map(s => s.loc).filter(Boolean);
  console.log(`Found ${sitemapUrls.length} child sitemaps\n`);

  const allUrls: string[] = [];

  for (const smUrl of sitemapUrls) {
    process.stdout.write(`  ${smUrl} ... `);
    const xml = await fetchXml(smUrl);
    const doc = xmlParser.parse(xml);

    const entries = doc['urlset']?.['url'];
    if (!entries) { console.log('0 URLs'); continue; }

    const list: Array<{ loc: string }> = Array.isArray(entries) ? entries : [entries];
    const locs = list.map(e => e.loc).filter(Boolean);
    allUrls.push(...locs);
    console.log(`${locs.length} URLs`);
  }

  const unique = [...new Set(allUrls)].sort();
  console.log(`\nTotal unique URLs: ${unique.length}`);
  return unique;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem}s`;
}

function eta(processed: number, total: number, elapsedMs: number): string {
  if (processed === 0) return '?';
  const perUrl = elapsedMs / processed;
  const remaining = (total - processed) * perUrl;
  return formatDuration(remaining);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== WordPress Developer Docs Batch Fetcher ===\n');
  console.log(`  profile:      ${PROFILE}`);
  console.log(`  concurrency:  ${CONCURRENCY}`);
  console.log(`  delay-ms:     ${DELAY_MS} (per worker)`);
  console.log(`  resume:       ${RESUME}`);
  console.log(`  dry-run:      ${DRY_RUN}`);
  console.log(`  retry-failed: ${RETRY_FAILED}`);
  if (FILTER) console.log(`  filter:       ${FILTER}`);
  if (LIMIT)  console.log(`  limit:        ${LIMIT}`);
  console.log(`  ai-search:    prefix="${AI_SEARCH_PREFIX}", scope=global`);
  console.log(`  state-file:   ${STATE_FILE}`);
  console.log();

  // 1. Discover URLs
  let allUrls = await discoverUrls();

  // 2. Apply profile filtering
  const { kept, excluded, breakdown } = applyProfile(allUrls, PROFILE);
  if (excluded > 0) {
    console.log(`\nProfile "${PROFILE}" excluded ${excluded} URLs:`);
    for (const [reason, count] of Object.entries(breakdown).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason.padEnd(30)} -${count}`);
    }
    console.log(`Remaining: ${kept.length} URLs`);
  }
  allUrls = kept;

  if (FILTER) {
    allUrls = allUrls.filter(url => url.includes(FILTER));
    console.log(`After filter "${FILTER}": ${allUrls.length} URLs`);
  }

  // 3. Dry run — just show stats
  if (DRY_RUN) {
    const groups: Record<string, number> = {};
    for (const url of allUrls) {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      const key = parts.length >= 2 ? `/${parts[0]}/${parts[1]}/` : `/${parts[0] ?? ''}/`;
      groups[key] = (groups[key] ?? 0) + 1;
    }

    console.log('\nURL groups:');
    for (const [pattern, count] of Object.entries(groups).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${pattern.padEnd(45)} ${count}`);
    }
    console.log(`\nTotal: ${allUrls.length} URLs`);
    return;
  }

  // 4. Load / initialize state
  const state = RESUME ? await loadState() : {
    started_at: new Date().toISOString(),
    last_updated_at: new Date().toISOString(),
    total_discovered: allUrls.length,
    completed: [] as string[],
    failed: {} as Record<string, FailEntry>,
  };
  state.total_discovered = allUrls.length;

  // 5. Determine pending set
  const completedSet = new Set(state.completed);
  let pending = allUrls.filter(url => !completedSet.has(url));

  // When retrying, include previously failed URLs; otherwise skip them
  if (!RETRY_FAILED) {
    const failedSet = new Set(Object.keys(state.failed));
    pending = pending.filter(url => !failedSet.has(url));
  }

  if (LIMIT) {
    pending = pending.slice(0, LIMIT);
  }

  console.log(`\nPending:   ${pending.length}`);
  console.log(`Completed: ${completedSet.size}`);
  console.log(`Failed:    ${Object.keys(state.failed).length}`);

  if (pending.length === 0) {
    console.log('\nNothing to do.');
    return;
  }

  // 6. Process (concurrent worker pool)
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let nextIndex = 0;
  const batchStart = Date.now();

  // Graceful shutdown
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) process.exit(1); // second ctrl-c = force quit
    console.log('\n\nInterrupted — finishing in-flight requests and saving state...');
    interrupted = true;
  };
  process.on('SIGINT', onSigint);

  // Debounced state saving — write at most once per 5 seconds
  let lastSaveTime = Date.now();
  const maybeSaveState = async () => {
    const now = Date.now();
    if (now - lastSaveTime >= 5000) {
      lastSaveTime = now;
      await saveState(state);
    }
  };

  // Periodic progress line
  const progressInterval = setInterval(() => {
    const done = processed;
    if (done === 0) return;
    const pct = ((done / pending.length) * 100).toFixed(1);
    const elapsed = Date.now() - batchStart;
    const etaStr = eta(done, pending.length, elapsed);
    const rps = (done / (elapsed / 1000)).toFixed(1);
    console.log(`--- Progress: ${done}/${pending.length} (${pct}%) | ${rps} req/s | OK ${succeeded} FAIL ${failed} | ETA ${etaStr} ---`);
  }, 10000);

  async function processUrl(url: string): Promise<void> {
    const t0 = Date.now();
    const shortUrl = url.replace('https://developer.wordpress.org', '');

    try {
      const result = await executeFetch({
        options: {
          url,
          mode: 'http',
          user_agent: BATCH_USER_AGENT,
          extraction: {
            prefer_readability: true,
            keep_tables: true,
            keep_code_blocks: true,
          },
          ai_search: {
            enabled: true,
            prefix: AI_SEARCH_PREFIX,
            skip_if_exists: true,
          },
          cache_ttl_s: 0,
        },
      });

      const elapsed = formatDuration(Date.now() - t0);

      if (result.success) {
        const ai = result.ai_search;
        const status = ai?.skipped_existing ? 'exists' : ai?.uploaded ? 'uploaded' : 'no-ai';
        console.log(`  OK ${status.padEnd(8)} (${elapsed.padStart(4)}) ${shortUrl}`);

        state.completed.push(url);
        delete state.failed[url];
        succeeded++;
      } else {
        const code = result.error?.code ?? 'UNKNOWN';
        const msg = result.error?.message ?? '';
        console.log(`  FAIL ${code} (${elapsed.padStart(4)}) ${shortUrl} — ${msg.slice(0, 60)}`);

        const prev = state.failed[url];
        state.failed[url] = {
          error: `${code}: ${msg}`,
          attempts: (prev?.attempts ?? 0) + 1,
          last_attempt: new Date().toISOString(),
        };
        failed++;
      }
    } catch (err) {
      const elapsed = formatDuration(Date.now() - t0);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ERR  (${elapsed.padStart(4)}) ${shortUrl} — ${msg.slice(0, 60)}`);

      const prev = state.failed[url];
      state.failed[url] = {
        error: msg,
        attempts: (prev?.attempts ?? 0) + 1,
        last_attempt: new Date().toISOString(),
      };
      failed++;
    }

    processed++;
    await maybeSaveState();
  }

  // Worker pool — each worker grabs the next URL, processes it, delays, repeats
  async function worker(): Promise<void> {
    while (!interrupted) {
      const idx = nextIndex++;
      if (idx >= pending.length) return;
      await processUrl(pending[idx]!);
      if (!interrupted && DELAY_MS > 0) {
        await new Promise(r => setTimeout(r, DELAY_MS));
      }
    }
  }

  console.log(`\nStarting ${CONCURRENCY} workers...\n`);
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker())
  );

  clearInterval(progressInterval);
  process.removeListener('SIGINT', onSigint);

  // 7. Final save + summary
  await saveState(state);

  const totalElapsed = formatDuration(Date.now() - batchStart);
  console.log('\n=== Summary ===');
  console.log(`  Processed:       ${processed} in ${totalElapsed}`);
  console.log(`  Succeeded:       ${succeeded}`);
  console.log(`  Failed:          ${failed}`);
  console.log(`  Total completed: ${state.completed.length} / ${state.total_discovered}`);
  console.log(`  Total failed:    ${Object.keys(state.failed).length}`);

  if (Object.keys(state.failed).length > 0) {
    console.log('\nRecent failures:');
    const entries = Object.entries(state.failed)
      .sort((a, b) => b[1].last_attempt.localeCompare(a[1].last_attempt))
      .slice(0, 10);
    for (const [fUrl, info] of entries) {
      console.log(`  ${fUrl}`);
      console.log(`    ${info.error.slice(0, 100)} (${info.attempts} attempts)`);
    }
  }

  console.log(`\nState: ${STATE_FILE}`);
  console.log('Run with --resume to continue, --retry-failed to reattempt failures.');
}

main().catch(err => {
  console.error('\nFatal:', err);
  process.exit(1);
});
