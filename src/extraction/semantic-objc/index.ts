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
  spawnSemanticObjcSnapshot,
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
export {
  compareSemanticObjcSnapshots,
  evaluateSemanticObjcSnapshotReadiness,
  isSemanticObjcSnapshotRecord,
  isSemanticObjcSnapshotPublicationGateError,
  isSemanticObjcSnapshotRaceError,
  normalizeSemanticObjcSnapshot,
  parseSemanticObjcSnapshotLine,
  semanticObjcSnapshotNotReadyReason,
  semanticObjcSnapshotStability,
  SEMANTIC_OBJC_SNAPSHOT_NOT_READY_PREFIX,
  SEMANTIC_OBJC_SNAPSHOT_RACE_REASON,
  stableSnapshotKey,
  waitForSemanticObjcSnapshotStability,
} from './snapshot';
export type {
  NormalizedSemanticObjcSnapshot,
  SemanticObjcSnapshotReadiness,
  SemanticObjcSnapshotRecord,
  SemanticObjcSnapshotStability,
  SemanticObjcSnapshotStabilityWaitOptions,
  SemanticObjcSnapshotStabilityWaitOutcome,
} from './snapshot';
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
  SemanticObjcSnapshotState,
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
import { spawnHelper, spawnSemanticObjcSnapshot, type SpawnerHandle } from './spawner';
import { mergeFromHelper, type MergePublicationGateResult, type MergeSummary } from './merger';
import { markSemanticObjcQueued, setSemanticObjcStateValue } from './state';
import {
  compareSemanticObjcSnapshots,
  evaluateSemanticObjcSnapshotReadiness,
  semanticObjcSnapshotNotReadyReason,
  SEMANTIC_OBJC_SNAPSHOT_RACE_REASON,
  stableSnapshotKey,
  type SemanticObjcSnapshotRecord,
} from './snapshot';
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
  /** Test/orchestrator hook for pre/post semantic snapshot publication gating. */
  snapshot?: () => Promise<SemanticObjcSnapshotRecord>;
  /** Test hook for supplying a helper handle without spawning the Swift binary. */
  helperHandleFactory?: () => SpawnerHandle;
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
  const makeHandle = () => opts.helperHandleFactory?.() ?? spawnHelper({
    helperPath: opts.helperPath,
    sourceRoot: helperSourceRoot,
    storePath: opts.storePath,
    languages: opts.languages,
    includeSystem: opts.includeSystem,
  });

  const snapshot = opts.snapshot ?? (() => spawnSemanticObjcSnapshot({
    helperPath: opts.helperPath,
    sourceRoot: helperSourceRoot,
    storePath: opts.storePath,
    languages: opts.languages,
    includeSystem: opts.includeSystem,
  }));

  const snapshotBefore = await snapshot();
  assertSnapshotReadyForPublication(db, snapshotBefore);

  return mergeFromHelper(db, makeHandle(), {
    projectRoot: opts.projectRoot,
    helperSourceRoot,
    publicationGate: async (): Promise<MergePublicationGateResult> => {
      const snapshotAfter = await snapshot();
      assertSnapshotReadyForPublication(db, snapshotAfter);
      if (!compareSemanticObjcSnapshots(snapshotBefore, snapshotAfter)) {
        const now = Date.now();
        setSemanticObjcStateValue(db, 'pending_snapshot_fingerprint', stableSnapshotKey(snapshotAfter), now);
        if (snapshotAfter.capturedAtMs !== undefined) {
          setSemanticObjcStateValue(db, 'pending_snapshot_captured_at', String(snapshotAfter.capturedAtMs), now);
        }
        setSemanticObjcStateValue(db, 'pending_reason', SEMANTIC_OBJC_SNAPSHOT_RACE_REASON, now);
        setSemanticObjcStateValue(db, 'last_snapshot_race_at', String(now), now);
        markSemanticObjcQueued(db, SEMANTIC_OBJC_SNAPSHOT_RACE_REASON, now);
        throw new Error(SEMANTIC_OBJC_SNAPSHOT_RACE_REASON);
      }
      return {
        stableSnapshotFingerprint: stableSnapshotKey(snapshotAfter),
        stableSnapshotCapturedAt: snapshotAfter.capturedAtMs,
      };
    },
  });
}

function assertSnapshotReadyForPublication(db: SqliteDatabase, snapshot: SemanticObjcSnapshotRecord): void {
  const readiness = evaluateSemanticObjcSnapshotReadiness(snapshot);
  if (readiness.ready) return;

  const now = Date.now();
  const reason = semanticObjcSnapshotNotReadyReason(readiness.reason);
  setSemanticObjcStateValue(db, 'pending_snapshot_fingerprint', stableSnapshotKey(snapshot), now);
  if (snapshot.capturedAtMs !== undefined) {
    setSemanticObjcStateValue(db, 'pending_snapshot_captured_at', String(snapshot.capturedAtMs), now);
  }
  setSemanticObjcStateValue(db, 'pending_reason', reason, now);
  markSemanticObjcQueued(db, reason, now);
  throw new Error(reason);
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
