/**
 * Semantic ObjC e2e integration test.
 *
 * Validates the full pipeline:
 *   1. Real tree-sitter pass extracts ObjC nodes/edges from on-disk fixture
 *      files into a real SQLite database.
 *   2. A synthetic NDJSON stream stands in for the codegraph-xchelper Swift
 *      helper — same wire format, no Swift / Xcode / IndexStoreDB dependency.
 *      The stream is constructed against the actual line numbers in the
 *      fixtures so (file, line) matching in the merger uses real coordinates.
 *   3. The merger runs end-to-end, attaching USRs to real nodes, inserting
 *      semantic override edges, and inserting semantic call edges.
 *   4. Queries verify the final graph shape — nodes have USRs, callers
 *      look up via the new semantic call edge, etc.
 *
 * The "synthetic helper" stub is the only thing standing in for Swift here.
 * The tree-sitter extraction, the SQLite write path, the merger code, the
 * (file, line) lookup query, the innermost-containing-node query — everything
 * else is real. A failure in any of those layers shows up here.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { ExtractionOrchestrator } from '../src/extraction';
import {
  mergeFromHelper,
  recordSourceHandle,
} from '../src/extraction/semantic-objc';
import type { XcRecord } from '../src/extraction/semantic-objc';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

let projectDir: string;
let conn: DatabaseConnection;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semobjc-e2e-'));
  fs.mkdirSync(path.join(projectDir, '.codegraph'), { recursive: true });
  conn = DatabaseConnection.initialize(path.join(projectDir, '.codegraph', 'graph.db'));
});

afterEach(() => {
  conn.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
});

/** Write a fixture file relative to projectDir and return its relative path. */
function writeFixture(relPath: string, contents: string): string {
  const abs = path.join(projectDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  return relPath;
}

async function* synth(records: XcRecord[]): AsyncIterable<XcRecord> {
  for (const r of records) yield r;
}

describe('Semantic ObjC e2e: real tree-sitter → merger → graph', () => {
  it('attaches USRs to real tree-sitter nodes and adds semantic override + call edges', async () => {
    // 1. On-disk fixtures — minimal but realistic ObjC project.
    //    MyVC.m subclasses UIVC and overrides viewDidLoad; viewDidLoad calls Util.helper.
    const myVCRel = writeFixture(
      'Sources/MyVC.m',
      [
        '#import "MyVC.h"',
        '#import "Util.h"',
        '',
        '@interface MyVC : UIViewController',
        '- (void)run;',
        '@end',
        '',
        '@implementation MyVC',
        '- (void)viewDidLoad {',
        '    [super viewDidLoad];',
        '}',
        '- (void)run {',
        '    [Util helper];',
        '}',
        '@end',
        '',
      ].join('\n')
    );
    const utilRel = writeFixture(
      'Sources/Util.m',
      [
        '@interface Util : NSObject',
        '+ (void)helper;',
        '@end',
        '',
        '@implementation Util',
        '+ (void)helper {',
        '}',
        '@end',
        '',
      ].join('\n')
    );

    // 2. Real tree-sitter extraction → real SQLite write.
    const queries = new QueryBuilder(conn.getDb());
    const orchestrator = new ExtractionOrchestrator(projectDir, queries);
    await orchestrator.indexAll();

    // Sanity: we expect a MyVC class node, a MyVC.run method node, a Util class,
    // and a Util.helper method node.
    const allNodes = conn.getDb().prepare(
      'SELECT id, kind, name, file_path, start_line, end_line FROM nodes ORDER BY file_path, start_line'
    ).all() as Array<{
      id: string; kind: string; name: string; file_path: string; start_line: number; end_line: number;
    }>;

    // tree-sitter emits BOTH the @interface declaration and the @implementation
    // definition as method nodes when a header forward-declares a selector.
    // For semantic call wiring we want the definition — the one with a body —
    // so prefer the largest line span (end_line - start_line).
    const pickDefinition = (kind: string, name: string, filePath: string) =>
      allNodes
        .filter((n) => n.kind === kind && n.name === name && n.file_path === filePath)
        .sort((a, b) => (b.end_line - b.start_line) - (a.end_line - a.start_line))[0];

    const myVCClass = pickDefinition('class', 'MyVC', myVCRel);
    const myVCRun   = pickDefinition('method', 'run', myVCRel);
    const myVCVDL   = pickDefinition('method', 'viewDidLoad', myVCRel);
    const utilClass = pickDefinition('class', 'Util', utilRel);
    const utilHelper = pickDefinition('method', 'helper', utilRel);

    expect(myVCClass, 'MyVC class node should exist after tree-sitter pass').toBeDefined();
    expect(myVCRun, 'MyVC.run method node should exist').toBeDefined();
    expect(myVCVDL, 'MyVC.viewDidLoad method node should exist').toBeDefined();
    expect(utilClass, 'Util class node should exist').toBeDefined();
    expect(utilHelper, 'Util.helper method node should exist').toBeDefined();

    // 3. Synthesise an NDJSON stream as the Swift helper would emit it. Match
    //    real (file_path, start_line) from the extracted nodes so the merger's
    //    sym lookup will hit. Construct enough refs/rels to validate Phases B+C.
    const records: XcRecord[] = [
      { t: 'meta', sourceRoot: projectDir, languageFilter: ['objc'], includeSystem: false },

      // syms — exact (file, line) match against what tree-sitter stored.
      { t: 'sym', usr: 'c:objc(cs)MyVC', name: 'MyVC', kind: 'class', lang: 'objc',
        file: myVCRel, line: myVCClass!.start_line, col: 1,
        isDecl: false, isDef: true, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)MyVC(im)viewDidLoad', name: 'viewDidLoad', kind: 'instanceMethod', lang: 'objc',
        file: myVCRel, line: myVCVDL!.start_line, col: 1,
        isDecl: false, isDef: true, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)MyVC(im)run', name: 'run', kind: 'instanceMethod', lang: 'objc',
        file: myVCRel, line: myVCRun!.start_line, col: 1,
        isDecl: false, isDef: true, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)Util', name: 'Util', kind: 'class', lang: 'objc',
        file: utilRel, line: utilClass!.start_line, col: 1,
        isDecl: false, isDef: true, isSystem: false },
      { t: 'sym', usr: 'c:objc(cs)Util(cm)helper', name: 'helper', kind: 'classMethod', lang: 'objc',
        file: utilRel, line: utilHelper!.start_line, col: 1,
        isDecl: false, isDef: true, isSystem: false },

      // rel — MyVC.viewDidLoad overrides UIVC.viewDidLoad. We don't have a UIVC
      // node in the index (it lives in UIKit), so this rel will be SKIPPED at
      // Phase B (endpoint missing). That's intentional — exercises the
      // "endpoint outside project" code path against a realistic UIKit case.
      { t: 'rel', kind: 'override',
        parent: 'c:objc(cs)UIVC(im)viewDidLoad',
        child:  'c:objc(cs)MyVC(im)viewDidLoad' },

      // ref — MyVC.run line N calls Util.helper. The Swift helper sees the
      // tree-sitter-extracted body for MyVC.run as the call site, so we pick a
      // line that's inside MyVC.run's span.
      { t: 'ref', to_usr: 'c:objc(cs)Util(cm)helper', role: 'call',
        file: myVCRel, line: myVCRun!.start_line + 1, col: 6, dynamic: false },

      { t: 'done', symbols: 5, refs: 1, rels: 1 },
    ];

    // 4. Run the merger.
    const summary = await mergeFromHelper(
      conn.getDb(),
      recordSourceHandle(synth(records)),
      { projectRoot: projectDir, helperSourceRoot: projectDir }
    );

    // 5. Assert the merge summary.
    expect(summary.symsSeen).toBe(5);
    expect(summary.symsMerged).toBe(5);
    expect(summary.refsSeen).toBe(1);
    expect(summary.refsMerged).toBe(1);
    expect(summary.relsSeen).toBe(1);
    expect(summary.relsSkipped).toBe(1); // UIVC parent is outside project
    expect(summary.relsMerged).toBe(0);

    // 6. Assert the graph state.
    //    a) Every tree-sitter ObjC node that the helper saw now has a USR.
    const myVCRunRow = conn.getDb().prepare(
      'SELECT usr FROM nodes WHERE id = ?'
    ).get(myVCRun!.id) as { usr: string | null };
    expect(myVCRunRow.usr).toBe('c:objc(cs)MyVC(im)run');

    const utilHelperRow = conn.getDb().prepare(
      'SELECT usr FROM nodes WHERE id = ?'
    ).get(utilHelper!.id) as { usr: string | null };
    expect(utilHelperRow.usr).toBe('c:objc(cs)Util(cm)helper');

    //    b) The semantic call edge connects MyVC.run → Util.helper with
    //       provenance='semantic-objc'.
    const semanticCall = conn.getDb().prepare(
      'SELECT source, target, kind, metadata FROM edges WHERE provenance = ? AND kind = ?'
    ).get('semantic-objc', 'calls') as
      { source: string; target: string; kind: string; metadata: string };

    expect(semanticCall).toBeDefined();
    expect(semanticCall.source).toBe(myVCRun!.id);
    expect(semanticCall.target).toBe(utilHelper!.id);
    expect(JSON.parse(semanticCall.metadata)).toEqual({ dynamic: false, role: 'call' });

    //    c) There may also be a *syntactic* edge from the tree-sitter pass
    //       (its target won't be resolved by name — the resolver may not have
    //       linked [Util helper] to Util.helper). Whether or not it's there,
    //       the semantic edge is the one we trust for "who calls Util.helper".
    //       Verify the count of semantic-provenance call edges is exactly one.
    const semanticCallCount = (conn.getDb().prepare(
      'SELECT COUNT(*) AS c FROM edges WHERE provenance = ? AND kind = ?'
    ).get('semantic-objc', 'calls') as { c: number }).c;
    expect(semanticCallCount).toBe(1);
  });

  it('is idempotent end-to-end — re-running enrichment does not duplicate edges or change USRs', async () => {
    writeFixture(
      'Sources/Foo.m',
      [
        '@interface Foo : NSObject',
        '- (void)bar;',
        '@end',
        '@implementation Foo',
        '- (void)bar {',
        '    [self bar];',  // a self-call so the merger has SOMETHING to fold
        '}',
        '@end',
        '',
      ].join('\n')
    );

    const queries = new QueryBuilder(conn.getDb());
    const orchestrator = new ExtractionOrchestrator(projectDir, queries);
    await orchestrator.indexAll();

    const fooBar = conn.getDb().prepare(
      "SELECT id, file_path, start_line FROM nodes WHERE kind = 'method' AND name = 'bar' LIMIT 1"
    ).get() as { id: string; file_path: string; start_line: number };
    expect(fooBar).toBeDefined();

    const records: XcRecord[] = [
      { t: 'sym', usr: 'c:objc(cs)Foo(im)bar', name: 'bar', kind: 'instanceMethod', lang: 'objc',
        file: fooBar.file_path, line: fooBar.start_line, col: 1,
        isDecl: false, isDef: true, isSystem: false },
      { t: 'ref', to_usr: 'c:objc(cs)Foo(im)bar', role: 'call',
        file: fooBar.file_path, line: fooBar.start_line + 1, col: 6, dynamic: false },
      { t: 'done', symbols: 1, refs: 1, rels: 0 },
    ];

    const first = await mergeFromHelper(
      conn.getDb(),
      recordSourceHandle(synth(records)),
      { projectRoot: projectDir, helperSourceRoot: projectDir }
    );
    expect(first.refsMerged).toBe(1);

    const second = await mergeFromHelper(
      conn.getDb(),
      recordSourceHandle(synth(records)),
      { projectRoot: projectDir, helperSourceRoot: projectDir }
    );
    expect(second.refsMerged).toBe(0);
    expect(second.refsAlreadyPresent).toBe(1);

    const semCount = (conn.getDb().prepare(
      'SELECT COUNT(*) AS c FROM edges WHERE provenance = ? AND kind = ?'
    ).get('semantic-objc', 'calls') as { c: number }).c;
    expect(semCount).toBe(1);
  });
});
