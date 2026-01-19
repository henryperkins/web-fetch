import type { Resource, ResourceTemplate, TextResourceContents, BlobResourceContents } from '@modelcontextprotocol/sdk/types.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { toNormalizedContent } from '../processing/normalizer.js';
import { getHostname } from '../utils/url.js';
import type { ResourceStore, ResourceEntry } from './store.js';
import { buildResourceUri, buildResourceUriTemplate, parseResourceUri, type ResourceKind } from './uri.js';

const RESOURCE_NOT_FOUND = -32002;

const RESOURCE_MIME_TYPES: Record<ResourceKind, string> = {
  packet: 'application/json',
  content: 'text/markdown',
  normalized: 'application/json',
  screenshot: 'image/png',
};

const RESOURCE_TEMPLATES: Array<{
  kind: ResourceKind;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}> = [
    {
      kind: 'packet',
      name: 'webfetch-packet',
      title: 'Web Fetch Packet',
      description: 'Full LLMPacket JSON for a fetched resource.',
      mimeType: RESOURCE_MIME_TYPES.packet,
    },
    {
      kind: 'content',
      name: 'webfetch-content',
      title: 'Web Fetch Content',
      description: 'Normalized markdown content for a fetched resource.',
      mimeType: RESOURCE_MIME_TYPES.content,
    },
    {
      kind: 'normalized',
      name: 'webfetch-normalized',
      title: 'Web Fetch Normalized',
      description: 'NormalizedContent JSON derived from the packet.',
      mimeType: RESOURCE_MIME_TYPES.normalized,
    },
    {
      kind: 'screenshot',
      name: 'webfetch-screenshot',
      title: 'Web Fetch Screenshot',
      description: 'Screenshot captured during browser rendering, if available.',
      mimeType: RESOURCE_MIME_TYPES.screenshot,
    },
  ];

export function listResources(store: ResourceStore): { resources: Resource[] } {
  const resources = store.list().map(entry => buildResource(entry));
  return { resources };
}

export function listResourceTemplates(): { resourceTemplates: ResourceTemplate[] } {
  return {
    resourceTemplates: RESOURCE_TEMPLATES.map(template => ({
      uriTemplate: buildResourceUriTemplate(template.kind),
      name: template.name,
      title: template.title,
      description: template.description,
      mimeType: template.mimeType,
    })),
  };
}

export function readResource(
  store: ResourceStore,
  uri: string
): { contents: Array<TextResourceContents | BlobResourceContents> } {
  const parsed = parseResourceUri(uri);
  if (!parsed) {
    throw resourceNotFound(uri);
  }

  const entry = store.get(parsed.sourceId);
  if (!entry) {
    throw resourceNotFound(uri);
  }

  switch (parsed.kind) {
    case 'packet':
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_TYPES.packet,
            text: JSON.stringify(entry.packet, null, 2),
          },
        ],
      };
    case 'content':
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_TYPES.content,
            text: entry.packet.content,
          },
        ],
      };
    case 'normalized':
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_TYPES.normalized,
            text: JSON.stringify(toNormalizedContent(entry.packet), null, 2),
          },
        ],
      };
    case 'screenshot':
      if (!entry.packet.screenshot_base64) {
        throw resourceNotFound(uri);
      }
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_TYPES.screenshot,
            blob: entry.packet.screenshot_base64,
          },
        ],
      };
    default:
      throw resourceNotFound(uri);
  }
}

function buildResource(entry: ResourceEntry): Resource {
  const packet = entry.packet;
  const hostname = getHostname(packet.canonical_url) || getHostname(packet.original_url);
  const name = packet.source_id;
  const title = packet.metadata.title || packet.canonical_url || packet.original_url || packet.source_id;
  const description = `Fetched from ${hostname ?? packet.canonical_url ?? packet.original_url} at ${packet.retrieved_at}`;

  return {
    uri: buildResourceUri('packet', packet.source_id),
    name,
    title,
    description,
    mimeType: RESOURCE_MIME_TYPES.packet,
    annotations: {
      lastModified: packet.retrieved_at,
    },
    _meta: {
      size: Buffer.byteLength(packet.content || '', 'utf8'),
    },
  };
}

function resourceNotFound(uri: string): McpError {
  return new McpError(RESOURCE_NOT_FOUND, 'Resource not found', { uri });
}
