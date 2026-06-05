import * as fs from 'fs';
import { SemanticObjcIdleScheduler } from './scheduler';
import type { SemanticObjcWatchConfig } from './config';
import { waitForIndexStoreQuiescence } from './quiescence';
import type { SemanticObjcStatus } from './state';

export interface SemanticObjcIndexStoreWatcherOptions {
  config: SemanticObjcWatchConfig;
  lockPath?: string;
  isIdle?: () => boolean;
  onState?: (status: SemanticObjcStatus, reason?: string) => void;
  onSemanticDelta: () => Promise<void>;
}

export class SemanticObjcIndexStoreWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private quiescenceRetryTimer: NodeJS.Timeout | null = null;
  private readonly scheduler: SemanticObjcIdleScheduler;

  constructor(private readonly opts: SemanticObjcIndexStoreWatcherOptions) {
    this.scheduler = new SemanticObjcIdleScheduler({
      maxQueueDepth: opts.config.scheduler.maxQueueDepth,
      lockPath: opts.lockPath,
      isIdle: opts.isIdle,
      onState: opts.onState,
    });
  }

  start(): boolean {
    const storePath = this.opts.config.storePath;
    if (!this.opts.config.enabled || !this.opts.config.watchIndexStore || !storePath) return false;
    try {
      this.watcher = fs.watch(storePath, { recursive: true }, () => this.notifyChanged());
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
    this.opts.onState?.('queued', 'indexstore-changed');
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.runAfterQuiescence();
    }, this.opts.config.quiescence.sampleIntervalMs);
  }

  enqueueReconcile(reason = 'semantic-reconcile'): void {
    this.opts.onState?.('queued', reason);
    void this.scheduler.enqueue(this.opts.onSemanticDelta);
  }

  private async runAfterQuiescence(): Promise<void> {
    const storePath = this.opts.config.storePath;
    if (!storePath) return;
    try {
      await waitForIndexStoreQuiescence(storePath, this.opts.config.quiescence);
      await this.scheduler.enqueue(this.opts.onSemanticDelta);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.opts.onState?.('stale', reason);
      this.scheduleQuiescenceRetry();
    }
  }

  private scheduleQuiescenceRetry(): void {
    if (this.quiescenceRetryTimer) return;
    this.quiescenceRetryTimer = setTimeout(() => {
      this.quiescenceRetryTimer = null;
      void this.runAfterQuiescence();
    }, this.opts.config.quiescence.sampleIntervalMs);
    this.quiescenceRetryTimer.unref?.();
  }
}
