import type { LLMPacket } from '../types.js';
import { getConfig } from '../config.js';
import { SimpleCache } from '../utils/cache.js';

export interface ResourceEntry {
  packet: LLMPacket;
}

type ListChangedNotifier = () => void | Promise<void>;

const DEFAULT_RESOURCE_CACHE_SIZE = 100;

export class ResourceStore {
  private cache: SimpleCache<ResourceEntry>;
  private keys = new Set<string>();

  constructor(options: { defaultTtlMs: number; maxSize: number }) {
    this.cache = new SimpleCache({
      defaultTtlMs: options.defaultTtlMs,
      maxSize: options.maxSize,
    });
  }

  set(entry: ResourceEntry, ttlMs?: number): boolean {
    const sourceId = entry.packet.source_id;
    const existed = this.get(sourceId) !== undefined;
    this.cache.set(sourceId, entry, ttlMs);
    this.keys.add(sourceId);
    return !existed;
  }

  get(sourceId: string): ResourceEntry | undefined {
    const entry = this.cache.get(sourceId);
    if (!entry) {
      this.keys.delete(sourceId);
    }
    return entry;
  }

  list(): ResourceEntry[] {
    const entries: ResourceEntry[] = [];
    const staleKeys: string[] = [];

    for (const key of this.keys) {
      const entry = this.cache.get(key);
      if (entry) {
        entries.push(entry);
      } else {
        staleKeys.push(key);
      }
    }

    for (const key of staleKeys) {
      this.keys.delete(key);
    }

    return entries.sort((a, b) => {
      const aTime = Date.parse(a.packet.retrieved_at) || 0;
      const bTime = Date.parse(b.packet.retrieved_at) || 0;
      if (aTime !== bTime) {
        return bTime - aTime;
      }
      return a.packet.source_id.localeCompare(b.packet.source_id);
    });
  }

  clear(): void {
    this.cache.clear();
    this.keys.clear();
  }

  destroy(): void {
    this.cache.destroy();
    this.keys.clear();
  }
}

let resourceStore: ResourceStore | null = null;
let listChangedNotifier: ListChangedNotifier | null = null;

export function getResourceStore(): ResourceStore {
  if (!resourceStore) {
    const config = getConfig();
    resourceStore = new ResourceStore({
      defaultTtlMs: Math.max(0, config.cacheTtlS) * 1000,
      maxSize: DEFAULT_RESOURCE_CACHE_SIZE,
    });
  }
  return resourceStore;
}

export function resetResourceStore(): void {
  if (resourceStore) {
    resourceStore.destroy();
    resourceStore = null;
  }
}

export function setResourceListChangedNotifier(notifier: ListChangedNotifier | null): void {
  listChangedNotifier = notifier;
}

export function storePacketResource(packet: LLMPacket): boolean {
  const store = getResourceStore();
  const isNew = store.set({ packet });
  if (isNew) {
    notifyListChanged();
  }
  return isNew;
}

function notifyListChanged(): void {
  if (!listChangedNotifier) return;
  try {
    const result = listChangedNotifier();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Ignore notification errors
  }
}
