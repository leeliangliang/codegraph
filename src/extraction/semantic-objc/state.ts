import type { SqliteDatabase } from '../../db/sqlite-adapter';

export type SemanticObjcStatus = 'fresh' | 'stale' | 'queued' | 'running' | 'failed' | 'reconciling';

export interface SemanticObjcMergeSummarySnapshot {
  symsSeen: number;
  symsMerged: number;
  symsOutsideProject: number;
  symsNotMatched: number;
  unitsSeen: number;
  unitsMerged: number;
  unitFilesSeen: number;
  unitFilesMerged: number;
  ownershipRowsMerged: number;
  relsSeen: number;
  relsMerged: number;
  relsSkipped: number;
  relsAlreadyPresent: number;
  refsSeen: number;
  refsMerged: number;
  refsOutsideProject: number;
  refsNoSource: number;
  refsNoTarget: number;
  refsAlreadyPresent: number;
  refsNonCall: number;
}

export interface SemanticObjcCoverageSnapshot {
  nodesWithUsr: number;
  semanticEdges: number;
  semanticCallEdges: number;
  semanticNonCallEdges: number;
  units: number;
  unitFiles: number;
  ownershipRows: number;
}

export interface SemanticObjcDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface SemanticObjcStateSnapshot {
  status?: SemanticObjcStatus;
  reason?: string;
  staleReason?: string;
  lastUpdatedAt?: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastMergeCompletedAt?: number;
  lastMergeSummary?: SemanticObjcMergeSummarySnapshot;
  coverage?: SemanticObjcCoverageSnapshot;
  diagnostics?: SemanticObjcDiagnostic[];
}

export function setSemanticObjcStateValue(
  db: SqliteDatabase,
  key: string,
  value: string,
  now = Date.now()
): void {
  db.prepare(
    'INSERT OR REPLACE INTO semantic_objc_state (key, value, updated_at) VALUES (?, ?, ?)'
  ).run(key, value, now);
}

export function getSemanticObjcStateValue(db: SqliteDatabase, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM semantic_objc_state WHERE key = ?').get(key) as
    | { value?: string }
    | undefined;
  return row?.value;
}

export function updateSemanticObjcState(
  db: SqliteDatabase,
  status: SemanticObjcStatus,
  reason?: string,
  now = Date.now()
): void {
  setSemanticObjcStateValue(db, 'status', status, now);
  setSemanticObjcStateValue(db, 'reason', reason ?? '', now);
  setSemanticObjcStateValue(db, 'last_updated_at', String(now), now);

  if (status === 'running' || status === 'queued' || status === 'reconciling') {
    setSemanticObjcStateValue(db, 'last_attempt_at', String(now), now);
  }
  if (status === 'failed') {
    setSemanticObjcStateValue(db, 'last_failure_at', String(now), now);
  }
}

export function markSemanticObjcStale(
  db: SqliteDatabase,
  reason: string,
  now = Date.now()
): void {
  updateSemanticObjcState(db, 'stale', reason, now);
  setSemanticObjcStateValue(db, 'stale_reason', reason, now);
  setSemanticObjcStateValue(db, 'last_attempt_at', String(now), now);
}

export function markSemanticObjcFresh(db: SqliteDatabase, now = Date.now()): void {
  updateSemanticObjcState(db, 'fresh', undefined, now);
  setSemanticObjcStateValue(db, 'stale_reason', '', now);
  setSemanticObjcStateValue(db, 'last_success_at', String(now), now);
}

export function markSemanticObjcMergeCompleted(
  db: SqliteDatabase,
  summary: SemanticObjcMergeSummarySnapshot,
  now = Date.now()
): void {
  setSemanticObjcStateValue(db, 'last_merge_summary_json', JSON.stringify(summary), now);
  setSemanticObjcStateValue(db, 'last_merge_completed_at', String(now), now);
}

export function markSemanticObjcQueued(db: SqliteDatabase, reason: string, now = Date.now()): void {
  updateSemanticObjcState(db, 'queued', reason, now);
}

export function markSemanticObjcRunning(db: SqliteDatabase, reason = 'semantic-enrichment', now = Date.now()): void {
  updateSemanticObjcState(db, 'running', reason, now);
}

export function markSemanticObjcReconciling(db: SqliteDatabase, reason = 'semantic-reconcile', now = Date.now()): void {
  updateSemanticObjcState(db, 'reconciling', reason, now);
}

export function markSemanticObjcFailed(db: SqliteDatabase, reason: string, now = Date.now()): void {
  updateSemanticObjcState(db, 'failed', reason, now);
}

export function isRetryableSemanticObjcLockError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('locked by another') || err.message.includes('database is locked');
}

export function getSemanticObjcState(db: SqliteDatabase): SemanticObjcStateSnapshot {
  const rows = db.prepare('SELECT key, value FROM semantic_objc_state').all() as Array<{
    key: string;
    value: string;
  }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const lastMergeSummary = jsonValue<SemanticObjcMergeSummarySnapshot>(values.get('last_merge_summary_json'));
  const coverage = getSemanticObjcCoverage(db);
  const snapshot: SemanticObjcStateSnapshot = {
    status: values.get('status') as SemanticObjcStatus | undefined,
    reason: values.get('reason') || undefined,
    staleReason: values.get('stale_reason') || undefined,
    lastUpdatedAt: numberValue(values.get('last_updated_at')),
    lastAttemptAt: numberValue(values.get('last_attempt_at')),
    lastSuccessAt: numberValue(values.get('last_success_at')),
    lastFailureAt: numberValue(values.get('last_failure_at')),
    lastMergeCompletedAt: numberValue(values.get('last_merge_completed_at')),
    lastMergeSummary,
    coverage,
  };
  snapshot.diagnostics = getSemanticObjcDiagnostics(snapshot, coverage);
  return snapshot;
}

export function getSemanticObjcCoverage(db: SqliteDatabase): SemanticObjcCoverageSnapshot | undefined {
  try {
    return {
      nodesWithUsr: countRows(db, "SELECT count(*) AS count FROM nodes WHERE usr IS NOT NULL AND usr != ''"),
      semanticEdges: countRows(db, "SELECT count(*) AS count FROM edges WHERE provenance = 'semantic-objc'"),
      semanticCallEdges: countRows(db, "SELECT count(*) AS count FROM edges WHERE provenance = 'semantic-objc' AND kind = 'calls'"),
      semanticNonCallEdges: countRows(db, "SELECT count(*) AS count FROM edges WHERE provenance = 'semantic-objc' AND kind != 'calls'"),
      units: countRows(db, 'SELECT count(*) AS count FROM semantic_objc_units'),
      unitFiles: countRows(db, 'SELECT count(*) AS count FROM semantic_objc_unit_files'),
      ownershipRows: countRows(db, 'SELECT count(*) AS count FROM semantic_objc_node_ownership'),
    };
  } catch {
    return undefined;
  }
}

export function getSemanticObjcDiagnostics(
  snapshot: SemanticObjcStateSnapshot,
  coverage?: SemanticObjcCoverageSnapshot
): SemanticObjcDiagnostic[] {
  const diagnostics: SemanticObjcDiagnostic[] = [];
  const summary = snapshot.lastMergeSummary;
  if (coverage) {
    if (coverage.semanticEdges > 0 && coverage.units === 0 && coverage.unitFiles === 0) {
      diagnostics.push({
        code: 'semantic-objc-units-missing-with-edges',
        severity: 'warning',
        message: 'Semantic ObjC edges exist, but unit metadata tables are empty. This usually means the DB contains an older semantic merge or a later unit-capable enrichment failed before committing unit metadata.',
      });
    }
    if (snapshot.status === 'fresh' && (summary?.unitsSeen ?? 0) > 0 && coverage.units === 0) {
      diagnostics.push({
        code: 'semantic-objc-fresh-without-merged-units',
        severity: 'error',
        message: 'Semantic ObjC is marked fresh and helper saw units, but unit metadata is empty. The merge may have failed to persist unit records.',
      });
    }
  }
  if (summary && summary.unitsSeen === 0 && summary.unitFilesSeen === 0) {
    diagnostics.push({
      code: 'semantic-objc-helper-no-units',
      severity: (summary.relsMerged > 0 || summary.refsMerged > 0) ? 'warning' : 'info',
      message: 'The last Semantic ObjC helper run did not emit unit metadata.',
    });
  }
  if (summary && summary.symsSeen > 0 && summary.symsMerged === 0) {
    diagnostics.push({
      code: 'semantic-objc-symbols-not-matching',
      severity: 'warning',
      message: 'Semantic ObjC saw symbols but did not match any indexed nodes. This can happen when the helper source root or IndexStore paths do not line up with the indexed project.',
    });
  }
  if (summary && summary.refsSeen > 0 && summary.refsNoTarget / summary.refsSeen > 0.8) {
    diagnostics.push({
      code: 'semantic-objc-refs-no-target-high',
      severity: 'warning',
      message: 'Most Semantic ObjC references did not resolve to indexed targets. This can happen when USRs were not attached, source roots do not line up, or many targets are external.',
    });
  }
  if (snapshot.staleReason?.includes('locked') || snapshot.reason?.includes('locked')) {
    diagnostics.push({
      code: 'semantic-objc-lock-failure',
      severity: 'warning',
      message: 'Last Semantic ObjC attempt failed due to a DB or graph lock. Retry when the graph is idle, or rerun semantic enrichment if no daemon is active.',
    });
  }
  return diagnostics;
}

function countRows(db: SqliteDatabase, sql: string): number {
  const row = db.prepare(sql).get() as { count?: number } | undefined;
  return typeof row?.count === 'number' ? row.count : 0;
}

function numberValue(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function jsonValue<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
