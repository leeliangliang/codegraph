import * as fs from 'fs';
import * as path from 'path';

export interface IndexStoreQuiescenceOptions {
  sampleIntervalMs: number;
  stableSamples: number;
  maxWaitMs: number;
}

export interface IndexStoreSnapshot {
  fileCount: number;
  latestMtimeMs: number;
  totalSize: number;
}

export const DEFAULT_INDEXSTORE_QUIESCENCE: IndexStoreQuiescenceOptions = {
  sampleIntervalMs: 1000,
  stableSamples: 3,
  maxWaitMs: 30000,
};

export function sampleIndexStoreSnapshot(storePath: string): IndexStoreSnapshot {
  const snapshot: IndexStoreSnapshot = { fileCount: 0, latestMtimeMs: 0, totalSize: 0 };
  visitFiles(storePath, snapshot);
  return snapshot;
}

export async function waitForIndexStoreQuiescence(
  storePath: string,
  opts: Partial<IndexStoreQuiescenceOptions> = {}
): Promise<IndexStoreSnapshot> {
  const options = { ...DEFAULT_INDEXSTORE_QUIESCENCE, ...opts };
  const startedAt = Date.now();
  let previous: IndexStoreSnapshot | null = null;
  let stableCount = 0;

  while (Date.now() - startedAt <= options.maxWaitMs) {
    const current = sampleIndexStoreSnapshot(storePath);
    if (previous && sameIndexStoreSnapshot(previous, current)) {
      stableCount++;
      if (stableCount >= options.stableSamples) return current;
    } else {
      stableCount = 1;
      previous = current;
    }
    await delay(options.sampleIntervalMs);
  }

  throw new Error(`IndexStore did not become quiescent within ${options.maxWaitMs}ms`);
}

function visitFiles(root: string, snapshot: IndexStoreSnapshot): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      visitFiles(fullPath, snapshot);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = fs.statSync(fullPath);
      snapshot.fileCount++;
      snapshot.totalSize += stat.size;
      snapshot.latestMtimeMs = Math.max(snapshot.latestMtimeMs, stat.mtimeMs);
    } catch {
      // Ignore files that disappear while IndexStore is being updated.
    }
  }
}

export function sameIndexStoreSnapshot(a: IndexStoreSnapshot, b: IndexStoreSnapshot): boolean {
  return a.fileCount === b.fileCount && a.latestMtimeMs === b.latestMtimeMs && a.totalSize === b.totalSize;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
