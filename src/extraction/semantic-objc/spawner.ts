/**
 * Spawn the codegraph-xchelper Swift helper and stream parsed NDJSON records.
 *
 * The helper is build-output from `src/extraction/semantic-objc/swift/`. We
 * expect it at `<repo>/src/extraction/semantic-objc/swift/.build/release/codegraph-xchelper`
 * during local development; once npm packaging is in place (Phase 2-γ) it'll
 * ship in an optional darwin-only sub-package.
 *
 * The spawner produces an async iterable of `XcRecord` values. Malformed lines
 * are dropped with a warning; the spawner only throws on helper exit failure.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isXcRecord, type XcRecord } from './types';
import { parseSemanticObjcSnapshotLine, type SemanticObjcSnapshotRecord } from './snapshot';

export interface SpawnerOptions {
  /** Absolute path to the codegraph-xchelper binary. */
  helperPath: string;
  /** Project source root (used both for --source-root and for relativizing paths). */
  sourceRoot: string;
  /** Optional explicit `.indexstore/DataStore` path. If omitted, helper runs discovery itself. */
  storePath?: string;
  /** Languages to include. Empty array = all. Default `['objc']`. */
  languages?: string[];
  /** Include SDK / system header occurrences. Default false. */
  includeSystem?: boolean;
  /** Optional cancellation signal for short-lived helper probes. */
  signal?: AbortSignal;
}

/**
 * Locate a built `codegraph-xchelper` binary under the repo's swift project.
 * Looks for the release build first, then debug as a fallback for local-dev runs.
 * Returns null if neither exists.
 */
export function findLocalHelperBinary(repoRoot: string): string | null {
  const swiftRoot = path.join(repoRoot, 'src/extraction/semantic-objc/swift/.build');
  const candidates = [
    path.join(repoRoot, 'packages/mac-objc-enricher/bin/codegraph-xchelper'),
    path.join(swiftRoot, 'release/codegraph-xchelper'),
    path.join(swiftRoot, 'debug/codegraph-xchelper'),
    path.join(swiftRoot, 'arm64-apple-macosx/release/codegraph-xchelper'),
    path.join(swiftRoot, 'x86_64-apple-macosx/release/codegraph-xchelper'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Locate the `codegraph-xchelper` binary shipped via the
 * `@colbymchenry/codegraph-mac-objc-enricher` optional npm subpackage. Returns
 * null when the subpackage is not installed (the expected case on non-darwin
 * platforms, since npm honours its `os` constraint).
 *
 * Used in production npm installs; `findLocalHelperBinary` covers the dev path
 * where the binary lives under the swift project's `.build/`.
 */
export function findShippedHelperBinary(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req: NodeJS.Require = typeof require === 'function'
      ? require
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      : (eval('require') as NodeJS.Require);
    const pkgJson = req.resolve('@colbymchenry/codegraph-mac-objc-enricher/package.json');
    const binPath = path.join(path.dirname(pkgJson), 'bin', 'codegraph-xchelper');
    return fs.existsSync(binPath) ? binPath : null;
  } catch {
    return null;
  }
}

/**
 * Try every known location for the helper binary in priority order:
 *   1. Shipped subpackage (production npm install on darwin)
 *   2. Local dev build under the given repo root
 *   3. Local dev build under process.cwd() — covers `npm link`-style setups
 * Returns the first existing path, or null when nothing's available.
 */
export function locateHelperBinary(repoRoot?: string): string | null {
  const shipped = findShippedHelperBinary();
  if (shipped) return shipped;
  if (repoRoot) {
    const dev = findLocalHelperBinary(repoRoot);
    if (dev) return dev;
  }
  return findLocalHelperBinary(process.cwd());
}

export async function discoverIndexStorePath(helperPath: string, sourceRoot: string): Promise<string> {
  const child: ChildProcess = spawn(helperPath, ['discover', '--source-root', sourceRoot], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));

  await new Promise<void>((resolve, reject) => {
    child.once('error', (err) => {
      // 'error' usually means the spawn itself failed, but if the process did
      // start, don't leak it past the rejection.
      if (!child.killed) child.kill('SIGTERM');
      reject(err);
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = stderrChunks.join('').trim();
      reject(new Error(`codegraph-xchelper discover exited with code ${code}${stderr ? `: ${stderr}` : ''}`));
    });
  });

  const discovered = stdoutChunks.join('').trim().split(/\r?\n/)[0]?.trim();
  if (!discovered) {
    throw new Error('codegraph-xchelper discover returned no IndexStore path');
  }
  return discovered;
}

export interface SpawnerHandle {
  /** Async iterable over parsed NDJSON records. */
  records(): AsyncIterable<XcRecord>;
  /** Wait for the helper to exit; rejects if exit code != 0. */
  wait(): Promise<void>;
  /** Kill the helper subprocess (e.g. on cancellation). */
  cancel(): void;
}

/**
 * Spawn the helper with `dump` subcommand and return a handle exposing the
 * record stream and lifecycle controls.
 */
export function spawnHelper(opts: SpawnerOptions): SpawnerHandle {
  const args = ['dump', '--source-root', opts.sourceRoot];
  if (opts.storePath) {
    args.push('--store-path', opts.storePath);
  }
  const langs = opts.languages ?? ['objc'];
  if (langs.length > 0) {
    args.push('--language', ...langs);
  }
  if (opts.includeSystem) {
    args.push('--include-system');
  }

  const child: ChildProcess = spawn(opts.helperPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrChunks: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk.toString('utf8'));
  });

  const exitPromise: Promise<void> = new Promise((resolve, reject) => {
    child.once('error', (err) => reject(err));
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const stderr = stderrChunks.join('').trim();
        reject(new Error(`codegraph-xchelper exited with code ${code}${stderr ? `: ${stderr}` : ''}`));
      }
    });
  });

  async function* iterate(): AsyncIterable<XcRecord> {
    if (!child.stdout) return;
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let drained = false;
    try {
      for await (const line of rl) {
        if (!line) continue;
        const parsed = parseNdjsonLine(line);
        if (parsed) yield parsed;
      }
      drained = true;
    } finally {
      // A consumer that breaks out early closes the generator here — reap the
      // helper instead of leaving it writing into a dead pipe. (Skipped after
      // a full drain: stdout EOF means the helper is exiting on its own, and a
      // late SIGTERM could turn its clean exit into a wait() rejection.)
      if (!drained && !child.killed) child.kill('SIGTERM');
    }
  }

  return {
    records: () => iterate(),
    wait: () => exitPromise,
    cancel: () => {
      if (!child.killed) child.kill('SIGTERM');
    },
  };
}

export async function spawnSemanticObjcSnapshot(opts: SpawnerOptions): Promise<SemanticObjcSnapshotRecord> {
  const capturedAtMs = Date.now();
  const args = ['snapshot', '--source-root', opts.sourceRoot];
  if (opts.storePath) {
    args.push('--store-path', opts.storePath);
  }
  const langs = opts.languages ?? ['objc'];
  if (langs.length > 0) {
    args.push('--language', ...langs);
  }
  if (opts.includeSystem) {
    args.push('--include-system');
  }

  const child: ChildProcess = spawn(opts.helperPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const abort = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  if (opts.signal?.aborted) abort();
  opts.signal?.addEventListener('abort', abort, { once: true });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', (err) => reject(err));
      child.once('close', (code) => {
        if (opts.signal?.aborted) {
          reject(new Error('semantic-snapshot-wait-aborted'));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const stderr = stderrChunks.join('').trim();
        reject(new Error(`codegraph-xchelper snapshot exited with code ${code}${stderr ? `: ${stderr}` : ''}`));
      });
    });
  } finally {
    opts.signal?.removeEventListener('abort', abort);
  }

  for (const line of stdoutChunks.join('').split(/\r?\n/)) {
    const parsed = parseSemanticObjcSnapshotLine(line.trim());
    if (parsed) return parsed.capturedAtMs === undefined ? { ...parsed, capturedAtMs } : parsed;
  }
  throw new Error('codegraph-xchelper snapshot returned no valid semantic snapshot');
}

/**
 * Parse a single NDJSON record line. Returns null on parse failure — the helper
 * is the source of truth and we'd rather skip a malformed line than crash.
 */
export function parseNdjsonLine(line: string): XcRecord | null {
  try {
    const parsed = JSON.parse(line);
    return isXcRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Helper for tests: turn an async iterable of records into an in-process
 * SpawnerHandle, bypassing the real child process. Lets the merger be tested
 * with synthetic NDJSON without any Swift dependency.
 */
export function recordSourceHandle(records: AsyncIterable<XcRecord>): SpawnerHandle {
  return {
    records: () => records,
    wait: () => Promise.resolve(),
    cancel: () => {},
  };
}
