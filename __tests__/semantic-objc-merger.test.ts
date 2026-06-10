/**
 * semantic-objc merger tests
 *
 * Drives `mergeFromHelper` with a synthetic NDJSON stream (no Swift dependency)
 * to verify the three-phase merge:
 *
 *   Phase A — `sym` records populate `nodes.usr` for matching (file_path, start_line)
 *   Phase B — `rel` records create new edges with `provenance = 'semantic-objc'`,
 *             idempotent on rerun
 *   Phase C — `ref` records with `role: 'call'` create semantic `calls` edges
 *             from the containing source node to the resolved target USR
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import type { FileRecord } from '../src/types';
import {
  findLocalHelperBinary,
  getSemanticObjcState,
  inferSemanticObjcSourceRoot,
  markSemanticObjcMergeCompleted,
  markSemanticObjcStale,
  mergeFromHelper,
  recordSourceHandle,
  canonicaliseSymPath,
} from '../src/extraction/semantic-objc';
import type { XcRecord } from '../src/extraction/semantic-objc';

let tmpDir: string;
let conn: DatabaseConnection;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semobjc-test-'));
  const dbPath = path.join(tmpDir, 'graph.db');
  conn = DatabaseConnection.initialize(dbPath);
});

afterEach(() => {
  conn.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Insert a minimal tree-sitter-style node. Mirrors what extractor would store. */
function seedNode(
  id: string,
  kind: string,
  name: string,
  filePath: string,
  startLine: number,
  endLine: number = startLine + 5
): void {
  conn.getDb().prepare(`
    INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                       start_line, end_line, start_column, end_column, updated_at)
    VALUES (?, ?, ?, ?, ?, 'objc', ?, ?, 0, 0, ?)
  `).run(id, kind, name, name, filePath, startLine, endLine, Date.now());
}

async function* synth(records: XcRecord[]): AsyncIterable<XcRecord> {
  for (const r of records) yield r;
}

describe('semantic-objc helper discovery', () => {
  it('finds the packaged local helper built for the optional npm subpackage', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const expected = path.join(repoRoot, 'packages/mac-objc-enricher/bin/codegraph-xchelper');
    if (!fs.existsSync(expected)) return;

    expect(findLocalHelperBinary(repoRoot)).toBe(expected);
  });
});

describe('semantic-objc source root inference', () => {
  it('uses an indexed Xcode workspace subdirectory instead of the repository parent', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semobjc-root-'));
    try {
      fs.mkdirSync(path.join(projectRoot, 'MvBox/mvbox.xcworkspace'), { recursive: true });
      const files = [
        { path: 'MvBox/Sources/MyVC.m' },
        { path: 'MvBox/Sources/MyVC.h' },
        { path: 'Other/Generated.swift' },
      ] as FileRecord[];

      expect(inferSemanticObjcSourceRoot(projectRoot, files)).toBe(path.join(projectRoot, 'MvBox'));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('semantic-objc canonicaliseSymPath', () => {
  it('returns relative paths unchanged when helper and project roots are identical', () => {
    expect(canonicaliseSymPath('Sources/MyVC.m', '/proj', '/proj')).toBe('Sources/MyVC.m');
  });

  it('rebases helper-relative paths when roots differ', () => {
    expect(canonicaliseSymPath('Sources/MyVC.m', '/proj/workspace', '/proj')).toBe(
      'workspace/Sources/MyVC.m'
    );
  });

  it('does not collapse helper-relative paths from a sibling workspace into the indexed project', () => {
    expect(canonicaliseSymPath('MvBox/Sources/MyVC.m', '/Users/lee/Documents/VVGit/4', '/Users/lee/Documents/VVGit')).toBe(
      '4/MvBox/Sources/MyVC.m'
    );
  });

  it('converts absolute paths inside the project tree to relative', () => {
    expect(canonicaliseSymPath('/proj/Sources/MyVC.m', '/proj', '/proj')).toBe('Sources/MyVC.m');
  });

  it('returns null for absolute paths outside the project (DerivedData, frameworks)', () => {
    expect(
      canonicaliseSymPath(
        '/Users/lee/Library/Developer/Xcode/DerivedData/Foo/XCFramework/Foundation.h',
        '/proj',
        '/proj'
      )
    ).toBeNull();
  });
});

describe('semantic-objc mergeFromHelper — Phase A (sym → usr)', () => {
  it('populates nodes.usr for matching (file_path, start_line)', async () => {
    seedNode('n1', 'class', 'MyVC', 'Sources/MyVC.m', 12);
    seedNode('n2', 'method', 'viewDidLoad', 'Sources/MyVC.m', 30);

    const handle = recordSourceHandle(synth([
      { t: 'meta', sourceRoot: '/proj', languageFilter: ['objc'], includeSystem: false },
      { t: 'sym', usr: 'c:objc(cs)MyVC', name: 'MyVC', kind: 'class', lang: 'objc',
        file: 'Sources/MyVC.m', line: 12, col: 17, isDecl: false, isDef: true, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)MyVC(im)viewDidLoad', name: 'viewDidLoad', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/MyVC.m', line: 30, col: 11, isDecl: false, isDef: true, isSystem: false },
      { t: 'done', symbols: 2, refs: 0, rels: 0 },
    ]));

    const summary = await mergeFromHelper(conn.getDb(), handle, {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });

    expect(summary.symsSeen).toBe(2);
    expect(summary.symsMerged).toBe(2);
    expect(summary.symsNotMatched).toBe(0);
    expect(summary.symsOutsideProject).toBe(0);

    const n1 = conn.getDb().prepare('SELECT usr FROM nodes WHERE id = ?').get('n1') as { usr: string };
    expect(n1.usr).toBe('c:objc(cs)MyVC');
    const n2 = conn.getDb().prepare('SELECT usr FROM nodes WHERE id = ?').get('n2') as { usr: string };
    expect(n2.usr).toBe('c:objc(cs)MyVC(im)viewDidLoad');
  });

  it('counts symbols outside the project tree without crashing', async () => {
    seedNode('n1', 'class', 'MyVC', 'Sources/MyVC.m', 12);

    const handle = recordSourceHandle(synth([
      { t: 'sym', usr: 'c:objc(cs)MyVC', name: 'MyVC', kind: 'class', lang: 'objc',
        file: 'Sources/MyVC.m', line: 12, col: 17, isDecl: false, isDef: true, isSystem: false },
      // DerivedData/framework — outside the project
      { t: 'sym', usr: 'c:objc(cs)NSObject', name: 'NSObject', kind: 'class', lang: 'objc',
        file: '/Users/lee/Library/Developer/Xcode/DerivedData/Foo/Foundation.h',
        line: 1, col: 1, isDecl: true, isDef: false, isSystem: false },
      { t: 'done', symbols: 2, refs: 0, rels: 0 },
    ]));

    const summary = await mergeFromHelper(conn.getDb(), handle, {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });

    expect(summary.symsMerged).toBe(1);
    expect(summary.symsOutsideProject).toBe(1);
  });

  it('counts unmatched symbols (file exists in project but no tree-sitter node at that line)', async () => {
    seedNode('n1', 'class', 'MyVC', 'Sources/MyVC.m', 12);

    const handle = recordSourceHandle(synth([
      { t: 'sym', usr: 'c:objc(cs)Other', name: 'Other', kind: 'class', lang: 'objc',
        file: 'Sources/Other.m', line: 99, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'done', symbols: 1, refs: 0, rels: 0 },
    ]));

    const summary = await mergeFromHelper(conn.getDb(), handle, {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });
    expect(summary.symsMerged).toBe(0);
    expect(summary.symsNotMatched).toBe(1);
  });
});

describe('semantic-objc mergeFromHelper — delta metadata persistence', () => {
  it('persists unit, source membership, ownership rows, merge summary, and fresh state', async () => {
    seedNode('n1', 'class', 'MyVC', 'Sources/MyVC.m', 12);

    const handle = recordSourceHandle(synth([
      {
        t: 'cap',
        semanticDeltaVersion: 1,
        helperVersion: 'helper-v1',
        unitFingerprintAlgorithm: 'index-unit-v1',
        recordKinds: ['unit', 'unit_file', 'sym', 'rel', 'ref'],
        sourceMembership: true,
      },
      { t: 'unit', unit_id: 'unit-1', fingerprint: 'fp-1', main_file: 'Sources/MyVC.m' },
      { t: 'unit_file', unit_id: 'unit-1', file: 'Sources/MyVC.m', role: 'primary' },
      { t: 'sym', usr: 'c:objc(cs)MyVC', name: 'MyVC', kind: 'class', lang: 'objc',
        file: 'Sources/MyVC.m', line: 12, col: 17, isDecl: false, isDef: true, isSystem: false },
      { t: 'done', symbols: 1, refs: 0, rels: 0 },
    ]));

    const summary = await mergeFromHelper(conn.getDb(), handle, {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });

    expect(summary.unitsMerged).toBe(1);
    expect(summary.unitFilesMerged).toBe(1);
    expect(summary.ownershipRowsMerged).toBe(1);
    expect(conn.getDb().prepare('SELECT fingerprint, fingerprint_algo, helper_version, status FROM semantic_objc_units WHERE unit_id = ?').get('unit-1')).toEqual({
      fingerprint: 'fp-1',
      fingerprint_algo: 'index-unit-v1',
      helper_version: 'helper-v1',
      status: 'fresh',
    });
    expect(conn.getDb().prepare('SELECT file_path, role FROM semantic_objc_unit_files WHERE unit_id = ?').get('unit-1')).toEqual({
      file_path: 'Sources/MyVC.m',
      role: 'primary',
    });
    expect(conn.getDb().prepare('SELECT node_id, unit_id, file_path, usr, ownership FROM semantic_objc_node_ownership').get()).toEqual({
      node_id: 'n1',
      unit_id: 'unit-1',
      file_path: 'Sources/MyVC.m',
      usr: 'c:objc(cs)MyVC',
      ownership: 'exclusive',
    });

    const state = getSemanticObjcState(conn.getDb());
    expect(state.status).toBe('fresh');
    expect(state.lastMergeCompletedAt).toEqual(expect.any(Number));
    expect(state.lastMergeSummary).toMatchObject({
      symsSeen: 1,
      symsMerged: 1,
      unitsSeen: 1,
      unitsMerged: 1,
      unitFilesSeen: 1,
      unitFilesMerged: 1,
      ownershipRowsMerged: 1,
    });
    expect(state.coverage).toMatchObject({
      nodesWithUsr: 1,
      semanticEdges: 0,
      semanticCallEdges: 0,
      semanticNonCallEdges: 0,
      units: 1,
      unitFiles: 1,
      ownershipRows: 1,
    });
  });

  it('ignores invalid stored merge summary JSON', () => {
    conn.getDb().prepare(
      'INSERT OR REPLACE INTO semantic_objc_state (key, value, updated_at) VALUES (?, ?, ?)'
    ).run('last_merge_summary_json', '{not json', Date.now());

    expect(() => getSemanticObjcState(conn.getDb())).not.toThrow();
    expect(getSemanticObjcState(conn.getDb()).lastMergeSummary).toBeUndefined();
  });

  it('reports coverage and diagnostics for partial semantic state', () => {
    seedNode('source', 'method', 'load', 'Sources/MyVC.m', 10);
    seedNode('target', 'method', 'render', 'Sources/MyVC.m', 20);
    conn.getDb().prepare('UPDATE nodes SET usr = ? WHERE id = ?').run('usr:source', 'source');
    conn.getDb().prepare(`
      INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
      VALUES (?, ?, 'calls', NULL, NULL, NULL, 'semantic-objc')
    `).run('source', 'target');
    markSemanticObjcMergeCompleted(conn.getDb(), {
      symsSeen: 2,
      symsMerged: 0,
      symsOutsideProject: 0,
      symsNotMatched: 2,
      unitsSeen: 0,
      unitsMerged: 0,
      unitFilesSeen: 0,
      unitFilesMerged: 0,
      ownershipRowsMerged: 0,
      relsSeen: 0,
      relsMerged: 0,
      relsSkipped: 0,
      relsAlreadyPresent: 0,
      refsSeen: 10,
      refsMerged: 0,
      refsOutsideProject: 0,
      refsNoSource: 0,
      refsNoTarget: 9,
      refsAlreadyPresent: 0,
      refsNonCall: 0,
    }, 1234);
    markSemanticObjcStale(conn.getDb(), 'database locked by another process', 1235);

    const state = getSemanticObjcState(conn.getDb());
    expect(state.coverage).toMatchObject({
      nodesWithUsr: 1,
      semanticEdges: 1,
      semanticCallEdges: 1,
      semanticNonCallEdges: 0,
      units: 0,
      unitFiles: 0,
      ownershipRows: 0,
    });
    expect(state.diagnostics?.map((diag) => diag.code)).toEqual(expect.arrayContaining([
      'semantic-objc-units-missing-with-edges',
      'semantic-objc-helper-no-units',
      'semantic-objc-symbols-not-matching',
      'semantic-objc-refs-no-target-high',
      'semantic-objc-lock-failure',
    ]));
  });

  it('reports fresh-without-merged-units when helper saw units but metadata is empty', () => {
    markSemanticObjcMergeCompleted(conn.getDb(), {
      symsSeen: 1,
      symsMerged: 1,
      symsOutsideProject: 0,
      symsNotMatched: 0,
      unitsSeen: 2,
      unitsMerged: 2,
      unitFilesSeen: 3,
      unitFilesMerged: 3,
      ownershipRowsMerged: 0,
      relsSeen: 0,
      relsMerged: 0,
      relsSkipped: 0,
      relsAlreadyPresent: 0,
      refsSeen: 0,
      refsMerged: 0,
      refsOutsideProject: 0,
      refsNoSource: 0,
      refsNoTarget: 0,
      refsAlreadyPresent: 0,
      refsNonCall: 0,
    }, 1000);
    conn.getDb().prepare(
      'INSERT OR REPLACE INTO semantic_objc_state (key, value, updated_at) VALUES (?, ?, ?)'
    ).run('status', 'fresh', 1000);

    const state = getSemanticObjcState(conn.getDb());
    expect(state.diagnostics?.map((diag) => diag.code)).toContain('semantic-objc-fresh-without-merged-units');
  });
});

describe('semantic-objc mergeFromHelper — Phase B (rel → edges)', () => {
  it('inserts override edges with provenance=semantic-objc when both endpoints resolve', async () => {
    seedNode('child', 'method', 'viewDidLoad', 'Sources/MyVC.m', 30);
    seedNode('parent', 'method', 'viewDidLoad', 'Frameworks/UIKit/UIVC.h', 100);

    const handle = recordSourceHandle(synth([
      { t: 'sym', usr: 'c:objc(cs)MyVC(im)viewDidLoad', name: 'viewDidLoad', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/MyVC.m', line: 30, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)UIVC(im)viewDidLoad', name: 'viewDidLoad', kind: 'instanceMethod', lang: 'objc',
        file: 'Frameworks/UIKit/UIVC.h', line: 100, col: 1, isDecl: true, isDef: false, isSystem: false },
      { t: 'rel', kind: 'override',
        parent: 'c:objc(cs)UIVC(im)viewDidLoad',
        child:  'c:objc(cs)MyVC(im)viewDidLoad' },
      { t: 'done', symbols: 2, refs: 0, rels: 1 },
    ]));

    const summary = await mergeFromHelper(conn.getDb(), handle, {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });

    expect(summary.relsMerged).toBe(1);
    expect(summary.relsSkipped).toBe(0);

    const edge = conn.getDb().prepare(
      'SELECT source, target, kind, provenance FROM edges WHERE provenance = ?'
    ).get('semantic-objc') as { source: string; target: string; kind: string; provenance: string };

    expect(edge.source).toBe('child');
    expect(edge.target).toBe('parent');
    expect(edge.kind).toBe('override');
  });

  it('skips relations where one endpoint USR is outside the project', async () => {
    seedNode('child', 'method', 'foo', 'Sources/MyVC.m', 30);

    const handle = recordSourceHandle(synth([
      { t: 'sym', usr: 'c:objc(cs)MyVC(im)foo', name: 'foo', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/MyVC.m', line: 30, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'rel', kind: 'override',
        parent: 'c:objc(cs)ExternalLibFoo(im)foo',
        child:  'c:objc(cs)MyVC(im)foo' },
      { t: 'done', symbols: 1, refs: 0, rels: 1 },
    ]));

    const summary = await mergeFromHelper(conn.getDb(), handle, {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });

    expect(summary.relsMerged).toBe(0);
    expect(summary.relsSkipped).toBe(1);
    const edgeCount = (conn.getDb().prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c;
    expect(edgeCount).toBe(0);
  });

  it('is idempotent — re-running the same NDJSON does not duplicate edges', async () => {
    seedNode('child', 'method', 'init', 'Sources/MyVC.m', 30);
    seedNode('parent', 'method', 'init', 'Frameworks/UIKit/NSObject.h', 100);

    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(cs)MyVC(im)init', name: 'init', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/MyVC.m', line: 30, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)NSObject(im)init', name: 'init', kind: 'instanceMethod', lang: 'objc',
        file: 'Frameworks/UIKit/NSObject.h', line: 100, col: 1, isDecl: true, isDef: false, isSystem: false },
      { t: 'rel', kind: 'override',
        parent: 'c:objc(cs)NSObject(im)init',
        child:  'c:objc(cs)MyVC(im)init' },
      { t: 'done', symbols: 2, refs: 0, rels: 1 },
    ];

    const first = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });
    expect(first.relsMerged).toBe(1);
    expect(first.relsAlreadyPresent).toBe(0);

    const second = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });
    expect(second.relsMerged).toBe(0);
    expect(second.relsAlreadyPresent).toBe(1);

    const edgeCount = (conn.getDb().prepare(
      'SELECT COUNT(*) AS c FROM edges WHERE provenance = ?'
    ).get('semantic-objc') as { c: number }).c;
    expect(edgeCount).toBe(1);
  });
});

describe('semantic-objc mergeFromHelper — Phase C (ref → semantic call edges)', () => {
  it('inserts a calls edge from the containing source node to the resolved target', async () => {
    // The calling method, lines 30..50 — the ref at line 35 falls inside it.
    seedNode('caller', 'method', 'run', 'Sources/MyVC.m', 30, 50);
    // The callee, identified by USR.
    seedNode('callee', 'method', 'helper', 'Sources/Util.m', 10, 12);

    const records: XcRecord[] = [
      // Populate USRs so findNodeByUSRStmt finds the callee.
      { t: 'sym', usr: 'c:objc(cs)Util(im)helper', name: 'helper', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Util.m', line: 10, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'ref', to_usr: 'c:objc(cs)Util(im)helper', role: 'call',
        file: 'Sources/MyVC.m', line: 35, col: 11, dynamic: false },
      { t: 'done', symbols: 1, refs: 1, rels: 0 },
    ];

    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });

    expect(summary.refsSeen).toBe(1);
    expect(summary.refsMerged).toBe(1);
    expect(summary.refsNoSource).toBe(0);
    expect(summary.refsNoTarget).toBe(0);

    const edge = conn.getDb().prepare(
      'SELECT source, target, kind, line, col, metadata FROM edges WHERE provenance = ? AND kind = ?'
    ).get('semantic-objc', 'calls') as
      { source: string; target: string; kind: string; line: number; col: number; metadata: string };

    expect(edge.source).toBe('caller');
    expect(edge.target).toBe('callee');
    expect(edge.line).toBe(35);
    expect(edge.col).toBe(11);
    const metadata = JSON.parse(edge.metadata);
    expect(metadata.dynamic).toBe(false);
    expect(metadata.role).toBe('call');
  });

  it('preserves the dynamic flag for id-typed dispatch calls', async () => {
    seedNode('caller', 'method', 'run', 'Sources/MyVC.m', 30, 50);
    seedNode('callee', 'method', 'apiKey', 'Sources/Cfg.m', 5, 7);

    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(cs)Cfg(im)apiKey', name: 'apiKey', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Cfg.m', line: 5, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'ref', to_usr: 'c:objc(cs)Cfg(im)apiKey', role: 'call',
        file: 'Sources/MyVC.m', line: 40, col: 22, dynamic: true },
      { t: 'done', symbols: 1, refs: 1, rels: 0 },
    ];

    await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });

    const edge = conn.getDb().prepare(
      'SELECT metadata FROM edges WHERE provenance = ? AND kind = ?'
    ).get('semantic-objc', 'calls') as { metadata: string };
    expect(JSON.parse(edge.metadata).dynamic).toBe(true);
  });

  it('skips refs whose callee USR is not present as a node', async () => {
    seedNode('caller', 'method', 'run', 'Sources/MyVC.m', 30, 50);

    const records: XcRecord[] = [
      { t: 'ref', to_usr: 'c:objc(cs)UnknownExternalLib(im)foo', role: 'call',
        file: 'Sources/MyVC.m', line: 35, col: 11, dynamic: false },
      { t: 'done', symbols: 0, refs: 1, rels: 0 },
    ];

    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });
    expect(summary.refsNoTarget).toBe(1);
    expect(summary.refsMerged).toBe(0);
  });

  it('skips refs whose call site lies outside any indexed node', async () => {
    seedNode('callee', 'method', 'foo', 'Sources/Util.m', 10);

    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(cs)Util(im)foo', name: 'foo', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Util.m', line: 10, col: 1, isDecl: false, isDef: true, isSystem: false },
      // Call site in a file we never indexed → no containing node.
      { t: 'ref', to_usr: 'c:objc(cs)Util(im)foo', role: 'call',
        file: 'Sources/Unknown.m', line: 99, col: 1, dynamic: false },
      { t: 'done', symbols: 1, refs: 1, rels: 0 },
    ];

    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });
    expect(summary.refsNoSource).toBe(1);
    expect(summary.refsMerged).toBe(0);
  });

  it('picks the innermost containing node when multiple nodes bracket the line', async () => {
    // Outer class spans 1..100; inner method spans 30..50. A call at line 35 must
    // attach to the inner method, not the outer class.
    seedNode('outer', 'class', 'MyVC', 'Sources/MyVC.m', 1, 100);
    seedNode('inner', 'method', 'run', 'Sources/MyVC.m', 30, 50);
    seedNode('callee', 'method', 'helper', 'Sources/Util.m', 10, 12);

    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(cs)Util(im)helper', name: 'helper', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Util.m', line: 10, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'ref', to_usr: 'c:objc(cs)Util(im)helper', role: 'call',
        file: 'Sources/MyVC.m', line: 35, col: 1, dynamic: false },
      { t: 'done', symbols: 1, refs: 1, rels: 0 },
    ];

    await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });
    const edge = conn.getDb().prepare(
      'SELECT source FROM edges WHERE provenance = ?'
    ).get('semantic-objc') as { source: string };
    expect(edge.source).toBe('inner');
  });

  it('emits data-flow `references` edges for read/write refs (not call edges)', async () => {
    seedNode('caller', 'method', 'run', 'Sources/MyVC.m', 30, 50);
    seedNode('target', 'property', 'name', 'Sources/MyVC.m', 12);

    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(cs)MyVC(py)name', name: 'name', kind: 'instanceProperty', lang: 'objc',
        file: 'Sources/MyVC.m', line: 12, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'ref', to_usr: 'c:objc(cs)MyVC(py)name', role: 'read',
        file: 'Sources/MyVC.m', line: 35, col: 1, dynamic: false },
      { t: 'ref', to_usr: 'c:objc(cs)MyVC(py)name', role: 'write',
        file: 'Sources/MyVC.m', line: 36, col: 1, dynamic: false },
      { t: 'done', symbols: 1, refs: 2, rels: 0 },
    ];

    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });
    expect(summary.refsSeen).toBe(2);
    // read + write both became `references` edges; none became `calls`.
    expect(summary.refsDataflowMerged).toBe(2);
    expect(summary.refsMerged).toBe(0);
    expect(summary.refsNonCall).toBe(0);

    const callEdges = (conn.getDb().prepare(
      'SELECT COUNT(*) AS c FROM edges WHERE provenance = ? AND kind = ?'
    ).get('semantic-objc', 'calls') as { c: number }).c;
    expect(callEdges).toBe(0);

    // Both read and write produced `references` edges caller → property,
    // each tagged with its role in metadata.
    const refEdges = conn.getDb().prepare(
      'SELECT source, target, kind, metadata FROM edges WHERE provenance = ? AND kind = ? ORDER BY metadata'
    ).all('semantic-objc', 'references') as Array<{ source: string; target: string; kind: string; metadata: string }>;
    expect(refEdges).toHaveLength(2);
    for (const e of refEdges) {
      expect(e.source).toBe('caller');
      expect(e.target).toBe('target');
    }
    const roles = refEdges.map((e) => JSON.parse(e.metadata).role).sort();
    expect(roles).toEqual(['read', 'write']);
  });

  it('is idempotent on refs — re-running does not duplicate call edges', async () => {
    seedNode('caller', 'method', 'run', 'Sources/MyVC.m', 30, 50);
    seedNode('callee', 'method', 'helper', 'Sources/Util.m', 10);

    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(cs)Util(im)helper', name: 'helper', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Util.m', line: 10, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'ref', to_usr: 'c:objc(cs)Util(im)helper', role: 'call',
        file: 'Sources/MyVC.m', line: 35, col: 11, dynamic: false },
      { t: 'done', symbols: 1, refs: 1, rels: 0 },
    ];

    const first = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });
    expect(first.refsMerged).toBe(1);
    expect(first.refsAlreadyPresent).toBe(0);

    const second = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });
    expect(second.refsMerged).toBe(0);
    expect(second.refsAlreadyPresent).toBe(1);

    const count = (conn.getDb().prepare(
      'SELECT COUNT(*) AS c FROM edges WHERE provenance = ? AND kind = ?'
    ).get('semantic-objc', 'calls') as { c: number }).c;
    expect(count).toBe(1);
  });
});

describe('semantic-objc merger — Phase D dynamic dispatch resolution', () => {
  // Models the real IndexStore shape (verified empirically): a dynamic message
  // send resolves to the protocol requirement and each conformer emits an
  // `override` rel to it. Phase D must bridge caller → each concrete override.
  const records: XcRecord[] = [
    { t: 'sym', usr: 'c:objc(pl)Shape(im)area', name: 'area', kind: 'instanceMethod', lang: 'objc',
      file: 'Sources/Shapes.h', line: 3, col: 1, isDecl: true, isDef: false, isSystem: false },
    { t: 'sym', usr: 'c:objc(cs)Circle(im)area', name: 'area', kind: 'instanceMethod', lang: 'objc',
      file: 'Sources/Shapes.m', line: 3, col: 1, isDecl: false, isDef: true, isSystem: false },
    { t: 'sym', usr: 'c:objc(cs)Square(im)area', name: 'area', kind: 'instanceMethod', lang: 'objc',
      file: 'Sources/Shapes.m', line: 6, col: 1, isDecl: false, isDef: true, isSystem: false },
    // dynamic message send `[s area]` at Calc.m:8, inside total (6..10).
    { t: 'ref', to_usr: 'c:objc(pl)Shape(im)area', role: 'call',
      file: 'Sources/Calc.m', line: 8, col: 40, dynamic: true },
    { t: 'rel', kind: 'override', parent: 'c:objc(pl)Shape(im)area', child: 'c:objc(cs)Circle(im)area' },
    { t: 'rel', kind: 'override', parent: 'c:objc(pl)Shape(im)area', child: 'c:objc(cs)Square(im)area' },
    { t: 'done', symbols: 3, refs: 1, rels: 2 },
  ];

  function seedShapes(): void {
    seedNode('caller', 'method', 'total', 'Sources/Calc.m', 6, 10);
    seedNode('abstract', 'method', 'area', 'Sources/Shapes.h', 3, 3);
    seedNode('circle', 'method', 'area', 'Sources/Shapes.m', 3, 4);
    seedNode('square', 'method', 'area', 'Sources/Shapes.m', 6, 7);
  }

  it('synthesizes caller → concrete-impl edges for a dynamic protocol call', async () => {
    seedShapes();
    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
    });

    // The dynamic call site resolved to 2 concrete overrides.
    expect(summary.dynamicCallSitesResolved).toBe(1);
    expect(summary.dynamicDispatchSynthesized).toBe(2);

    // caller --calls(dynamic)--> abstract exists (semantic-objc).
    expect(conn.getDb().prepare(
      "SELECT 1 FROM edges WHERE source='caller' AND target='abstract' AND kind='calls' AND provenance='semantic-objc'"
    ).get()).toBeTruthy();

    // Synthesized heuristic caller → each impl, annotated for explore Flow.
    const synthEdges = conn.getDb().prepare(
      "SELECT target, metadata FROM edges WHERE source='caller' AND kind='calls' AND provenance='heuristic' ORDER BY target"
    ).all() as Array<{ target: string; metadata: string }>;
    expect(synthEdges.map((e) => e.target)).toEqual(['circle', 'square']);
    for (const e of synthEdges) {
      const m = JSON.parse(e.metadata);
      expect(m.synthesizedBy).toBe('indexstore-dynamic-dispatch');
      expect(m.via).toBe('area');
      expect(m.dynamic).toBe(true);
      expect(m.registeredAt).toBe('Sources/Calc.m:8');
    }
  });

  it('uses receivedBy receiver narrowing to avoid fanning out to unrelated overrides', async () => {
    seedNode('caller', 'method', 'total', 'Sources/Calc.m', 6, 10);
    seedNode('abstract', 'method', 'area', 'Sources/Shapes.h', 3, 3);
    seedNode('circleClass', 'class', 'Circle', 'Sources/Shapes.h', 10, 12);
    seedNode('squareClass', 'class', 'Square', 'Sources/Shapes.h', 20, 22);
    seedNode('circle', 'method', 'area', 'Sources/Circle.m', 3, 4);
    seedNode('square', 'method', 'area', 'Sources/Square.m', 3, 4);

    const narrowedRecords: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(pl)Shape(im)area', name: 'area', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Shapes.h', line: 3, col: 1, isDecl: true, isDef: false, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)Circle', name: 'Circle', kind: 'class', lang: 'objc',
        file: 'Sources/Shapes.h', line: 10, col: 1, isDecl: true, isDef: false, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)Square', name: 'Square', kind: 'class', lang: 'objc',
        file: 'Sources/Shapes.h', line: 20, col: 1, isDecl: true, isDef: false, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)Circle(im)area', name: 'area', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Circle.m', line: 3, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)Square(im)area', name: 'area', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Square.m', line: 3, col: 1, isDecl: false, isDef: true, isSystem: false },
      // `[circle area]` indexes as a dynamic call to the protocol/base method,
      // plus a `receivedBy` relation that identifies the concrete receiver class.
      { t: 'ref', to_usr: 'c:objc(pl)Shape(im)area', role: 'call',
        file: 'Sources/Calc.m', line: 8, col: 40, dynamic: true },
      { t: 'rel', kind: 'receivedBy', parent: 'c:objc(cs)Circle', child: 'c:objc(pl)Shape(im)area',
        file: 'Sources/Calc.m', line: 8, col: 40 },
      { t: 'rel', kind: 'override', parent: 'c:objc(pl)Shape(im)area', child: 'c:objc(cs)Circle(im)area' },
      { t: 'rel', kind: 'override', parent: 'c:objc(pl)Shape(im)area', child: 'c:objc(cs)Square(im)area' },
      { t: 'done', symbols: 5, refs: 1, rels: 3 },
    ];

    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(narrowedRecords)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });

    expect(summary.dynamicCallSitesResolved).toBe(1);
    expect(summary.dynamicDispatchSynthesized).toBe(1);

    const synthEdges = conn.getDb().prepare(
      "SELECT target FROM edges WHERE source='caller' AND kind='calls' AND provenance='heuristic' ORDER BY target"
    ).all() as Array<{ target: string }>;
    expect(synthEdges.map((e) => e.target)).toEqual(['circle']);
  });

  it('is idempotent — re-running does not duplicate synthesized impl edges', async () => {
    seedShapes();
    await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    const second = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(second.dynamicDispatchSynthesized).toBe(0);
    expect(second.dynamicDispatchAlreadyPresent).toBe(2);

    const synthCount = (conn.getDb().prepare(
      "SELECT COUNT(*) AS c FROM edges WHERE source='caller' AND kind='calls' AND provenance='heuristic'"
    ).get() as { c: number }).c;
    expect(synthCount).toBe(2);
  });

  it('does not synthesize when the dynamic call has no in-project overrides', async () => {
    seedShapes();
    const noOverrides: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(pl)Shape(im)area', name: 'area', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Shapes.h', line: 3, col: 1, isDecl: true, isDef: false, isSystem: false },
      { t: 'ref', to_usr: 'c:objc(pl)Shape(im)area', role: 'call',
        file: 'Sources/Calc.m', line: 8, col: 40, dynamic: true },
      { t: 'done', symbols: 1, refs: 1, rels: 0 },
    ];
    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(noOverrides)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(summary.dynamicCallSitesResolved).toBe(0);
    expect(summary.dynamicDispatchSynthesized).toBe(0);
    expect((conn.getDb().prepare(
      "SELECT COUNT(*) AS c FROM edges WHERE provenance='heuristic'"
    ).get() as { c: number }).c).toBe(0);
  });
});

describe('semantic-objc merger — indirect dispatch (selector / function reference)', () => {
  it('bridges a reference-to-callable as a heuristic calls edge, but a reference-to-data as data-flow', async () => {
    seedNode('caller', 'method', 'wire', 'Sources/Btn.m', 5, 12);
    seedNode('handler', 'method', 'onTap', 'Sources/Btn.m', 20, 21);
    // tight 1-line span so it never shadows `wire` as the containing node.
    seedNode('prop', 'property', 'count', 'Sources/Btn.m', 3, 3);

    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(cs)Btn(im)onTap', name: 'onTap', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Btn.m', line: 20, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)Btn(py)count', name: 'count', kind: 'instanceProperty', lang: 'objc',
        file: 'Sources/Btn.m', line: 3, col: 1, isDecl: false, isDef: true, isSystem: false },
      // #selector(onTap) / function value — indexer records role 'reference' to the method.
      { t: 'ref', to_usr: 'c:objc(cs)Btn(im)onTap', role: 'reference',
        file: 'Sources/Btn.m', line: 6, col: 30, dynamic: false },
      // a plain data reference to a property → data-flow, NOT a call.
      { t: 'ref', to_usr: 'c:objc(cs)Btn(py)count', role: 'reference',
        file: 'Sources/Btn.m', line: 7, col: 10, dynamic: false },
      { t: 'done', symbols: 2, refs: 2, rels: 0 },
    ];

    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });

    expect(summary.selectorEdgesSynthesized).toBe(1);
    expect(summary.refsDataflowMerged).toBe(1);

    // callable reference → heuristic calls edge caller → handler, annotated.
    const callEdge = conn.getDb().prepare(
      "SELECT metadata FROM edges WHERE source='caller' AND target='handler' AND kind='calls' AND provenance='heuristic'"
    ).get() as { metadata: string } | undefined;
    expect(callEdge).toBeTruthy();
    const cm = JSON.parse(callEdge!.metadata);
    expect(cm.synthesizedBy).toBe('indexstore-indirect-ref');
    expect(cm.via).toBe('onTap');

    // data reference → references edge caller → prop (semantic-objc), no call edge.
    expect(conn.getDb().prepare(
      "SELECT 1 FROM edges WHERE source='caller' AND target='prop' AND kind='references' AND provenance='semantic-objc'"
    ).get()).toBeTruthy();
    expect(conn.getDb().prepare(
      "SELECT 1 FROM edges WHERE target='prop' AND kind='calls'"
    ).get()).toBeFalsy();
  });

  it('treats an explicit `selector` role (addressOf) as indirect dispatch', async () => {
    seedNode('caller', 'method', 'wire', 'Sources/Btn.m', 5, 12);
    seedNode('handler', 'function', 'cb', 'Sources/Btn.m', 20, 21);
    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:Btn@F@cb', name: 'cb', kind: 'function', lang: 'c',
        file: 'Sources/Btn.m', line: 20, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'ref', to_usr: 'c:Btn@F@cb', role: 'selector',
        file: 'Sources/Btn.m', line: 6, col: 30, dynamic: false },
      { t: 'done', symbols: 1, refs: 1, rels: 0 },
    ];
    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(summary.selectorEdgesSynthesized).toBe(1);
    expect(conn.getDb().prepare(
      "SELECT 1 FROM edges WHERE source='caller' AND target='handler' AND kind='calls' AND provenance='heuristic'"
    ).get()).toBeTruthy();
  });
});

describe('semantic-objc merger — Interface Builder marking', () => {
  function decoratorsOf(id: string): string[] {
    const row = conn.getDb().prepare('SELECT decorators FROM nodes WHERE id = ?').get(id) as
      | { decorators: string | null }
      | undefined;
    return row?.decorators ? JSON.parse(row.decorators) : [];
  }

  it('tags ibAnnotated property as IBOutlet and ibAnnotated method as IBAction', async () => {
    seedNode('outlet', 'property', 'button', 'Sources/VC.m', 9);
    seedNode('action', 'method', 'tap:', 'Sources/VC.m', 13);

    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(cs)VC(py)button', name: 'button', kind: 'instanceProperty', lang: 'objc',
        file: 'Sources/VC.m', line: 9, col: 1, isDecl: true, isDef: false, isSystem: false, props: ['ibAnnotated'] },
      { t: 'sym', usr: 'c:objc(cs)VC(im)tap:', name: 'tap:', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/VC.m', line: 13, col: 1, isDecl: false, isDef: true, isSystem: false, props: ['ibAnnotated'] },
      { t: 'done', symbols: 2, refs: 0, rels: 0 },
    ];

    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(summary.ibSymbolsMarked).toBe(2);
    expect(decoratorsOf('outlet')).toContain('IBOutlet');
    expect(decoratorsOf('action')).toContain('IBAction');
  });

  it('is idempotent and preserves existing decorators', async () => {
    // node already has an unrelated decorator.
    conn.getDb().prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                         start_line, end_line, start_column, end_column, decorators, updated_at)
      VALUES ('outlet', 'property', 'button', 'button', 'Sources/VC.m', 'objc', 9, 14, 0, 0, ?, ?)
    `).run(JSON.stringify(['nonatomic']), Date.now());

    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(cs)VC(py)button', name: 'button', kind: 'instanceProperty', lang: 'objc',
        file: 'Sources/VC.m', line: 9, col: 1, isDecl: true, isDef: false, isSystem: false, props: ['ibAnnotated'] },
      { t: 'done', symbols: 1, refs: 0, rels: 0 },
    ];
    const first = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(first.ibSymbolsMarked).toBe(1);
    expect(decoratorsOf('outlet').sort()).toEqual(['IBOutlet', 'nonatomic']);

    const second = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(second.ibSymbolsMarked).toBe(0); // already marked
    expect(decoratorsOf('outlet').sort()).toEqual(['IBOutlet', 'nonatomic']);
  });
});

describe('semantic-objc merger — compiler metadata (async / test / generic)', () => {
  it('marks is_async, is_test, and a generic decorator from symbol properties', async () => {
    seedNode('asyncFn', 'method', 'fetch', 'Sources/S.swift', 5);
    seedNode('testFn', 'method', 'testThing', 'Sources/T.swift', 3);
    seedNode('box', 'struct', 'Box', 'Sources/S.swift', 10);

    const records: XcRecord[] = [
      { t: 'sym', usr: 's:1S5fetchyyYaF', name: 'fetch', kind: 'instanceMethod', lang: 'swift',
        file: 'Sources/S.swift', line: 5, col: 1, isDecl: false, isDef: true, isSystem: false, props: ['swiftAsync'] },
      { t: 'sym', usr: 's:1T7MyTests9testThingyyF', name: 'testThing', kind: 'instanceMethod', lang: 'swift',
        file: 'Sources/T.swift', line: 3, col: 1, isDecl: false, isDef: true, isSystem: false, props: ['unitTest'] },
      { t: 'sym', usr: 's:1S3BoxV', name: 'Box', kind: 'struct', lang: 'swift',
        file: 'Sources/S.swift', line: 10, col: 1, isDecl: false, isDef: true, isSystem: false, props: ['generic'] },
      { t: 'done', symbols: 3, refs: 0, rels: 0 },
    ];

    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(summary.asyncSymbolsMarked).toBe(1);
    expect(summary.testSymbolsMarked).toBe(1);

    const flags = (id: string) => conn.getDb().prepare(
      'SELECT is_async, is_test, decorators FROM nodes WHERE id = ?'
    ).get(id) as { is_async: number; is_test: number; decorators: string | null };
    expect(flags('asyncFn').is_async).toBe(1);
    expect(flags('testFn').is_test).toBe(1);
    expect(JSON.parse(flags('box').decorators ?? '[]')).toContain('generic');

    // idempotent: second run marks nothing new.
    const second = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(second.asyncSymbolsMarked).toBe(0);
    expect(second.testSymbolsMarked).toBe(0);
  });

  it('links a template specialization to its generic decl via a references edge', async () => {
    seedNode('generic-decl', 'function', 'maxv', 'Sources/M.cpp', 2, 4);
    seedNode('specialization', 'function', 'maxv', 'Sources/M.cpp', 10, 12);
    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:@FT@>1#Tmaxv#t0.0#S0_#', name: 'maxv', kind: 'function', lang: 'cpp',
        file: 'Sources/M.cpp', line: 2, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'sym', usr: 'c:@F@maxv<#i', name: 'maxv', kind: 'function', lang: 'cpp',
        file: 'Sources/M.cpp', line: 10, col: 1, isDecl: false, isDef: true, isSystem: false, props: ['templateSpecialization'] },
      { t: 'rel', kind: 'specialization', parent: 'c:@FT@>1#Tmaxv#t0.0#S0_#', child: 'c:@F@maxv<#i' },
      { t: 'done', symbols: 2, refs: 0, rels: 1 },
    ];
    await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    // specialization rel maps to a `references` edge (child → parent/generic decl).
    expect(conn.getDb().prepare(
      "SELECT 1 FROM edges WHERE source='specialization' AND target='generic-decl' AND kind='references' AND provenance='semantic-objc'"
    ).get()).toBeTruthy();
    expect(JSON.parse((conn.getDb().prepare(
      "SELECT decorators FROM nodes WHERE id='specialization'"
    ).get() as { decorators: string | null }).decorators ?? '[]')).toContain('specialized');
  });
});

describe('semantic-objc merger — framework callback marking', () => {
  it('marks a method overriding an external protocol/superclass as framework-invoked (no edge)', async () => {
    seedNode('copy', 'method', 'copyWithZone:', 'Sources/Thing.m', 5);
    seedNode('vdl', 'method', 'viewDidLoad', 'Sources/VC.m', 8);

    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(cs)Thing(im)copyWithZone:', name: 'copyWithZone:', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Thing.m', line: 5, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)VC(im)viewDidLoad', name: 'viewDidLoad', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/VC.m', line: 8, col: 1, isDecl: false, isDef: true, isSystem: false },
      // parents are external (Foundation NSCopying protocol / UIKit UIViewController) — unresolved.
      { t: 'rel', kind: 'override', parent: 'c:objc(pl)NSCopying(im)copyWithZone:', child: 'c:objc(cs)Thing(im)copyWithZone:' },
      { t: 'rel', kind: 'override', parent: 'c:objc(cs)UIViewController(im)viewDidLoad', child: 'c:objc(cs)VC(im)viewDidLoad' },
      { t: 'done', symbols: 2, refs: 0, rels: 2 },
    ];

    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(summary.frameworkConformanceMarked).toBe(2);

    const decos = (id: string) => JSON.parse((conn.getDb().prepare(
      'SELECT decorators FROM nodes WHERE id = ?'
    ).get(id) as { decorators: string | null }).decorators ?? '[]');
    expect(decos('copy')).toContain('framework:NSCopying');
    expect(decos('vdl')).toContain('framework:UIViewController');

    // No semantic-objc override edge was created (parent endpoint is external).
    expect((conn.getDb().prepare(
      "SELECT COUNT(*) AS c FROM edges WHERE provenance='semantic-objc'"
    ).get() as { c: number }).c).toBe(0);

    // idempotent.
    const second = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(second.frameworkConformanceMarked).toBe(0);
  });

  it('does not mark when the parent is an in-project (resolvable) symbol', async () => {
    seedNode('base', 'method', 'area', 'Sources/Base.m', 3);
    seedNode('impl', 'method', 'area', 'Sources/Sub.m', 3);
    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(cs)Base(im)area', name: 'area', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Base.m', line: 3, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)Sub(im)area', name: 'area', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Sub.m', line: 3, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'rel', kind: 'override', parent: 'c:objc(cs)Base(im)area', child: 'c:objc(cs)Sub(im)area' },
      { t: 'done', symbols: 2, refs: 0, rels: 1 },
    ];
    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(summary.frameworkConformanceMarked).toBe(0);
    // a real override edge IS created (both endpoints in-project).
    expect(summary.relsMerged).toBe(1);
  });
});

describe('semantic-objc merger — include graph + decl→def', () => {
  it('creates file→file imports edges and a decl→def references edge', async () => {
    // file nodes (kind 'file') + the method decl (.h) and def (.m) nodes.
    seedNode('util-h', 'file', 'Util.h', 'Sources/Util.h', 1, 4);
    seedNode('util-m', 'file', 'Util.m', 'Sources/Util.m', 1, 4);
    seedNode('helper-decl', 'method', 'helper', 'Sources/Util.h', 3, 3);
    seedNode('helper-def', 'method', 'helper', 'Sources/Util.m', 3, 3);

    const records: XcRecord[] = [
      // def gets the USR (canonical occurrence).
      { t: 'sym', usr: 'c:objc(cs)Util(cm)helper', name: 'helper', kind: 'instanceMethod', lang: 'objc',
        file: 'Sources/Util.m', line: 3, col: 1, isDecl: false, isDef: true, isSystem: false },
      { t: 'inc', from: 'Sources/Util.m', to: 'Sources/Util.h', line: 1 },
      { t: 'dcl', usr: 'c:objc(cs)Util(cm)helper', file: 'Sources/Util.h', line: 3, col: 9 },
      { t: 'done', symbols: 1, refs: 0, rels: 0 },
    ];

    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(summary.includeEdgesMerged).toBe(1);
    expect(summary.declEdgesMerged).toBe(1);

    expect(conn.getDb().prepare(
      "SELECT 1 FROM edges WHERE source='util-m' AND target='util-h' AND kind='imports' AND provenance='semantic-objc'"
    ).get()).toBeTruthy();
    const declEdge = conn.getDb().prepare(
      "SELECT metadata FROM edges WHERE source='helper-decl' AND target='helper-def' AND kind='references' AND provenance='semantic-objc'"
    ).get() as { metadata: string } | undefined;
    expect(declEdge).toBeTruthy();
    expect(JSON.parse(declEdge!.metadata).role).toBe('declaration');

    // idempotent.
    const second = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(second.includeEdgesMerged).toBe(0);
    expect(second.declEdgesMerged).toBe(0);
  });

  it('drops include edges whose endpoint is not a project file node', async () => {
    seedNode('util-m', 'file', 'Util.m', 'Sources/Util.m', 1, 4);
    const records: XcRecord[] = [
      // target Foundation.h is outside the project — no file node.
      { t: 'inc', from: 'Sources/Util.m', to: 'Sources/Missing.h', line: 1 },
      { t: 'done', symbols: 0, refs: 0, rels: 0 },
    ];
    const summary = await mergeFromHelper(conn.getDb(), recordSourceHandle(synth(records)), {
      projectRoot: '/proj', helperSourceRoot: '/proj',
    });
    expect(summary.includeEdgesMerged).toBe(0);
  });
});
