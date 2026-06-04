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
  it('persists unit, source membership, ownership rows, and fresh state', async () => {
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
    expect(getSemanticObjcState(conn.getDb()).status).toBe('fresh');
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

  it('counts read/write refs separately and does not emit edges for them', async () => {
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
    expect(summary.refsNonCall).toBe(2);
    expect(summary.refsMerged).toBe(0);
    const callEdges = (conn.getDb().prepare(
      'SELECT COUNT(*) AS c FROM edges WHERE provenance = ? AND kind = ?'
    ).get('semantic-objc', 'calls') as { c: number }).c;
    expect(callEdges).toBe(0);
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
