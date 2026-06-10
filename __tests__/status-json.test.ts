/**
 * Tests for the CI/scripting fields `codegraph status --json` exposes (issue
 * #329): the `version`, `indexPath`, and `lastIndexed` fields, plus the
 * matching `CodeGraph.getLastIndexedAt()` library method.
 *
 * The CLI itself is exercised end-to-end against the built binary so the JSON
 * field names survive future refactors of the underlying plumbing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { markSemanticObjcFailed, markSemanticObjcMergeCompleted, markSemanticObjcStale } from '../src/extraction/semantic-objc';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
).version as string;

function runCli(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runStatusJson(cwd: string): Record<string, unknown> {
  const stdout = runCli(cwd, ['status', '--json']);
  // JSON mode prints exactly one line to stdout; be defensive about any stray
  // leading output by parsing the last non-empty line.
  const line = stdout.trim().split('\n').filter(Boolean).pop()!;
  return JSON.parse(line);
}

describe('codegraph status --json — CI fields (#329)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-status-json-'));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('getLastIndexedAt() is null before indexing and a recent ms timestamp after', async () => {
    const cg = CodeGraph.initSync(tempDir);
    expect(cg.getLastIndexedAt()).toBeNull();

    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const before = Date.now();
    await cg.indexAll();
    const after = Date.now();

    const last = cg.getLastIndexedAt();
    expect(last).not.toBeNull();
    expect(typeof last).toBe('number');
    expect(last!).toBeGreaterThanOrEqual(before - 1000);
    expect(last!).toBeLessThanOrEqual(after + 1000);
    cg.close();
  });

  it('status --json on an UNINITIALIZED project reports version + indexPath + lastIndexed:null', () => {
    const out = runStatusJson(tempDir);
    expect(out.initialized).toBe(false);
    expect(out.version).toBe(PKG_VERSION);
    expect(typeof out.indexPath).toBe('string');
    expect(out.indexPath as string).toContain('.codegraph');
    expect(out.lastIndexed).toBeNull();
  });

  it('status --json on an INDEXED project reports version + indexPath + a round-trippable lastIndexed', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const before = Date.now();
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    const after = Date.now();
    cg.close();

    const out = runStatusJson(tempDir);
    expect(out.initialized).toBe(true);
    expect(out.version).toBe(PKG_VERSION);
    expect(out.indexPath as string).toContain('.codegraph');
    expect(typeof out.lastIndexed).toBe('string');
    // ISO string that round-trips back into the index window.
    const ms = Date.parse(out.lastIndexed as string);
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeLessThanOrEqual(after + 1000);
  });

  it.runIf(process.platform === 'darwin')('init --with-semantic-objc runs initial Semantic ObjC enrichment', () => {
    const projectDir = path.join(tempDir, 'project');
    const storePath = path.join(tempDir, 'Index.noindex', 'DataStore');
    const helperPath = path.join(tempDir, 'codegraph-xchelper');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(storePath, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'a.ts'), 'export const x = 1;\n');
    fs.writeFileSync(helperPath, [
      '#!/bin/sh',
      'printf \'%s\\n\' \'{"t":"meta","sourceRoot":"/tmp","languageFilter":["objc"],"includeSystem":false}\'',
      'printf \'%s\\n\' \'{"t":"cap","semanticDeltaVersion":1,"helperVersion":"test","unitFingerprintAlgorithm":"index-unit-v1","recordKinds":["unit","unit_file","sym","rel","ref"],"sourceMembership":true}\'',
      'printf \'%s\\n\' \'{"t":"done","symbols":0,"refs":0,"rels":0}\'',
    ].join('\n') + '\n');
    fs.chmodSync(helperPath, 0o755);

    runCli(projectDir, [
      'init',
      '--with-semantic-objc',
      '--semantic-objc-helper', helperPath,
      '--semantic-objc-store-path', storePath,
    ]);

    const out = runStatusJson(projectDir);
    const semanticObjc = out.semanticObjc as Record<string, any>;
    expect(semanticObjc.status).toBe('fresh');
    expect(semanticObjc.lastMergeSummary).toMatchObject({
      symsSeen: 0,
      refsSeen: 0,
      unitsSeen: 0,
    });
  });

  it('status --json includes Semantic ObjC summary, coverage, and diagnostics', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();

    const conn = DatabaseConnection.open(getDatabasePath(tempDir));
    try {
      markSemanticObjcMergeCompleted(conn.getDb(), {
        symsSeen: 3,
        symsMerged: 0,
        symsOutsideProject: 0,
        symsNotMatched: 3,
        unitsSeen: 0,
        unitsMerged: 0,
        unitFilesSeen: 0,
        unitFilesMerged: 0,
        ownershipRowsMerged: 0,
        relsSeen: 0,
        relsMerged: 0,
        relsSkipped: 0,
        relsAlreadyPresent: 0,
        refsSeen: 5,
        refsMerged: 0,
        refsOutsideProject: 0,
        refsNoSource: 0,
        refsNoTarget: 5,
        refsAlreadyPresent: 0,
        refsNonCall: 0,
      }, 1234);
      markSemanticObjcStale(conn.getDb(), 'database locked by another process', 1235);
    } finally {
      conn.close();
    }

    const out = runStatusJson(tempDir);
    const semanticObjc = out.semanticObjc as Record<string, any>;
    expect(semanticObjc.status).toBe('stale');
    expect(semanticObjc.lastMergeCompletedAt).toBe(1234);
    expect(semanticObjc.lastMergeSummary).toMatchObject({
      symsSeen: 3,
      symsMerged: 0,
      refsSeen: 5,
      refsNoTarget: 5,
    });
    expect(semanticObjc.coverage).toMatchObject({
      nodesWithUsr: 0,
      semanticEdges: 0,
      units: 0,
      unitFiles: 0,
      ownershipRows: 0,
    });
    expect((semanticObjc.diagnostics as Array<{ code: string }>).map((diag) => diag.code)).toEqual(expect.arrayContaining([
      'semantic-objc-helper-no-units',
      'semantic-objc-symbols-not-matching',
      'semantic-objc-refs-no-target-high',
      'semantic-objc-lock-failure',
    ]));
  });

  it('status --json reports failed Semantic ObjC watcher state', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();

    const conn = DatabaseConnection.open(getDatabasePath(tempDir));
    try {
      markSemanticObjcFailed(conn.getDb(), 'semantic-watch-boom', 1234);
    } finally {
      conn.close();
    }

    const out = runStatusJson(tempDir);
    const semanticObjc = out.semanticObjc as Record<string, any>;
    expect(semanticObjc.status).toBe('failed');
    expect(semanticObjc.reason).toBe('semantic-watch-boom');
    expect(semanticObjc.lastFailureAt).toBe(1234);
  });
});
