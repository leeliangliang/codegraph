import { evaluateSemanticDeltaCapability, type XcCapabilityRecord } from './types';

const TRANSIENT_SNAPSHOT_NOT_READY_REASONS = new Set([
  'snapshot-missing-units',
  'snapshot-missing-unit-files',
  'snapshot-missing-source-membership',
]);

export const SEMANTIC_OBJC_SNAPSHOT_RACE_REASON = 'semantic-snapshot-race';
export const SEMANTIC_OBJC_SNAPSHOT_NOT_READY_PREFIX = 'semantic-snapshot-not-ready:';

export interface SemanticObjcSnapshotRecord {
  t: 'snapshot';
  /** Wall-clock capture time emitted by newer helpers. Ignored for stability fingerprints. */
  capturedAtMs?: number;
  helperVersion: string;
  semanticDeltaVersion: number;
  unitFingerprintAlgorithm: string;
  recordKinds: string[];
  sourceMembership: boolean;
  languageFilter: string[];
  includeSystem: boolean;
  explicitOutputUnits: boolean;
  unitCount: number;
  unitFileCount: number;
  sourceMembershipCount: number;
  aggregateFingerprint: string;
}

export interface NormalizedSemanticObjcSnapshot {
  /** Wall-clock time when this snapshot was captured; excluded from stableSnapshotKey(). */
  capturedAtMs?: number;
  helperVersion: string;
  semanticDeltaVersion: number;
  unitFingerprintAlgorithm: string;
  recordKinds: string[];
  sourceMembership: boolean;
  languageFilter: string[];
  includeSystem: boolean;
  explicitOutputUnits: boolean;
  unitCount: number;
  unitFileCount: number;
  sourceMembershipCount: number;
  aggregateFingerprint: string;
}

export type SemanticObjcSnapshotReadiness =
  | { ready: true }
  | { ready: false; reason: string };

export interface SemanticObjcSnapshotStability {
  stable: boolean;
  count: number;
  snapshot?: NormalizedSemanticObjcSnapshot;
}

export type SemanticObjcSnapshotStabilityWaitOutcome =
  | { status: 'stable'; snapshot: NormalizedSemanticObjcSnapshot; samples: number; durationMs: number }
  | { status: 'timeout'; reason: string; samples: number; durationMs: number; snapshot?: NormalizedSemanticObjcSnapshot }
  | { status: 'helper-failed'; reason: string; samples: number; durationMs: number }
  | { status: 'unsafe-capability'; reason: string; samples: number; durationMs: number; snapshot: NormalizedSemanticObjcSnapshot }
  | { status: 'aborted'; reason: string; samples: number; durationMs: number };

function isTransientSnapshotNotReadyReason(reason: string): boolean {
  return TRANSIENT_SNAPSHOT_NOT_READY_REASONS.has(reason);
}

export interface SemanticObjcSnapshotStabilityWaitOptions {
  sample: (signal?: AbortSignal) => Promise<SemanticObjcSnapshotRecord>;
  sampleIntervalMs: number;
  stableSamples: number;
  maxWaitMs: number;
  signal?: AbortSignal;
}

export function isSemanticObjcSnapshotRaceError(err: unknown): boolean {
  return err instanceof Error && err.message === SEMANTIC_OBJC_SNAPSHOT_RACE_REASON;
}

export function semanticObjcSnapshotNotReadyReason(readinessReason: string): string {
  return `${SEMANTIC_OBJC_SNAPSHOT_NOT_READY_PREFIX}${readinessReason}`;
}

export function isSemanticObjcSnapshotPublicationGateError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message === SEMANTIC_OBJC_SNAPSHOT_RACE_REASON ||
    err.message.startsWith(SEMANTIC_OBJC_SNAPSHOT_NOT_READY_PREFIX);
}

export function parseSemanticObjcSnapshotLine(line: string): SemanticObjcSnapshotRecord | null {
  try {
    const value = JSON.parse(line) as unknown;
    return isSemanticObjcSnapshotRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function isSemanticObjcSnapshotRecord(value: unknown): value is SemanticObjcSnapshotRecord {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return rec.t === 'snapshot' &&
    (rec.capturedAtMs === undefined || isNonNegativeInteger(rec.capturedAtMs)) &&
    typeof rec.helperVersion === 'string' &&
    typeof rec.semanticDeltaVersion === 'number' &&
    typeof rec.unitFingerprintAlgorithm === 'string' &&
    Array.isArray(rec.recordKinds) &&
    rec.recordKinds.every((kind) => typeof kind === 'string') &&
    typeof rec.sourceMembership === 'boolean' &&
    Array.isArray(rec.languageFilter) &&
    rec.languageFilter.every((lang) => typeof lang === 'string') &&
    typeof rec.includeSystem === 'boolean' &&
    typeof rec.explicitOutputUnits === 'boolean' &&
    isNonNegativeInteger(rec.unitCount) &&
    isNonNegativeInteger(rec.unitFileCount) &&
    isNonNegativeInteger(rec.sourceMembershipCount) &&
    typeof rec.aggregateFingerprint === 'string' &&
    rec.aggregateFingerprint.length > 0;
}

export function normalizeSemanticObjcSnapshot(
  snapshot: SemanticObjcSnapshotRecord | NormalizedSemanticObjcSnapshot
): NormalizedSemanticObjcSnapshot {
  return {
    ...(snapshot.capturedAtMs !== undefined ? { capturedAtMs: snapshot.capturedAtMs } : {}),
    helperVersion: snapshot.helperVersion,
    semanticDeltaVersion: snapshot.semanticDeltaVersion,
    unitFingerprintAlgorithm: snapshot.unitFingerprintAlgorithm,
    recordKinds: [...new Set(snapshot.recordKinds)].sort(),
    sourceMembership: snapshot.sourceMembership,
    languageFilter: [...new Set(snapshot.languageFilter)].sort(),
    includeSystem: snapshot.includeSystem,
    explicitOutputUnits: snapshot.explicitOutputUnits,
    unitCount: snapshot.unitCount,
    unitFileCount: snapshot.unitFileCount,
    sourceMembershipCount: snapshot.sourceMembershipCount,
    aggregateFingerprint: snapshot.aggregateFingerprint,
  };
}

export function compareSemanticObjcSnapshots(
  a: SemanticObjcSnapshotRecord | NormalizedSemanticObjcSnapshot,
  b: SemanticObjcSnapshotRecord | NormalizedSemanticObjcSnapshot
): boolean {
  return stableSnapshotKey(normalizeSemanticObjcSnapshot(a)) ===
    stableSnapshotKey(normalizeSemanticObjcSnapshot(b));
}

export function evaluateSemanticObjcSnapshotReadiness(
  snapshot: SemanticObjcSnapshotRecord | NormalizedSemanticObjcSnapshot
): SemanticObjcSnapshotReadiness {
  const normalized = normalizeSemanticObjcSnapshot(snapshot);
  const capability = evaluateSemanticDeltaCapability(snapshotCapability(normalized));
  if (!capability.safe) return { ready: false, reason: capability.reason ?? 'snapshot-unsafe-capability' };
  if (normalized.unitCount === 0) return { ready: false, reason: 'snapshot-missing-units' };
  if (normalized.unitFileCount === 0) return { ready: false, reason: 'snapshot-missing-unit-files' };
  if (normalized.sourceMembershipCount < normalized.unitCount) {
    return { ready: false, reason: 'snapshot-missing-source-membership' };
  }
  return { ready: true };
}

export function semanticObjcSnapshotStability(
  snapshots: Array<SemanticObjcSnapshotRecord | NormalizedSemanticObjcSnapshot>,
  stableSamples: number
): SemanticObjcSnapshotStability {
  const threshold = Math.max(1, Math.floor(stableSamples));
  if (snapshots.length === 0) return { stable: false, count: 0 };

  const last = normalizeSemanticObjcSnapshot(snapshots[snapshots.length - 1]!);
  let count = 1;
  for (let i = snapshots.length - 2; i >= 0; i--) {
    if (!compareSemanticObjcSnapshots(last, snapshots[i]!)) break;
    count++;
  }
  const result: SemanticObjcSnapshotStability = {
    stable: count >= threshold,
    count,
  };
  if (snapshots.length >= threshold) result.snapshot = last;
  return result;
}

export function stableSnapshotKey(snapshot: NormalizedSemanticObjcSnapshot): string {
  const { capturedAtMs: _capturedAtMs, ...stable } = snapshot;
  return JSON.stringify(stable);
}

export async function waitForSemanticObjcSnapshotStability(
  opts: SemanticObjcSnapshotStabilityWaitOptions
): Promise<SemanticObjcSnapshotStabilityWaitOutcome> {
  const startedAt = Date.now();
  const samples: NormalizedSemanticObjcSnapshot[] = [];
  const minimumSamples = Math.max(1, Math.floor(opts.stableSamples));

  while (true) {
    if (opts.signal?.aborted) {
      return snapshotWaitAbortedOutcome(true, opts.stableSamples, samples, startedAt);
    }

    let snapshot: SemanticObjcSnapshotRecord;
    try {
      snapshot = await opts.sample(opts.signal);
    } catch (err) {
      if (opts.signal?.aborted) {
        return snapshotWaitAbortedOutcome(true, opts.stableSamples, samples, startedAt);
      }
      return {
        status: 'helper-failed',
        reason: err instanceof Error ? err.message : String(err),
        samples: samples.length,
        durationMs: Date.now() - startedAt,
      };
    }

    const normalized = normalizeSemanticObjcSnapshot(snapshot);
    const readiness = evaluateSemanticObjcSnapshotReadiness(normalized);
    samples.push(normalized);
    if (!readiness.ready) {
      if (isTransientSnapshotNotReadyReason(readiness.reason)) {
        if (Date.now() - startedAt >= opts.maxWaitMs && samples.length >= minimumSamples) break;
        await delay(opts.sampleIntervalMs, opts.signal);
        continue;
      }
      return {
        status: 'unsafe-capability',
        reason: readiness.reason,
        samples: samples.length,
        durationMs: Date.now() - startedAt,
        snapshot: normalized,
      };
    }

    const stability = semanticObjcSnapshotStability(samples, opts.stableSamples);
    if (stability.stable && stability.snapshot) {
      return {
        status: 'stable',
        snapshot: stability.snapshot,
        samples: samples.length,
        durationMs: Date.now() - startedAt,
      };
    }

    if (Date.now() - startedAt >= opts.maxWaitMs && samples.length >= minimumSamples) break;
    await delay(opts.sampleIntervalMs, opts.signal);
  }

  const stability = semanticObjcSnapshotStability(samples, opts.stableSamples);
  return {
    status: 'timeout',
    reason: 'semantic-snapshot-timeout',
    samples: samples.length,
    durationMs: Date.now() - startedAt,
    ...(stability.snapshot ? { snapshot: stability.snapshot } : {}),
  };
}

function snapshotCapability(snapshot: NormalizedSemanticObjcSnapshot): XcCapabilityRecord {
  return {
    t: 'cap',
    semanticDeltaVersion: snapshot.semanticDeltaVersion,
    helperVersion: snapshot.helperVersion,
    unitFingerprintAlgorithm: snapshot.unitFingerprintAlgorithm,
    recordKinds: snapshot.recordKinds,
    sourceMembership: snapshot.sourceMembership,
  };
}

function snapshotWaitAbortedOutcome(
  abortedByCaller: boolean,
  stableSamples: number,
  samples: NormalizedSemanticObjcSnapshot[],
  startedAt: number
): SemanticObjcSnapshotStabilityWaitOutcome {
  if (abortedByCaller) {
    return {
      status: 'aborted',
      reason: 'semantic-snapshot-wait-aborted',
      samples: samples.length,
      durationMs: Date.now() - startedAt,
    };
  }
  const stability = semanticObjcSnapshotStability(samples, stableSamples);
  return {
    status: 'timeout',
    reason: 'semantic-snapshot-timeout',
    samples: samples.length,
    durationMs: Date.now() - startedAt,
    ...(stability.snapshot ? { snapshot: stability.snapshot } : {}),
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const abort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
