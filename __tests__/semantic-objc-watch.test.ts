import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { isSemanticObjcGraphIdle, resolveSemanticObjcStorePathForProject } from '../src/mcp';
import { ToolHandler } from '../src/mcp/tools';
import { CodeGraph } from '../src';
import {
  parseSemanticObjcWatchConfig,
  sampleIndexStoreSnapshot,
  waitForIndexStoreQuiescence,
  SemanticObjcIdleScheduler,
  SemanticObjcIndexStoreWatcher,
  getSemanticObjcState,
  markSemanticObjcQueued,
  markSemanticObjcStale,
} from '../src/extraction/semantic-objc';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semantic-objc-watch-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('Semantic ObjC watch configuration and scheduling', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('parses MCP semantic ObjC watch config with defaults', () => {
    expect(parseSemanticObjcWatchConfig({
      enabled: true,
      watchIndexStore: true,
      storePath: '/tmp/Index.noindex/DataStore',
      helperPath: '/tmp/codegraph-xchelper',
      languages: ['objc', 'swift'],
      deltaMode: 'unit',
      fallback: 'stale-then-idle-reconcile',
      quiescence: { sampleIntervalMs: 10, stableSamples: 2, maxWaitMs: 100 },
      scheduler: { mode: 'idle-only', maxQueueDepth: 1 },
    })).toMatchObject({
      enabled: true,
      watchIndexStore: true,
      storePath: '/tmp/Index.noindex/DataStore',
      helperPath: '/tmp/codegraph-xchelper',
      languages: ['objc', 'swift'],
      deltaMode: 'unit',
      fallback: 'stale-then-idle-reconcile',
      quiescence: { sampleIntervalMs: 100, stableSamples: 2, maxWaitMs: 1000 },
      scheduler: { mode: 'idle-only', maxQueueDepth: 1 },
    });

    expect(parseSemanticObjcWatchConfig({ enabled: true }).quiescence).toMatchObject({
      sampleIntervalMs: 1000,
      stableSamples: 3,
      maxWaitMs: 30000,
    });
    expect(parseSemanticObjcWatchConfig({
      enabled: true,
      watchIndexStore: true,
      storePath: '/tmp/not-an-indexstore',
      quiescence: { sampleIntervalMs: 1, stableSamples: 50, maxWaitMs: Number.MAX_SAFE_INTEGER },
      scheduler: { maxQueueDepth: 1000 },
    })).toMatchObject({
      storePath: null,
      quiescence: { sampleIntervalMs: 100, stableSamples: 10, maxWaitMs: 300000 },
      scheduler: { maxQueueDepth: 10 },
    });
  });

  it('samples IndexStore file count, mtime, and size and waits for quiescence', async () => {
    const storePath = path.join(tempDir, 'Index.noindex', 'DataStore');
    fs.mkdirSync(path.join(storePath, 'v5', 'units'), { recursive: true });
    fs.writeFileSync(path.join(storePath, 'v5', 'units', 'unit'), 'abc');

    const snapshot = sampleIndexStoreSnapshot(storePath);
    expect(snapshot.fileCount).toBe(1);
    expect(snapshot.totalSize).toBe(3);
    expect(snapshot.latestMtimeMs).toBeGreaterThan(0);

    await expect(waitForIndexStoreQuiescence(storePath, {
      sampleIntervalMs: 1,
      stableSamples: 2,
      maxWaitMs: 50,
    })).resolves.toMatchObject({ fileCount: 1, totalSize: 3 });
  });

  it('uses CodeGraph indexing and pending watch-sync state as the MCP semantic idle predicate', () => {
    expect(isSemanticObjcGraphIdle({ isIndexing: () => false, hasPendingWatchSync: () => false })).toBe(true);
    expect(isSemanticObjcGraphIdle({ isIndexing: () => true, hasPendingWatchSync: () => false })).toBe(false);
    expect(isSemanticObjcGraphIdle({ isIndexing: () => false, hasPendingWatchSync: () => true })).toBe(false);
  });

  it('resolves the MCP semantic IndexStore from the current project when storePath is omitted', async () => {
    const repoRoot = path.join(tempDir, 'repo');
    const projectRoot = path.join(tempDir, 'project');
    const helperPath = path.join(repoRoot, 'src/extraction/semantic-objc/swift/.build/release/codegraph-xchelper');
    const discoveredStore = path.join(tempDir, 'DerivedData', 'App', 'Index.noindex', 'DataStore');
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(helperPath, `#!/bin/sh\nprintf '%s\\n' '${discoveredStore}'\n`);
    fs.chmodSync(helperPath, 0o755);

    await expect(resolveSemanticObjcStorePathForProject(
      parseSemanticObjcWatchConfig({ enabled: true, watchIndexStore: true }),
      projectRoot,
      repoRoot
    )).resolves.toEqual({ helperPath, sourceRoot: projectRoot, storePath: discoveredStore });
  });

  it('keeps an explicit MCP semantic storePath when configured', async () => {
    const repoRoot = path.join(tempDir, 'repo');
    const helperPath = path.join(repoRoot, 'src/extraction/semantic-objc/swift/.build/release/codegraph-xchelper');
    const storePath = path.join(tempDir, 'Index.noindex', 'DataStore');
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.writeFileSync(helperPath, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(helperPath, 0o755);

    await expect(resolveSemanticObjcStorePathForProject(
      parseSemanticObjcWatchConfig({ enabled: true, watchIndexStore: true, storePath }),
      tempDir,
      repoRoot
    )).resolves.toEqual({ helperPath, sourceRoot: tempDir, storePath });
  });

  it('discovers MCP semantic IndexStore from an indexed Xcode workspace subdirectory', async () => {
    const repoRoot = path.join(tempDir, 'repo');
    const projectRoot = path.join(tempDir, 'project');
    const workspaceRoot = path.join(projectRoot, 'MvBox');
    const helperPath = path.join(repoRoot, 'src/extraction/semantic-objc/swift/.build/release/codegraph-xchelper');
    const discoveredStore = path.join(tempDir, 'DerivedData', 'MvBox', 'Index.noindex', 'DataStore');
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'mvbox.xcworkspace'), { recursive: true });
    fs.writeFileSync(helperPath, `#!/bin/sh\nprintf 'source=%s\\n' "$3" >&2\nprintf '%s\\n' '${discoveredStore}'\n`);
    fs.chmodSync(helperPath, 0o755);

    await expect(resolveSemanticObjcStorePathForProject(
      parseSemanticObjcWatchConfig({ enabled: true, watchIndexStore: true }),
      projectRoot,
      repoRoot,
      [{ path: 'MvBox/Sources/AppDelegate.m' }] as never
    )).resolves.toEqual({ helperPath, sourceRoot: workspaceRoot, storePath: discoveredStore });
  });

  it('queues semantic work when the graph is busy and serializes jobs with the graph lock', async () => {
    const lockPath = path.join(tempDir, 'codegraph.lock');
    const states: string[] = [];
    const scheduler = new SemanticObjcIdleScheduler({
      maxQueueDepth: 1,
      lockPath,
      isIdle: () => false,
      onState: (status, reason) => states.push(reason ? `${status}:${reason}` : status),
    });

    const busy = await scheduler.enqueue(async () => {
      throw new Error('should not run while busy');
    });
    expect(busy).toEqual({ ran: false, reason: 'graph-busy' });
    expect(states).toContain('queued:graph-busy');

    const runnable = new SemanticObjcIdleScheduler({ maxQueueDepth: 1, lockPath, isIdle: () => true });
    let ran = false;
    await expect(runnable.enqueue(async () => { ran = true; })).resolves.toEqual({ ran: true });
    expect(ran).toBe(true);
  });

  it('runs queued semantic work after IndexStore quiescence', async () => {
    vi.useFakeTimers();
    const storePath = path.join(tempDir, 'Index.noindex', 'DataStore');
    fs.mkdirSync(storePath, { recursive: true });
    fs.writeFileSync(path.join(storePath, 'unit'), 'abc');
    let runs = 0;
    const states: string[] = [];
    const watcher = new SemanticObjcIndexStoreWatcher({
      config: parseSemanticObjcWatchConfig({
        enabled: true,
        watchIndexStore: true,
        storePath,
        quiescence: { sampleIntervalMs: 1, stableSamples: 1, maxWaitMs: 20 },
      }),
      isIdle: () => true,
      onState: (status, reason) => states.push(reason ? `${status}:${reason}` : status),
      onSemanticDelta: async () => { runs++; },
    });

    try {
      watcher.notifyChanged();
      await vi.runAllTimersAsync();
      expect(runs).toBe(1);
      expect(states).toContain('queued:indexstore-changed');
      expect(states).toContain('running');
      expect(states).toContain('fresh');
    } finally {
      watcher.stop();
      vi.useRealTimers();
    }
  });

  it('surfaces semantic ObjC freshness in MCP status', async () => {
    const dbPath = path.join(tempDir, '.codegraph', 'codegraph.db');
    const conn = DatabaseConnection.initialize(dbPath);
    markSemanticObjcStale(conn.getDb(), 'test-stale', 123);
    conn.close();

    const cg = CodeGraph.openSync(tempDir);
    const handler = new ToolHandler(cg);
    try {
      const result = await handler.execute('codegraph_status', {});
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('**Semantic ObjC:** stale');
      expect(text).toContain('**Semantic ObjC stale reason:** test-stale');
    } finally {
      handler.closeAll();
      cg.close();
    }
  });

  it('runs semantic work while holding the graph lock without requiring the job to reacquire it', async () => {
    const lockPath = path.join(tempDir, 'codegraph.lock');
    const scheduler = new SemanticObjcIdleScheduler({ maxQueueDepth: 1, lockPath, isIdle: () => true });
    let observedLockPid: string | undefined;

    const result = await scheduler.enqueue(async () => {
      observedLockPid = fs.readFileSync(lockPath, 'utf8');
    });

    expect(result).toEqual({ ran: true });
    expect(observedLockPid).toBe(String(process.pid));
    expect(fs.existsSync(lockPath)).toBe(false);
    scheduler.stop();
  });

  it('reports graph-lock-busy instead of running concurrently', async () => {
    const lockPath = path.join(tempDir, 'codegraph.lock');
    fs.writeFileSync(lockPath, String(process.pid));
    const scheduler = new SemanticObjcIdleScheduler({ maxQueueDepth: 1, lockPath, isIdle: () => true });
    const result = await scheduler.enqueue(async () => {
      throw new Error('should not run while lock is held');
    });
    expect(result).toEqual({ ran: false, reason: 'graph-lock-busy' });
    scheduler.stop();
    fs.unlinkSync(lockPath);
  });

  it('retries queued semantic work after the graph becomes idle without another IndexStore event', async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    let idle = false;
    let runs = 0;
    const scheduler = new SemanticObjcIdleScheduler({
      maxQueueDepth: 1,
      isIdle: () => idle,
      retryDelaysMs: [5],
      onState: (status, reason) => states.push(reason ? `${status}:${reason}` : status),
    });

    try {
      await expect(scheduler.enqueue(async () => { runs++; })).resolves.toEqual({ ran: false, reason: 'graph-busy' });
      expect(runs).toBe(0);
      idle = true;
      await vi.advanceTimersByTimeAsync(5);
      expect(runs).toBe(1);
      expect(states).toContain('queued:graph-busy');
      expect(states).toContain('fresh');
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it('retries queued semantic work after a graph lock is released without another IndexStore event', async () => {
    vi.useFakeTimers();
    const lockPath = path.join(tempDir, 'codegraph.lock');
    fs.writeFileSync(lockPath, String(process.pid));
    const states: string[] = [];
    let runs = 0;
    const scheduler = new SemanticObjcIdleScheduler({
      maxQueueDepth: 1,
      lockPath,
      isIdle: () => true,
      retryDelaysMs: [5],
      onState: (status, reason) => states.push(reason ? `${status}:${reason}` : status),
    });

    try {
      await expect(scheduler.enqueue(async () => { runs++; })).resolves.toEqual({ ran: false, reason: 'graph-lock-busy' });
      expect(runs).toBe(0);
      fs.unlinkSync(lockPath);
      await vi.advanceTimersByTimeAsync(5);
      expect(runs).toBe(1);
      expect(states).toContain('queued:graph-lock-busy');
      expect(states).toContain('fresh');
    } finally {
      scheduler.stop();
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      vi.useRealTimers();
    }
  });

  it('retries queued semantic work when the job itself reports a retryable lock error', async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    let attempts = 0;
    const scheduler = new SemanticObjcIdleScheduler({
      maxQueueDepth: 1,
      isIdle: () => true,
      retryDelaysMs: [5],
      onState: (status, reason) => states.push(reason ? `${status}:${reason}` : status),
    });

    try {
      await expect(scheduler.enqueue(async () => {
        attempts++;
        if (attempts === 1) throw new Error('database is locked');
      })).resolves.toEqual({ ran: false, reason: 'graph-lock-busy' });
      await vi.advanceTimersByTimeAsync(5);
      expect(attempts).toBe(2);
      expect(states).toContain('queued:graph-lock-busy');
      expect(states).toContain('fresh');
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it('persists queued semantic ObjC state without overwriting stale reason', () => {
    const dbPath = path.join(tempDir, '.codegraph', 'codegraph.db');
    const conn = DatabaseConnection.initialize(dbPath);
    try {
      markSemanticObjcStale(conn.getDb(), 'needs-reconcile', 123);
      markSemanticObjcQueued(conn.getDb(), 'graph-lock-busy', 456);
      const state = getSemanticObjcState(conn.getDb());
      expect(state.status).toBe('queued');
      expect(state.reason).toBe('graph-lock-busy');
      expect(state.staleReason).toBe('needs-reconcile');
      expect(state.lastAttemptAt).toBe(456);
    } finally {
      conn.close();
    }
  });
});
