import { FileLock } from '../../utils';
import { isRetryableSemanticObjcLockError, type SemanticObjcStatus } from './state';

export interface SemanticObjcIdleSchedulerOptions {
  maxQueueDepth: number;
  lockPath?: string;
  isIdle?: () => boolean;
  onState?: (status: SemanticObjcStatus, reason?: string) => void;
  handleJobError?: (err: unknown) => SemanticObjcJobResult | undefined;
  retryDelaysMs?: number[];
}

export interface SemanticObjcJobResult {
  ran: boolean;
  reason?: string;
}

const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

export class SemanticObjcIdleScheduler {
  private queued = false;
  private running = false;
  private pendingJob: (() => Promise<void>) | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;

  constructor(private readonly opts: SemanticObjcIdleSchedulerOptions) {}

  status(): SemanticObjcStatus {
    if (this.running) return 'running';
    if (this.queued) return 'queued';
    return 'fresh';
  }

  queueDepth(): number {
    return this.queued ? 1 : 0;
  }

  async enqueue(job: () => Promise<void>): Promise<SemanticObjcJobResult> {
    if (this.running) {
      this.pendingJob = job;
      this.queued = true;
      this.opts.onState?.('queued', 'semantic-job-running');
      return { ran: false, reason: 'semantic-job-running' };
    }
    if (this.queued && this.queueDepth() >= this.opts.maxQueueDepth) {
      this.pendingJob = job;
      this.opts.onState?.('queued', 'semantic-queue-full');
      this.scheduleRetry();
      return { ran: false, reason: 'semantic-queue-full' };
    }

    this.pendingJob = job;
    return this.drain();
  }

  stop(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.pendingJob = null;
    this.queued = false;
  }

  private async drain(): Promise<SemanticObjcJobResult> {
    if (this.running) {
      this.queued = true;
      this.opts.onState?.('queued', 'semantic-job-running');
      return { ran: false, reason: 'semantic-job-running' };
    }

    const job = this.pendingJob;
    if (!job) {
      this.queued = false;
      return { ran: false, reason: 'semantic-queue-empty' };
    }

    if (this.opts.isIdle && !this.opts.isIdle()) {
      this.queued = true;
      this.opts.onState?.('queued', 'graph-busy');
      this.scheduleRetry();
      return { ran: false, reason: 'graph-busy' };
    }

    this.clearRetryTimer();
    this.queued = false;
    this.running = true;
    this.opts.onState?.('running');
    try {
      await this.runJob(job);
      if (this.pendingJob === job) {
        this.pendingJob = null;
        this.retryAttempt = 0;
        this.opts.onState?.('fresh');
      }
      return { ran: true };
    } catch (err) {
      const handled = this.handleJobError(err, job);
      if (handled) return handled;
      throw err;
    } finally {
      this.running = false;
      if (this.queued && this.pendingJob) {
        this.scheduleRetry();
      }
    }
  }

  private async runJob(job: () => Promise<void>): Promise<void> {
    if (this.opts.lockPath) {
      const lock = new FileLock(this.opts.lockPath);
      await lock.withLockAsync(job);
      return;
    }
    await job();
  }

  private handleJobError(err: unknown, job: () => Promise<void>): SemanticObjcJobResult | null {
    if (isRetryableSemanticObjcLockError(err)) {
      this.queued = true;
      this.opts.onState?.('queued', 'graph-lock-busy');
      this.scheduleRetry();
      return { ran: false, reason: 'graph-lock-busy' };
    }

    const handled = this.opts.handleJobError?.(err);
    if (!handled) return null;
    if (this.pendingJob === job) {
      this.pendingJob = null;
      this.retryAttempt = 0;
    }
    return handled;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const delays = this.opts.retryDelaysMs && this.opts.retryDelaysMs.length > 0
      ? this.opts.retryDelaysMs
      : DEFAULT_RETRY_DELAYS_MS;
    const delay = delays[Math.min(this.retryAttempt, delays.length - 1)];
    this.retryAttempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drain().catch((err) => {
        this.opts.onState?.('failed', err instanceof Error ? err.message : String(err));
      });
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
