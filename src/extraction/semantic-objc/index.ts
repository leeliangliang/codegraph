/**
 * Public API for the Objective-C semantic enrichment pass.
 *
 * This is the macOS-only enrichment layer that reads Xcode's IndexStore
 * (via the `codegraph-xchelper` Swift helper) and overlays semantic data
 * on top of the cross-platform tree-sitter graph.
 *
 * Entry point:
 *   `enrichWithIndexStore(db, opts)` — spawn the helper, stream NDJSON, merge.
 */

export {
  discoverIndexStorePath,
  findLocalHelperBinary,
  findShippedHelperBinary,
  locateHelperBinary,
  spawnHelper,
  recordSourceHandle,
  parseNdjsonLine,
} from './spawner';
export type { SpawnerHandle, SpawnerOptions } from './spawner';

export { DEFAULT_SEMANTIC_OBJC_WATCH_CONFIG, parseSemanticObjcWatchConfig } from './config';
export type {
  SemanticObjcDeltaMode,
  SemanticObjcFallback,
  SemanticObjcSchedulerMode,
  SemanticObjcWatchConfig,
} from './config';
export { planSemanticObjcDelta } from './delta';
export type { SemanticObjcDeltaPlan, SemanticObjcDeltaPlanInput, StoredSemanticObjcUnit } from './delta';
export {
  DEFAULT_INDEXSTORE_QUIESCENCE,
  sampleIndexStoreSnapshot,
  waitForIndexStoreQuiescence,
} from './quiescence';
export type { IndexStoreQuiescenceOptions, IndexStoreSnapshot } from './quiescence';
export { SemanticObjcIdleScheduler } from './scheduler';
export type { SemanticObjcIdleSchedulerOptions, SemanticObjcJobResult } from './scheduler';
export { SemanticObjcIndexStoreWatcher } from './watch';
export type { SemanticObjcIndexStoreWatcherOptions } from './watch';
export { applySemanticObjcDeltaRewrite } from './rewrite';
export type { SemanticObjcRewriteSummary } from './rewrite';
export {
  getSemanticObjcCoverage,
  getSemanticObjcDiagnostics,
  getSemanticObjcState,
  getSemanticObjcStateValue,
  isRetryableSemanticObjcLockError,
  markSemanticObjcFailed,
  markSemanticObjcFresh,
  markSemanticObjcMergeCompleted,
  markSemanticObjcQueued,
  markSemanticObjcReconciling,
  markSemanticObjcRunning,
  markSemanticObjcStale,
  setSemanticObjcStateValue,
  updateSemanticObjcState,
} from './state';
export type {
  SemanticObjcCoverageSnapshot,
  SemanticObjcDiagnostic,
  SemanticObjcMergeSummarySnapshot,
  SemanticObjcStateSnapshot,
  SemanticObjcStatus,
} from './state';

export { mergeFromHelper, canonicaliseSymPath } from './merger';
export type { MergeOptions, MergeSummary } from './merger';

export type {
  SemanticDeltaCapability,
  XcCapabilityRecord,
  XcDoneRecord,
  XcMetaRecord,
  XcRecord,
  XcRefRecord,
  XcRelRecord,
  XcSymRecord,
  XcUnitFileRecord,
  XcUnitRecord,
} from './types';
export { evaluateSemanticDeltaCapability, isXcRecord } from './types';

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SqliteDatabase } from '../../db/sqlite-adapter';
import type { QueryBuilder } from '../../db/queries';
import type { FileRecord } from '../../types';
import { spawnHelper } from './spawner';
import { mergeFromHelper, type MergeSummary } from './merger';

export interface EnrichOptions {
  /** Absolute path to the `codegraph-xchelper` binary. */
  helperPath: string;
  /** CodeGraph project root — what `nodes.file_path` is relative to. */
  projectRoot: string;
  /** Optional query layer used to infer a narrower Xcode source root. */
  queries?: QueryBuilder;
  /** Optional tracked files used to infer a narrower Xcode source root. */
  files?: FileRecord[];
  /**
   * Optional explicit source root for the helper. Defaults to `projectRoot`.
   * Useful when the Xcode workspace lives in a subdirectory of the indexed tree
   * (or vice versa).
   */
  helperSourceRoot?: string;
  /** Optional explicit `.indexstore/DataStore` path. Helper runs discovery if omitted. */
  storePath?: string;
  /** Languages to include. Default `['objc']`. */
  languages?: string[];
  /** Include SDK / system header occurrences. Default false. */
  includeSystem?: boolean;
}

/**
 * Spawn the helper and merge its output into `db`. Returns the merge summary.
 * Throws if the helper exits non-zero (the merge transactions are rolled back
 * via the merger's BEGIN/COMMIT/ROLLBACK guard).
 */
export async function enrichWithIndexStore(
  db: SqliteDatabase,
  opts: EnrichOptions
): Promise<MergeSummary> {
  const helperSourceRoot = opts.helperSourceRoot ?? inferSemanticObjcSourceRoot(opts.projectRoot, opts.queries ?? opts.files);
  const handle = spawnHelper({
    helperPath: opts.helperPath,
    sourceRoot: helperSourceRoot,
    storePath: opts.storePath,
    languages: opts.languages,
    includeSystem: opts.includeSystem,
  });
  return mergeFromHelper(db, handle, {
    projectRoot: opts.projectRoot,
    helperSourceRoot,
  });
}

export function inferSemanticObjcSourceRoot(projectRoot: string, source?: QueryBuilder | FileRecord[]): string {
  if (containsXcodeWorkspace(projectRoot)) return projectRoot;
  if (!source) return projectRoot;

  const files = Array.isArray(source) ? source : source.getAllFiles();
  const objcFiles = files
    .map((file) => file.path)
    .filter((filePath) => /\.(?:h|m|mm|swift)$/i.test(filePath));
  const candidates = new Set<string>();
  for (const filePath of objcFiles) {
    const parts = filePath.split(/[\\/]+/).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      candidates.add(path.join(projectRoot, ...parts.slice(0, i)));
    }
  }

  const ranked = [...candidates]
    .filter((candidate) => candidate !== projectRoot && containsXcodeWorkspace(candidate))
    .map((candidate) => ({
      candidate,
      depth: path.relative(projectRoot, candidate).split(path.sep).filter(Boolean).length,
      fileCount: objcFiles.filter((filePath) => {
        const rel = path.relative(candidate, path.join(projectRoot, filePath));
        return !rel.startsWith('..') && !path.isAbsolute(rel);
      }).length,
    }))
    .sort((a, b) => b.fileCount - a.fileCount || a.depth - b.depth || a.candidate.localeCompare(b.candidate));

  return ranked[0]?.candidate ?? projectRoot;
}

function containsXcodeWorkspace(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some((entry) => entry.endsWith('.xcworkspace') || entry.endsWith('.xcodeproj'));
}
