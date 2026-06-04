import type { SqliteDatabase } from '../../db/sqlite-adapter';

export type SemanticObjcStatus = 'fresh' | 'stale' | 'queued' | 'running' | 'failed' | 'reconciling';

export interface SemanticObjcStateSnapshot {
  status?: SemanticObjcStatus;
  reason?: string;
  staleReason?: string;
  lastUpdatedAt?: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
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
  return {
    status: values.get('status') as SemanticObjcStatus | undefined,
    reason: values.get('reason') || undefined,
    staleReason: values.get('stale_reason') || undefined,
    lastUpdatedAt: numberValue(values.get('last_updated_at')),
    lastAttemptAt: numberValue(values.get('last_attempt_at')),
    lastSuccessAt: numberValue(values.get('last_success_at')),
    lastFailureAt: numberValue(values.get('last_failure_at')),
  };
}

function numberValue(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
