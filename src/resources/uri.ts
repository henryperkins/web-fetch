export type ResourceKind = 'packet' | 'content' | 'normalized' | 'screenshot';

const RESOURCE_SCHEME = 'webfetch:';
const RESOURCE_KINDS: ReadonlySet<string> = new Set([
  'packet',
  'content',
  'normalized',
  'screenshot',
]);

export function buildResourceUri(kind: ResourceKind, sourceId: string): string {
  return `webfetch://${kind}/${encodeURIComponent(sourceId)}`;
}

export function buildResourceUriTemplate(kind: ResourceKind, paramName = 'source_id'): string {
  return `webfetch://${kind}/{${paramName}}`;
}

export function parseResourceUri(uri: string): { kind: ResourceKind; sourceId: string } | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== RESOURCE_SCHEME) return null;
    if (parsed.username || parsed.password || parsed.port) return null;
    if (parsed.search || parsed.hash) return null;

    const kind = parsed.hostname;
    if (!RESOURCE_KINDS.has(kind)) return null;

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return null;

    const sourceId = decodeURIComponent(parts[0] || '');
    if (!sourceId) return null;

    return { kind: kind as ResourceKind, sourceId };
  } catch {
    return null;
  }
}
