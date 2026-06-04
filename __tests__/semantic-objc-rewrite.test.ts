import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import {
  applySemanticObjcDeltaRewrite,
  getSemanticObjcState,
  markSemanticObjcStale,
  type SemanticObjcDeltaPlan,
} from '../src/extraction/semantic-objc';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semantic-objc-rewrite-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedNode(conn: DatabaseConnection, id: string, usr: string): void {
  conn.getDb().prepare(`
    INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                       start_line, end_line, start_column, end_column, usr, updated_at)
    VALUES (?, 'method', ?, ?, 'A.m', 'objc', 1, 2, 0, 0, ?, ?)
  `).run(id, id, id, usr, Date.now());
}

function seedUnit(conn: DatabaseConnection, unitId: string): void {
  conn.getDb().prepare(`
    INSERT INTO semantic_objc_units
      (unit_id, fingerprint, fingerprint_algo, helper_version, last_seen_at, status)
    VALUES (?, 'fingerprint', 'index-unit-v1', 'helper', ?, 'fresh')
  `).run(unitId, Date.now());
}

function seedOwnership(
  conn: DatabaseConnection,
  nodeId: string,
  unitId: string,
  ownership: 'exclusive' | 'shared' | 'unknown' = 'exclusive'
): void {
  conn.getDb().prepare(`
    INSERT INTO semantic_objc_node_ownership (node_id, unit_id, file_path, usr, ownership)
    VALUES (?, ?, 'A.m', ?, ?)
  `).run(nodeId, unitId, `usr://${nodeId}`, ownership);
}

function countRows(conn: DatabaseConnection, table: string): number {
  const row = conn.getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

describe('Semantic ObjC delta rewrite', () => {
  let tempDir: string;
  let conn: DatabaseConnection;

  beforeEach(() => {
    tempDir = createTempDir();
    conn = DatabaseConnection.initialize(path.join(tempDir, 'codegraph.db'));
  });

  afterEach(() => {
    conn.close();
    cleanupTempDir(tempDir);
  });

  it('marks stale plans without clearing USRs, semantic edges, or ownership rows', () => {
    seedUnit(conn, 'unit-1');
    seedNode(conn, 'source', 'usr://source');
    seedNode(conn, 'target', 'usr://target');
    seedOwnership(conn, 'source', 'unit-1');
    conn.getDb().prepare(`
      INSERT INTO edges (source, target, kind, provenance)
      VALUES ('source', 'target', 'calls', 'semantic-objc')
    `).run();

    const plan: SemanticObjcDeltaPlan = {
      mode: 'needs-reconcile',
      reason: 'semantic-ownership-uncertain',
      changedUnitIds: [],
      addedUnitIds: [],
      removedUnitIds: [],
      unchangedUnitIds: [],
      affectedFiles: [],
    };
    const summary = applySemanticObjcDeltaRewrite(conn.getDb(), plan, 123);

    expect(summary).toEqual({
      mode: 'stale',
      staleReason: 'semantic-ownership-uncertain',
      nodesCleared: 0,
      edgesDeleted: 0,
      ownershipRowsDeleted: 0,
    });
    expect(getSemanticObjcState(conn.getDb())).toMatchObject({
      status: 'stale',
      staleReason: 'semantic-ownership-uncertain',
      lastAttemptAt: 123,
    });
    expect((conn.getDb().prepare('SELECT usr FROM nodes WHERE id = ?').get('source') as { usr: string }).usr).toBe('usr://source');
    expect(countRows(conn, 'edges')).toBe(1);
    expect(countRows(conn, 'semantic_objc_node_ownership')).toBe(1);
  });

  it('rewrites only semantic data whose source node is exclusively owned by changed or removed units', () => {
    seedUnit(conn, 'changed-unit');
    seedUnit(conn, 'other-unit');
    seedNode(conn, 'exclusive-source', 'usr://exclusive-source');
    seedNode(conn, 'shared-source', 'usr://shared-source');
    seedNode(conn, 'target', 'usr://target');
    seedOwnership(conn, 'exclusive-source', 'changed-unit');
    seedOwnership(conn, 'shared-source', 'changed-unit', 'shared');
    seedOwnership(conn, 'shared-source', 'other-unit');
    conn.getDb().prepare(`
      INSERT INTO edges (source, target, kind, provenance)
      VALUES
        ('exclusive-source', 'target', 'calls', 'semantic-objc'),
        ('exclusive-source', 'target', 'calls', NULL),
        ('shared-source', 'target', 'calls', 'semantic-objc'),
        ('target', 'exclusive-source', 'calls', 'semantic-objc')
    `).run();
    markSemanticObjcStale(conn.getDb(), 'old-stale', 1);

    const plan: SemanticObjcDeltaPlan = {
      mode: 'delta',
      changedUnitIds: ['changed-unit'],
      addedUnitIds: [],
      removedUnitIds: [],
      unchangedUnitIds: ['other-unit'],
      affectedFiles: ['A.m'],
    };
    const summary = applySemanticObjcDeltaRewrite(conn.getDb(), plan, 456);

    expect(summary).toEqual({
      mode: 'rewritten',
      nodesCleared: 1,
      edgesDeleted: 2,
      ownershipRowsDeleted: 1,
    });
    expect(getSemanticObjcState(conn.getDb())).toMatchObject({
      status: 'fresh',
      lastSuccessAt: 456,
    });
    expect(getSemanticObjcState(conn.getDb()).staleReason).toBeUndefined();

    const exclusive = conn.getDb().prepare('SELECT usr FROM nodes WHERE id = ?').get('exclusive-source') as {
      usr: string | null;
    };
    const shared = conn.getDb().prepare('SELECT usr FROM nodes WHERE id = ?').get('shared-source') as {
      usr: string | null;
    };
    expect(exclusive.usr).toBeNull();
    expect(shared.usr).toBe('usr://shared-source');

    const edges = conn.getDb().prepare('SELECT source, target, provenance FROM edges ORDER BY id').all() as Array<{
      source: string;
      target: string;
      provenance: string | null;
    }>;
    expect(edges).toEqual([
      { source: 'exclusive-source', target: 'target', provenance: null },
      { source: 'shared-source', target: 'target', provenance: 'semantic-objc' },
    ]);

    const ownershipRows = conn
      .getDb()
      .prepare('SELECT node_id, unit_id, ownership FROM semantic_objc_node_ownership ORDER BY node_id, unit_id')
      .all();
    expect(ownershipRows).toEqual([
      { node_id: 'shared-source', unit_id: 'changed-unit', ownership: 'shared' },
      { node_id: 'shared-source', unit_id: 'other-unit', ownership: 'exclusive' },
    ]);
  });

  it('marks fresh without rewriting when delta plan has no changed or removed units', () => {
    seedUnit(conn, 'unit-1');
    seedNode(conn, 'source', 'usr://source');
    seedOwnership(conn, 'source', 'unit-1');
    markSemanticObjcStale(conn.getDb(), 'old-stale', 1);

    const summary = applySemanticObjcDeltaRewrite(conn.getDb(), {
      mode: 'delta',
      changedUnitIds: [],
      addedUnitIds: ['unit-2'],
      removedUnitIds: [],
      unchangedUnitIds: ['unit-1'],
      affectedFiles: ['B.m'],
    }, 789);

    expect(summary).toEqual({
      mode: 'rewritten',
      nodesCleared: 0,
      edgesDeleted: 0,
      ownershipRowsDeleted: 0,
    });
    expect(getSemanticObjcState(conn.getDb())).toMatchObject({
      status: 'fresh',
      lastSuccessAt: 789,
    });
    expect((conn.getDb().prepare('SELECT usr FROM nodes WHERE id = ?').get('source') as { usr: string }).usr).toBe('usr://source');
  });
});
