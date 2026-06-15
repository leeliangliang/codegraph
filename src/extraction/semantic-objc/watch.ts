import * as fs from 'fs';
import { SemanticObjcIdleScheduler } from './scheduler';
import type { SemanticObjcWatchConfig } from './config';
import {
  sampleIndexStoreSnapshot,
  sameIndexStoreSnapshot,
  waitForIndexStoreQuiescence,
  type IndexStoreSnapshot,
} from './quiescence';
import type { SemanticObjcStatus } from './state';
import { spawnSemanticObjcSnapshot } from './spawner';
import {
  isSemanticObjcSnapshotPublicationGateError,
  waitForSemanticObjcSnapshotStability,
  type SemanticObjcSnapshotRecord,
} from './snapshot';

const MAX_SNAPSHOT_RACE_RETRIES = 3;
const SNAPSHOT_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000, 60000];

export interface SemanticObjcIndexStoreWatcherOptions {
  config: SemanticObjcWatchConfig;
  lockPath?: string;
  sourceRoot?: string;
  isIdle?: () => boolean;
  onState?: (status: SemanticObjcStatus, reason?: string) => void;
  snapshot?: (signal?: AbortSignal) => Promise<SemanticObjcSnapshotRecord>;
  onSemanticDelta: () => Promise<void>;
}

export class SemanticObjcIndexStoreWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private quiescenceRetryTimer: NodeJS.Timeout | null = null;
  private snapshotWaitAbort: AbortController | null = null;
  private snapshotRetryAttempt = 0;
  private snapshotRaceRetries = 0;
  private lastIndexStoreSnapshot: IndexStoreSnapshot | null = null;
  private readonly scheduler: SemanticObjcIdleScheduler;

  constructor(private readonly opts: SemanticObjcIndexStoreWatcherOptions) {
    this.scheduler = new SemanticObjcIdleScheduler({
      maxQueueDepth: opts.config.scheduler.maxQueueDepth,
      lockPath: opts.lockPath,
      isIdle: opts.isIdle,
      onState: opts.onState,
      handleJobError: (err) => this.handleSemanticJobError(err),
    });
  }

  start(): boolean {
    const storePath = this.opts.config.storePath;
    if (!this.opts.config.enabled || !this.opts.config.watchIndexStore || !storePath) return false;
    try {
      this.watcher = fs.watch(storePath, { recursive: true }, () => this.notifyChanged());
      this.lastIndexStoreSnapshot = sampleIndexStoreSnapshot(storePath);
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.quiescenceRetryTimer) {
      clearTimeout(this.quiescenceRetryTimer);
      this.quiescenceRetryTimer = null;
    }
    this.snapshotWaitAbort?.abort();
    this.snapshotWaitAbort = null;
    this.scheduler.stop();
    this.watcher?.close();
    this.watcher = null;
  }

  isActive(): boolean {
    return !!this.watcher;
  }

  hasPendingWork(): boolean {
    return this.pendingTimer !== null ||
      this.quiescenceRetryTimer !== null ||
      this.scheduler.status() !== 'fresh';
  }

  notifyChanged(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    if (this.quiescenceRetryTimer) {
      clearTimeout(this.quiescenceRetryTimer);
      this.quiescenceRetryTimer = null;
    }
    this.snapshotWaitAbort?.abort();
    this.snapshotWaitAbort = null;
    this.snapshotRetryAttempt = 0;
    this.snapshotRaceRetries = 0;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.runAfterQuiescence();
    }, this.opts.config.quiescence.sampleIntervalMs);
  }

  enqueueReconcile(reason = 'semantic-reconcile'): void {
    this.opts.onState?.('queued', reason);
    void this.scheduler.enqueue(this.opts.onSemanticDelta);
  }

  private async runAfterQuiescence(force = false): Promise<void> {
    const storePath = this.opts.config.storePath;
    if (!storePath) return;
    try {
      const indexStoreSnapshot = await waitForIndexStoreQuiescence(storePath, this.opts.config.quiescence);
      if (
        !force &&
        this.lastIndexStoreSnapshot &&
        sameIndexStoreSnapshot(this.lastIndexStoreSnapshot, indexStoreSnapshot)
      ) {
        return;
      }
      this.opts.onState?.('queued', 'indexstore-changed');
      const snapshot = this.opts.snapshot ?? this.defaultSnapshotProvider();
      if (snapshot) {
        this.opts.onState?.('queued', 'semantic-snapshot-wait');
        const controller = new AbortController();
        this.snapshotWaitAbort = controller;
        const outcome = await waitForSemanticObjcSnapshotStability({
          sample: snapshot,
          sampleIntervalMs: this.opts.config.quiescence.sampleIntervalMs,
          stableSamples: this.opts.config.quiescence.stableSamples,
          maxWaitMs: this.opts.config.quiescence.maxWaitMs,
          signal: controller.signal,
        });
        if (this.snapshotWaitAbort === controller) {
          this.snapshotWaitAbort = null;
        }
        if (outcome.status !== 'stable') {
          if (outcome.status === 'aborted') return;
          this.opts.onState?.(
            'stale',
            outcome.status === 'timeout'
              ? outcome.reason
              : `semantic-snapshot-${outcome.status}:${outcome.reason}`
          );
          this.scheduleQuiescenceRetry(true);
          return;
        }
        this.snapshotRetryAttempt = 0;
      }
      const result = await this.scheduler.enqueue(this.opts.onSemanticDelta);
      if (result.ran) {
        this.snapshotRaceRetries = 0;
        this.lastIndexStoreSnapshot = indexStoreSnapshot;
      }
    } catch (err) {
      if (isSemanticObjcSnapshotPublicationGateError(err)) {
        const reason = err instanceof Error ? err.message : 'semantic-snapshot-publication-gate';
        this.opts.onState?.('queued', reason);
        this.scheduleSnapshotPublicationRetry(reason);
        return;
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.opts.onState?.('stale', reason);
      this.scheduleQuiescenceRetry(false);
    }
  }

  private handleSemanticJobError(err: unknown): { ran: false; reason: string } | undefined {
    if (!isSemanticObjcSnapshotPublicationGateError(err)) return undefined;
    const reason = err instanceof Error ? err.message : 'semantic-snapshot-publication-gate';
    this.opts.onState?.('queued', reason);
    this.scheduleSnapshotPublicationRetry(reason);
    return { ran: false, reason };
  }

  private defaultSnapshotProvider(): ((signal?: AbortSignal) => Promise<SemanticObjcSnapshotRecord>) | null {
    const { helperPath, storePath, languages } = this.opts.config;
    const sourceRoot = this.opts.sourceRoot;
    if (!helperPath || !storePath || !sourceRoot) return null;
    return (signal?: AbortSignal) => spawnSemanticObjcSnapshot({
      helperPath,
      sourceRoot,
      storePath,
      languages,
      signal,
    });
  }

  private scheduleQuiescenceRetry(useBackoff = true): boolean {
    if (this.quiescenceRetryTimer) return false;
    const delayMs = useBackoff
      ? SNAPSHOT_RETRY_DELAYS_MS[
        Math.min(this.snapshotRetryAttempt, SNAPSHOT_RETRY_DELAYS_MS.length - 1)
      ] ?? this.opts.config.quiescence.sampleIntervalMs
      : this.opts.config.quiescence.sampleIntervalMs;
    if (useBackoff) this.snapshotRetryAttempt++;
    this.quiescenceRetryTimer = setTimeout(() => {
      this.quiescenceRetryTimer = null;
      void this.runAfterQuiescence(true);
    }, delayMs);
    this.quiescenceRetryTimer.unref?.();
    return true;
  }

  private scheduleSnapshotPublicationRetry(reason: string): void {
    if (this.snapshotRaceRetries >= MAX_SNAPSHOT_RACE_RETRIES) {
      this.opts.onState?.('stale', `${reason}-retry-exhausted`);
      this.snapshotRaceRetries = 0;
      return;
    }
    if (this.scheduleQuiescenceRetry(false)) {
      this.snapshotRaceRetries++;
    }
  }
}
