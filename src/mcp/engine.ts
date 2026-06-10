/**
 * MCP shared engine — the heavyweight, *shared* state for an MCP server:
 * the project's {@link CodeGraph} instance, file watcher, and the
 * {@link ToolHandler} cache for cross-project queries.
 *
 * One engine, many sessions:
 * - direct mode (single stdio session) instantiates one engine + one session;
 * - daemon mode instantiates one engine and a new session per socket
 *   connection. Every session reads from the same SQLite WAL and the same
 *   inotify watch set — that's the entire point of issue #411.
 */

import * as path from 'path';
import type CodeGraph from '../index';
import { findNearestCodeGraphRoot } from '../directory';
import { watchDisabledReason } from '../sync';
import { ToolHandler } from './tools';
import {
  SemanticObjcIndexStoreWatcher,
  discoverIndexStorePath,
  inferSemanticObjcSourceRoot,
  locateHelperBinary,
  parseSemanticObjcWatchConfig,
  type SemanticObjcIndexStoreWatcherOptions,
  type SemanticObjcWatchConfig,
} from '../extraction/semantic-objc';
import type { SemanticObjcStatus } from '../extraction/semantic-objc/state';

// Lazy-load the heavy CodeGraph chain (sqlite + query/graph/context layers) OFF
// the MCP startup path. It's only needed once a tool actually opens a project —
// not to answer initialize/tools-list — so deferring it lets `serve --mcp` (and
// the daemon it spawns) bind + register tools in ~Node-startup time instead of
// ~800ms, closing the "No such tool available" cold-start race that made headless
// agents flounder. require() is sync + cached on the CommonJS build.
const loadCodeGraph = (): typeof import('../index').default =>
  (require('../index') as typeof import('../index')).default;

export interface MCPEngineOptions {
  /**
   * Whether to start the file watcher when initializing. Daemon and direct
   * modes both want this true; tests may set it false to keep the engine
   * cheap. Honors {@link watchDisabledReason} regardless.
   */
  watch?: boolean;

  /** Optional Semantic ObjC IndexStore watcher configuration. */
  semanticObjc?: unknown;
}

/**
 * Shared MCP engine. Thread-safe in the sense that multiple sessions can
 * call its methods concurrently — internally it serializes initialization
 * through a single promise so multiple sessions racing each other on first
 * connect never double-open the SQLite file.
 */
export class MCPEngine {
  private cg: CodeGraph | null = null;
  private toolHandler: ToolHandler;
  // Project root we resolved to. Null until `ensureInitialized` succeeds
  // (or null forever if no .codegraph/ ever turned up — that's a valid
  // state for the engine, since cross-project queries still work).
  private projectPath: string | null = null;
  // Set on first `ensureInitialized` so subsequent sessions don't redo work.
  private initPromise: Promise<void> | null = null;
  private watcherStarted = false;
  private opts: { watch: boolean; semanticObjc: SemanticObjcWatchConfig };
  private semanticObjcWatcher: SemanticObjcIndexStoreWatcher | null = null;
  private closed = false;

  constructor(opts: MCPEngineOptions = {}) {
    this.opts = {
      watch: opts.watch ?? true,
      semanticObjc: parseSemanticObjcWatchConfig(opts.semanticObjc),
    };
    this.toolHandler = new ToolHandler(null);
  }

  /**
   * Convenience for {@link MCPServer} compatibility: pre-seed an explicit
   * project path (from the `--path` CLI flag) without yet opening it. This
   * keeps the synchronous constructor cheap; the actual open happens on the
   * first `ensureInitialized` call.
   */
  setProjectPathHint(projectPath: string): void {
    this.projectPath = projectPath;
    this.toolHandler.setDefaultProjectHint(projectPath);
  }

  /** Project root that the engine resolved on first init (null if none). */
  getProjectPath(): string | null {
    return this.projectPath;
  }

  /** Shared ToolHandler — sessions delegate tool dispatch through this. */
  getToolHandler(): ToolHandler {
    return this.toolHandler;
  }

  /** Whether the default project's CodeGraph is open. */
  hasDefaultCodeGraph(): boolean {
    return this.toolHandler.hasDefaultCodeGraph();
  }

  /** Whether all background sync/enrichment work has drained. */
  isIdle(): boolean {
    return !this.cg || (
      !this.cg.isIndexing() &&
      !this.cg.hasPendingWatchSync() &&
      !this.semanticObjcWatcher?.hasPendingWork()
    );
  }

  /**
   * Walk up from `searchFrom` to find the nearest `.codegraph/` and open it.
   * Idempotent: concurrent callers share one in-flight init; subsequent
   * callers after success are no-ops.
   *
   * The original `MCPServer.tryInitializeDefault` carried the same retry-on-
   * subsequent-tool-call semantics; we preserve them by NOT throwing when the
   * search misses (just leaves `cg` null so the next call can retry).
   */
  async ensureInitialized(searchFrom: string): Promise<void> {
    if (this.closed) return;
    if (this.toolHandler.hasDefaultCodeGraph()) return;
    if (this.initPromise) {
      try { await this.initPromise; } catch { /* let caller retry */ }
      return;
    }

    this.initPromise = this.doInitialize(searchFrom).finally(() => {
      this.initPromise = null;
    });
    try {
      await this.initPromise;
    } catch {
      // Init errors are logged inside `doInitialize`; falling through here
      // matches MCPServer's previous "retry on next tool call" behavior.
    }
  }

  /**
   * Synchronous last-resort init used by the per-session retry loop when the
   * background `ensureInitialized` already finished (or failed) and we need
   * to pick up a project that appeared *after* the engine started.
   */
  retryInitializeSync(searchFrom: string): void {
    if (this.closed) return;
    if (this.toolHandler.hasDefaultCodeGraph()) return;
    this.toolHandler.setDefaultProjectHint(searchFrom);
    const resolvedRoot = findNearestCodeGraphRoot(searchFrom);
    if (!resolvedRoot) return;
    try {
      // Close any previously failed instance to avoid leaking resources.
      if (this.cg) {
        try { this.cg.close(); } catch { /* ignore */ }
        this.cg = null;
      }
      this.cg = loadCodeGraph().openSync(resolvedRoot);
      this.projectPath = resolvedRoot;
      this.toolHandler.setDefaultCodeGraph(this.cg);
      this.startWatching();
      this.catchUpSync();
    } catch {
      // Still failing — caller will try again on the next tool call.
    }
  }

  /**
   * Close everything. Used on graceful daemon shutdown (SIGTERM/idle timeout)
   * and on direct-mode stop. Idempotent.
   */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.toolHandler.closeAll();
    this.semanticObjcWatcher?.stop();
    this.semanticObjcWatcher = null;
    if (this.cg) {
      try { this.cg.close(); } catch { /* ignore */ }
      this.cg = null;
    }
  }

  private async doInitialize(searchFrom: string): Promise<void> {
    this.toolHandler.setDefaultProjectHint(searchFrom);

    const resolvedRoot = findNearestCodeGraphRoot(searchFrom);
    if (!resolvedRoot) {
      // No .codegraph/ above searchFrom. Sessions may still discover one later via roots/list
      this.projectPath = searchFrom;
      return;
    }

    this.projectPath = resolvedRoot;
    try {
      this.cg = await loadCodeGraph().open(resolvedRoot);
      this.toolHandler.setDefaultCodeGraph(this.cg);
      this.startWatching();
      this.catchUpSync();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[CodeGraph MCP] Failed to open project at ${resolvedRoot}: ${msg}\n`);
    }
  }

  /**
   * Start file watching on the active CodeGraph instance. Idempotent — the
   * watcher is per-engine, not per-session, which is why the daemon path
   * collapses N inotify sets to one. The wording of the disabled-reason log
   * exactly matches the prior in-tree implementation so log-driven dashboards
   * keep working.
   */
  private startWatching(): void {
    if (!this.cg || this.watcherStarted || !this.opts.watch) return;

    const disabledReason = watchDisabledReason(this.projectPath ?? process.cwd());
    if (disabledReason) {
      process.stderr.write(
        `[CodeGraph MCP] File watcher disabled — ${disabledReason}. ` +
        `The graph will not auto-update; run \`codegraph sync\` (or install the git sync hooks via \`codegraph init\`) to refresh.\n`
      );
      this.watcherStarted = true;
      return;
    }

    // Optional override for the debounce window via env var (issue #403).
    // Useful for workspaces with bursty writes (formatter-on-save chains,
    // large generated outputs) where the 2s default fires too often. Clamped
    // to [100ms, 60s]; out-of-range / non-numeric values fall back to the
    // FileWatcher default. We log the active value so it's discoverable.
    const debounceMs = parseDebounceEnv(process.env.CODEGRAPH_WATCH_DEBOUNCE_MS);
    if (debounceMs !== undefined) {
      process.stderr.write(`[CodeGraph MCP] File watcher debounce: ${debounceMs}ms (CODEGRAPH_WATCH_DEBOUNCE_MS)\n`);
    }

    const started = this.cg.watch({
      debounceMs,
      onSyncComplete: (result) => {
        if (result.filesChanged > 0) {
          process.stderr.write(
            `[CodeGraph MCP] Auto-synced ${result.filesChanged} file(s) in ${result.durationMs}ms\n`
          );
        }
      },
      onSyncError: (err) => {
        process.stderr.write(`[CodeGraph MCP] Auto-sync error: ${err.message}\n`);
      },
    });

    this.watcherStarted = true;
    if (started) {
      process.stderr.write('[CodeGraph MCP] File watcher active — graph will auto-sync on changes\n');
    } else {
      process.stderr.write(
        '[CodeGraph MCP] File watcher unavailable on this platform — run `codegraph sync` to refresh the graph after changes.\n'
      );
    }
  }

  private async startSemanticObjcWatching(): Promise<void> {
    if (this.semanticObjcWatcher) return;
    const baseConfig = this.opts.semanticObjc;
    if (!baseConfig.enabled || !baseConfig.watchIndexStore) return;
    const cg = this.cg;
    const projectRoot = this.projectPath;
    if (!cg || !projectRoot) return;

    let resolved: { helperPath: string; storePath: string; sourceRoot: string };
    try {
      resolved = await resolveSemanticObjcStorePathForProject(baseConfig, projectRoot, path.resolve(__dirname, '../..'), cg.getFiles());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason = msg === 'semantic-helper-not-found'
        ? msg
        : `semantic-indexstore-discovery-failed:${msg}`;
      cg.markSemanticObjcStale(reason);
      process.stderr.write(`[CodeGraph MCP] Semantic ObjC watch enabled but automatic setup failed for ${projectRoot}: ${reason}\n`);
      return;
    }

    const { helperPath, sourceRoot, storePath } = resolved;
    const config: SemanticObjcWatchConfig = { ...baseConfig, helperPath, storePath };
    const watcherOptions: SemanticObjcIndexStoreWatcherOptions = {
      config,
      lockPath: cg.getGraphLockPath(),
      isIdle: () => isSemanticObjcGraphIdle(cg),
      onState: (status, reason) => this.persistSemanticObjcWatchState(cg, status, reason),
      onSemanticDelta: async () => {
        await cg.enrichSemanticObjcWithGraphLockHeld({
          helperPath,
          storePath,
          helperSourceRoot: sourceRoot,
          languages: config.languages,
        });
      },
    };
    this.semanticObjcWatcher = new SemanticObjcIndexStoreWatcher(watcherOptions);
    const started = this.semanticObjcWatcher.start();
    const semanticObjcState = cg.getSemanticObjcState();
    if (
      started &&
      config.fallback === 'stale-then-idle-reconcile' &&
      (semanticObjcState.status === 'stale' || semanticObjcState.status === 'queued' || semanticObjcState.status === 'running')
    ) {
      this.semanticObjcWatcher.enqueueReconcile(`startup-${semanticObjcState.status}-reconcile`);
    }
    if (started) {
      process.stderr.write(
        `[CodeGraph MCP] Semantic ObjC IndexStore watch active for ${storePath} ` +
        `(delta=${config.deltaMode}, scheduler=${config.scheduler.mode})\n`
      );
    } else {
      process.stderr.write(`[CodeGraph MCP] Semantic ObjC IndexStore watch unavailable for ${storePath}\n`);
    }
  }

  private persistSemanticObjcWatchState(cg: CodeGraph, status: SemanticObjcStatus, reason?: string): void {
    if (status === 'queued') {
      cg.markSemanticObjcQueued(reason ?? 'semantic-queued');
    } else if (status === 'running') {
      cg.markSemanticObjcRunning(reason);
    } else if (status === 'failed') {
      cg.markSemanticObjcFailed(reason ?? 'semantic-watch-failed');
    } else if (status === 'stale' && reason) {
      cg.markSemanticObjcStale(reason);
    }
  }

  /**
   * Reconcile the index with the current filesystem once, right after open —
   * catches edits, adds, deletes, and `git pull`/`checkout` changes made while
   * no watcher was running. Runs in the background, but the returned promise
   * is pushed into the ToolHandler as a one-shot gate so the *first* tool
   * call awaits completion before serving (without this, a tool call that
   * races past sync returns rows for files that no longer exist on disk —
   * and the per-file staleness banner can't help because `getPendingFiles()`
   * is populated by the watcher, not by catch-up).
   */
  private catchUpSync(): void {
    const cg = this.cg;
    if (!cg) return;
    const p = cg
      .sync()
      .then((result) => {
        const changed = result.filesAdded + result.filesModified + result.filesRemoved;
        if (changed > 0) {
          process.stderr.write(`[CodeGraph MCP] Caught up ${changed} file(s) changed since last run\n`);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[CodeGraph MCP] Catch-up sync failed: ${msg}\n`);
      });
    this.toolHandler.setCatchUpGate(p);
    void p.finally(() => { void this.startSemanticObjcWatching(); });
  }
}

export function isSemanticObjcGraphIdle(cg: Pick<CodeGraph, 'isIndexing' | 'hasPendingWatchSync'>): boolean {
  return !cg.isIndexing() && !cg.hasPendingWatchSync();
}

export async function resolveSemanticObjcStorePathForProject(
  config: SemanticObjcWatchConfig,
  projectRoot: string,
  repoRoot = path.resolve(__dirname, '../..'),
  files?: ReturnType<CodeGraph['getFiles']>
): Promise<{ helperPath: string; storePath: string; sourceRoot: string }> {
  const helperPath = config.helperPath ?? locateHelperBinary(repoRoot);
  if (!helperPath) {
    throw new Error('semantic-helper-not-found');
  }
  const sourceRoot = inferSemanticObjcSourceRoot(projectRoot, files);
  return {
    helperPath,
    sourceRoot,
    storePath: config.storePath ?? await discoverIndexStorePath(helperPath, sourceRoot),
  };
}

/**
 * Parse and clamp the CODEGRAPH_WATCH_DEBOUNCE_MS env override.
 *
 * Issue #403: workspaces with bursty writes (formatter-on-save, multi-file
 * refactors) sometimes want a longer quiet window before sync. Returns
 * `undefined` for unset / empty / non-numeric / out-of-range values so the
 * FileWatcher default (2000ms) takes over — never throws.
 *
 * Clamp range: 100ms (faster would mean a sync per keystroke) to 60s (longer
 * and the watcher feels broken). Out-of-range values are treated as "ignore
 * this misconfiguration" rather than capped, since silently capping a 0 or
 * a typoed value would mask a real config bug.
 */
export function parseDebounceEnv(raw: string | undefined): number | undefined {
  if (!raw || !raw.trim()) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n < 100 || n > 60000) return undefined;
  return n;
}
