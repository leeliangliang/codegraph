/**
 * Real-pipeline semantic ObjC e2e test.
 *
 * Unlike `semantic-objc-e2e.test.ts` (which stubs the Swift helper with
 * synthetic NDJSON), this test exercises the actual binary chain:
 *
 *   real clang  →  real .indexstore  →  real codegraph-xchelper Swift binary
 *                                       →  real NDJSON over stdio
 *                                       →  real merger writes to real SQLite
 *
 * Skipped automatically when any of the prerequisites is missing — non-darwin,
 * no clang in PATH, no helper binary built. So local dev runs as normal but CI
 * on macos-latest (with `npm run build:mac-objc-helper` ahead of time) exercises
 * the full pipeline. Tree-sitter is intentionally bypassed — nodes are seeded
 * with prepared statements so this test stays narrowly focused on the
 * helper-↔-merger interface.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseConnection } from '../src/db';
import {
  enrichWithIndexStore,
  findLocalHelperBinary,
  findShippedHelperBinary,
} from '../src/extraction/semantic-objc';

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/objc-e2e');

function locateHelper(): string | null {
  return (
    findShippedHelperBinary() ??
    findLocalHelperBinary(path.resolve(__dirname, '..'))
  );
}

function isClangAvailable(): boolean {
  const r = spawnSync('xcrun', ['--find', 'clang'], { stdio: 'pipe' });
  return r.status === 0 && r.stdout.toString().trim().length > 0;
}

const helperPath = process.platform === 'darwin' ? locateHelper() : null;
const clangPresent = process.platform === 'darwin' && isClangAvailable();
const shouldRun = process.platform === 'darwin' && helperPath !== null && clangPresent;

const describeOrSkip = shouldRun ? describe : describe.skip;

describeOrSkip('Semantic ObjC e2e (real clang + real helper)', () => {
  let projectDir: string;
  let storePath: string;
  let conn: DatabaseConnection;

  beforeAll(() => {
    // Stage the fixture files under a fresh tmp dir so `nodes.file_path`
    // (relative to projectDir) matches what the helper will emit relative to
    // --source-root.
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semobjc-real-'));
    fs.mkdirSync(path.join(projectDir, '.codegraph'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'Sources'), { recursive: true });
    for (const f of ['Util.h', 'Util.m', 'MyVC.h', 'MyVC.m']) {
      fs.copyFileSync(path.join(FIXTURE_DIR, f), path.join(projectDir, 'Sources', f));
    }

    // Build a real .indexstore with clang -index-store-path. This is exactly
    // what xcodebuild does under the hood when COMPILER_INDEX_STORE_ENABLE=YES.
    storePath = path.join(projectDir, '.indexstore');
    fs.mkdirSync(storePath, { recursive: true });
    const sdkPath = execFileSync('xcrun', ['--show-sdk-path']).toString().trim();
    const frameworkPath = `${sdkPath}/System/Library/Frameworks`;

    for (const file of ['Util.m', 'MyVC.m']) {
      const objOut = path.join(projectDir, `${file}.o`);
      execFileSync('xcrun', [
        'clang',
        '-c',
        '-x', 'objective-c',
        '-fobjc-arc',
        '-isysroot', sdkPath,
        '-F', frameworkPath,
        '-index-store-path', storePath,
        '-o', objOut,
        path.join(projectDir, 'Sources', file),
      ], { stdio: 'pipe' });
    }

    // Initialise an empty CodeGraph database. We seed nodes manually below to
    // keep this test independent of tree-sitter (covered by the synthetic e2e).
    conn = DatabaseConnection.initialize(path.join(projectDir, '.codegraph', 'graph.db'));
  });

  afterAll(() => {
    conn?.close();
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
  });

  /** Insert a minimal tree-sitter-style node directly into the DB. */
  function seedNode(
    id: string,
    kind: string,
    name: string,
    filePath: string,
    startLine: number,
    endLine: number = startLine + 3
  ): void {
    conn.getDb().prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                         start_line, end_line, start_column, end_column, updated_at)
      VALUES (?, ?, ?, ?, ?, 'objc', ?, ?, 0, 0, ?)
    `).run(id, kind, name, name, filePath, startLine, endLine, Date.now());
  }

  // The helper opens LMDB and walks every canonical symbol once — cheap for
  // this 4-file fixture but the cold-start overhead can run a few seconds on a
  // busy CI runner. The vitest default of 5 s is too tight.
  it('populates USRs + semantic call edge from a real clang-built indexstore', { timeout: 60_000 }, async () => {
    // Seed nodes at the lines where the helper emits canonical occurrences —
    // verified by running `codegraph-xchelper dump` directly on the fixture.
    // Classes are emitted at their @interface in the .h files; methods are
    // emitted at the implementation site in the .m files (clang prefers the
    // definition over the declaration as the canonical occurrence).
    seedNode('util-class',  'class',  'Util',   'Sources/Util.h', 3);
    seedNode('myvc-class',  'class',  'MyVC',   'Sources/MyVC.h', 3);
    seedNode('util-helper', 'method', 'helper', 'Sources/Util.m', 5);
    // MyVC.m: `-run` definition spans lines 6..8 (the body is line 7 — also
    // where the `[Util helper];` call site lives).
    seedNode('myvc-run-def', 'method', 'run',   'Sources/MyVC.m', 6, 8);

    const summary = await enrichWithIndexStore(conn.getDb(), {
      helperPath: helperPath!,
      projectRoot: projectDir,
      helperSourceRoot: projectDir,
      storePath,
      languages: ['objc'],
    });

    // The helper saw both Util.m and MyVC.m TUs; symbols include the class/method
    // declarations in the headers and definitions in the .m files.
    expect(summary.symsSeen).toBeGreaterThan(0);
    expect(summary.symsMerged).toBeGreaterThan(0);

    // Util.helper USR ends up on the seeded node.
    const utilHelperUSR = (conn.getDb().prepare(
      'SELECT usr FROM nodes WHERE id = ?'
    ).get('util-helper') as { usr: string | null }).usr;
    expect(utilHelperUSR).toBeTruthy();
    expect(utilHelperUSR).toMatch(/^c:objc.*helper/);

    // The call site at MyVC.m line 7 (`[Util helper];`) is inside the run-def
    // span (6..8), so the semantic call edge bridges run-def → util-helper.
    const callEdge = conn.getDb().prepare(
      'SELECT source, target, kind, line, col, metadata ' +
      'FROM edges WHERE provenance = ? AND kind = ? AND source = ? AND target = ?'
    ).get('semantic-objc', 'calls', 'myvc-run-def', 'util-helper') as
      | { source: string; target: string; kind: string; line: number; col: number; metadata: string }
      | undefined;

    expect(callEdge, 'expected a semantic-objc calls edge from myvc-run-def to util-helper').toBeDefined();
    expect(callEdge!.line).toBe(7);
    const meta = JSON.parse(callEdge!.metadata);
    expect(meta.role).toBe('call');
    // `[Util helper]` is a class-method message send on a known concrete class
    // — clang should resolve it statically, not flag it as dynamic.
    expect(meta.dynamic).toBe(false);
  });
});
