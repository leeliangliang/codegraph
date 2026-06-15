import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { DatabaseConnection } from '../src/db';
import {
  enrichWithIndexStore,
  getSemanticObjcState,
  getSemanticObjcStateValue,
  markSemanticObjcFresh,
  recordSourceHandle,
  stableSnapshotKey,
  type SemanticObjcSnapshotRecord,
  type XcRecord,
} from '../src/extraction/semantic-objc';

let tmpDir: string;
let conn: DatabaseConnection;

const stableSnapshot: SemanticObjcSnapshotRecord = {
  t: 'snapshot',
  helperVersion: 'codegraph-xchelper 1.1.1',
  semanticDeltaVersion: 1,
  unitFingerprintAlgorithm: 'index-unit-v1',
  recordKinds: ['unit', 'unit_file', 'sym', 'rel', 'ref'],
  sourceMembership: true,
  languageFilter: ['objc'],
  includeSystem: false,
  explicitOutputUnits: true,
  unitCount: 1,
  unitFileCount: 1,
  sourceMembershipCount: 1,
  aggregateFingerprint: 'stable',
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semobjc-enrich-'));
  conn = DatabaseConnection.initialize(path.join(tmpDir, 'graph.db'));
});

afterEach(() => {
  conn.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedOldSemanticGraph(): void {
  conn.getDb().prepare(`
    INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                       start_line, end_line, start_column, end_column, usr, updated_at)
    VALUES ('old-node', 'class', 'OldVC', 'OldVC', 'OldVC.m', 'objc', 1, 2, 0, 0, 'old-usr', ?)
  `).run(Date.now());
  conn.getDb().prepare(`
    INSERT INTO semantic_objc_units
      (unit_id, fingerprint, fingerprint_algo, helper_version, last_seen_at, status)
    VALUES ('old-unit', 'old-fp', 'index-unit-v1', 'helper', ?, 'fresh')
  `).run(Date.now());
  conn.getDb().prepare(`
    INSERT INTO semantic_objc_unit_files (unit_id, file_path, role)
    VALUES ('old-unit', 'OldVC.m', 'primary')
  `).run();
  markSemanticObjcFresh(conn.getDb(), 123);
}

async function* records(items: XcRecord[]): AsyncIterable<XcRecord> {
  for (const item of items) yield item;
}

describe('Semantic ObjC enrichWithIndexStore snapshot publication gate', () => {
  it('rejects raced pre/post snapshots without mutating the previous semantic graph', async () => {
    seedOldSemanticGraph();
    const snapshots = [
      stableSnapshot,
      { ...stableSnapshot, aggregateFingerprint: 'changed' },
    ];

    await expect(enrichWithIndexStore(conn.getDb(), {
      helperPath: '/tmp/fake-helper',
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
      snapshot: async () => snapshots.shift()!,
      helperHandleFactory: () => recordSourceHandle(records([
        {
          t: 'cap',
          semanticDeltaVersion: 1,
          helperVersion: 'helper-v2',
          unitFingerprintAlgorithm: 'index-unit-v1',
          recordKinds: ['unit', 'unit_file', 'sym', 'rel', 'ref'],
          sourceMembership: true,
        },
        { t: 'unit', unit_id: 'new-unit', fingerprint: 'new-fp', main_file: 'NewVC.m' },
        { t: 'unit_file', unit_id: 'new-unit', file: 'NewVC.m', role: 'primary' },
        { t: 'done', symbols: 0, refs: 0, rels: 0 },
      ])),
    })).rejects.toThrow('semantic-snapshot-race');

    expect((conn.getDb().prepare('SELECT usr FROM nodes WHERE id = ?').get('old-node') as { usr: string }).usr).toBe('old-usr');
    expect(conn.getDb().prepare('SELECT unit_id FROM semantic_objc_units ORDER BY unit_id').all()).toEqual([
      { unit_id: 'old-unit' },
    ]);
    expect(getSemanticObjcState(conn.getDb())).toMatchObject({
      status: 'queued',
      reason: 'semantic-snapshot-race',
      lastSuccessAt: 123,
    });
  });

  it('clears pending snapshot capture time when marking semantic ObjC fresh', () => {
    const db = conn.getDb();
    db.prepare('CREATE TABLE IF NOT EXISTS semantic_objc_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)').run();
    db.prepare('INSERT OR REPLACE INTO semantic_objc_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'pending_snapshot_captured_at',
      '456',
      456
    );

    markSemanticObjcFresh(db, 789);

    expect(getSemanticObjcStateValue(db, 'pending_snapshot_captured_at')).toBe('');
    expect(getSemanticObjcState(db).snapshot?.pendingCapturedAt).toBeUndefined();
  });

  it('publishes when pre/post semantic snapshots match', async () => {
    seedOldSemanticGraph();

    await expect(enrichWithIndexStore(conn.getDb(), {
      helperPath: '/tmp/fake-helper',
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
      snapshot: async () => ({ ...stableSnapshot }),
      helperHandleFactory: () => recordSourceHandle(records([
        { t: 'meta', sourceRoot: '/proj', languageFilter: ['objc'], includeSystem: false },
        {
          t: 'cap',
          semanticDeltaVersion: 1,
          helperVersion: 'helper-v2',
          unitFingerprintAlgorithm: 'index-unit-v1',
          recordKinds: ['unit', 'unit_file', 'sym', 'rel', 'ref'],
          sourceMembership: true,
        },
        { t: 'unit', unit_id: 'new-unit', fingerprint: 'new-fp', main_file: 'NewVC.m' },
        { t: 'unit_file', unit_id: 'new-unit', file: 'NewVC.m', role: 'primary' },
        { t: 'done', symbols: 0, refs: 0, rels: 0 },
      ])),
    })).resolves.toMatchObject({
      unitsSeen: 1,
      unitsMerged: 1,
    });

    expect(conn.getDb().prepare('SELECT unit_id FROM semantic_objc_units ORDER BY unit_id').all()).toEqual([
      { unit_id: 'new-unit' },
    ]);
    expect(getSemanticObjcState(conn.getDb()).status).toBe('fresh');
    expect(getSemanticObjcStateValue(conn.getDb(), 'last_success_snapshot_fingerprint')).toBe(
      stableSnapshotKey(stableSnapshot)
    );
  });

  it('rejects matching snapshots that are not ready without publishing an empty graph', async () => {
    seedOldSemanticGraph();
    const emptySnapshot: SemanticObjcSnapshotRecord = {
      ...stableSnapshot,
      explicitOutputUnits: false,
      unitCount: 0,
      unitFileCount: 0,
      sourceMembershipCount: 0,
      aggregateFingerprint: 'empty',
    };

    await expect(enrichWithIndexStore(conn.getDb(), {
      helperPath: '/tmp/fake-helper',
      projectRoot: '/proj',
      helperSourceRoot: '/proj',
      snapshot: async () => emptySnapshot,
      helperHandleFactory: () => recordSourceHandle(records([
        { t: 'meta', sourceRoot: '/proj', languageFilter: ['objc'], includeSystem: false },
        {
          t: 'cap',
          semanticDeltaVersion: 1,
          helperVersion: 'helper-v2',
          unitFingerprintAlgorithm: 'index-unit-v1',
          recordKinds: ['unit', 'unit_file', 'sym', 'rel', 'ref'],
          sourceMembership: true,
        },
        { t: 'done', symbols: 0, refs: 0, rels: 0 },
      ])),
    })).rejects.toThrow('semantic-snapshot-not-ready:snapshot-missing-units');

    expect((conn.getDb().prepare('SELECT usr FROM nodes WHERE id = ?').get('old-node') as { usr: string }).usr).toBe('old-usr');
    expect(conn.getDb().prepare('SELECT unit_id FROM semantic_objc_units ORDER BY unit_id').all()).toEqual([
      { unit_id: 'old-unit' },
    ]);
    expect(getSemanticObjcState(conn.getDb())).toMatchObject({
      status: 'queued',
      reason: 'semantic-snapshot-not-ready:snapshot-missing-units',
      lastSuccessAt: 123,
      snapshot: {
        pendingReason: 'semantic-snapshot-not-ready:snapshot-missing-units',
      },
    });
    expect(getSemanticObjcStateValue(conn.getDb(), 'last_success_snapshot_fingerprint')).toBeUndefined();
  });

  it('CodeGraph API keeps snapshot races queued instead of marking enrichment failed', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const cg = CodeGraph.initSync(projectDir);
    const snapshots = [
      stableSnapshot,
      { ...stableSnapshot, aggregateFingerprint: 'changed' },
    ];
    try {
      await expect(cg.enrichSemanticObjc({
        helperPath: '/tmp/fake-helper',
        helperSourceRoot: '/proj',
        snapshot: async () => snapshots.shift()!,
        helperHandleFactory: () => recordSourceHandle(records([
          {
            t: 'cap',
            semanticDeltaVersion: 1,
            helperVersion: 'helper-v2',
            unitFingerprintAlgorithm: 'index-unit-v1',
            recordKinds: ['unit', 'unit_file', 'sym', 'rel', 'ref'],
            sourceMembership: true,
          },
          { t: 'unit', unit_id: 'new-unit', fingerprint: 'new-fp', main_file: 'NewVC.m' },
          { t: 'unit_file', unit_id: 'new-unit', file: 'NewVC.m', role: 'primary' },
          { t: 'done', symbols: 0, refs: 0, rels: 0 },
        ])),
      })).rejects.toThrow('semantic-snapshot-race');

      expect(cg.getSemanticObjcState()).toMatchObject({
        status: 'queued',
        reason: 'semantic-snapshot-race',
      });
      expect(cg.getSemanticObjcState().lastFailureAt).toBeUndefined();
    } finally {
      cg.close();
    }
  });

  it('CodeGraph API keeps not-ready snapshots queued instead of marking enrichment failed', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const cg = CodeGraph.initSync(projectDir);
    const emptySnapshot: SemanticObjcSnapshotRecord = {
      ...stableSnapshot,
      unitCount: 0,
      unitFileCount: 0,
      sourceMembershipCount: 0,
      aggregateFingerprint: 'empty',
    };
    try {
      await expect(cg.enrichSemanticObjc({
        helperPath: '/tmp/fake-helper',
        helperSourceRoot: '/proj',
        snapshot: async () => emptySnapshot,
        helperHandleFactory: () => recordSourceHandle(records([
          {
            t: 'cap',
            semanticDeltaVersion: 1,
            helperVersion: 'helper-v2',
            unitFingerprintAlgorithm: 'index-unit-v1',
            recordKinds: ['unit', 'unit_file', 'sym', 'rel', 'ref'],
            sourceMembership: true,
          },
          { t: 'done', symbols: 0, refs: 0, rels: 0 },
        ])),
      })).rejects.toThrow('semantic-snapshot-not-ready:snapshot-missing-units');

      expect(cg.getSemanticObjcState()).toMatchObject({
        status: 'queued',
        reason: 'semantic-snapshot-not-ready:snapshot-missing-units',
      });
      expect(cg.getSemanticObjcState().lastFailureAt).toBeUndefined();
    } finally {
      cg.close();
    }
  });
});
