import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { createDatabase } from '../src/db/sqlite-adapter';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semantic-objc-schema-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tableExists(db: ReturnType<DatabaseConnection['getDb']>, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName);
  return !!row;
}

function indexExists(db: ReturnType<DatabaseConnection['getDb']>, indexName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1")
    .get(indexName);
  return !!row;
}

describe('Semantic ObjC schema', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('creates semantic ObjC delta tables for new databases', () => {
    const conn = DatabaseConnection.initialize(path.join(tempDir, 'codegraph.db'));
    const db = conn.getDb();

    expect(tableExists(db, 'semantic_objc_state')).toBe(true);
    expect(tableExists(db, 'semantic_objc_units')).toBe(true);
    expect(tableExists(db, 'semantic_objc_unit_files')).toBe(true);
    expect(tableExists(db, 'semantic_objc_node_ownership')).toBe(true);

    expect(indexExists(db, 'idx_semantic_objc_unit_files_file_path')).toBe(true);
    expect(indexExists(db, 'idx_semantic_objc_node_ownership_unit_id')).toBe(true);
    expect(indexExists(db, 'idx_semantic_objc_node_ownership_node_id')).toBe(true);
    expect(indexExists(db, 'idx_semantic_objc_node_ownership_file_path')).toBe(true);

    conn.close();
  });

  it('persists semantic status values and unit ownership metadata', () => {
    const conn = DatabaseConnection.initialize(path.join(tempDir, 'codegraph.db'));
    const db = conn.getDb();
    const now = Date.now();

    for (const status of ['fresh', 'stale', 'queued', 'running', 'failed', 'reconciling']) {
      db.prepare(
        'INSERT OR REPLACE INTO semantic_objc_state (key, value, updated_at) VALUES (?, ?, ?)'
      ).run('status', status, now);
      const row = db.prepare('SELECT value FROM semantic_objc_state WHERE key = ?').get('status') as
        | { value: string }
        | undefined;
      expect(row?.value).toBe(status);
    }

    db.prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
                         start_line, end_line, start_column, end_column, usr, updated_at)
      VALUES ('node-1', 'method', 'viewDidLoad', 'ViewController.viewDidLoad',
              'ViewController.m', 'objc', 10, 12, 0, 0, 'usr://method', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO semantic_objc_units
        (unit_id, fingerprint, fingerprint_algo, helper_version, last_seen_at, status)
      VALUES ('unit-1', 'fingerprint-1', 'index-unit-v1', 'helper-1', ?, 'fresh')
    `).run(now);
    db.prepare(`
      INSERT INTO semantic_objc_unit_files (unit_id, file_path, role)
      VALUES ('unit-1', 'ViewController.m', 'primary')
    `).run();
    db.prepare(`
      INSERT INTO semantic_objc_node_ownership (node_id, unit_id, file_path, usr, ownership)
      VALUES ('node-1', 'unit-1', 'ViewController.m', 'usr://method', 'exclusive')
    `).run();

    const ownership = db
      .prepare('SELECT ownership FROM semantic_objc_node_ownership WHERE file_path = ?')
      .get('ViewController.m') as { ownership: string } | undefined;
    expect(ownership?.ownership).toBe('exclusive');

    conn.close();
  });

  it('migrates existing v5 databases to semantic ObjC delta tables', () => {
    const dbPath = path.join(tempDir, 'codegraph.db');
    const raw = createDatabase(dbPath).db;
    raw.exec(`
      CREATE TABLE schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT
      );
      INSERT INTO schema_versions (version, applied_at, description)
      VALUES (5, 1, 'v5 test database');
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        language TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL,
        end_column INTEGER NOT NULL,
        usr TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    raw.close();

    const conn = DatabaseConnection.open(dbPath);
    const db = conn.getDb();

    expect(conn.getSchemaVersion()?.version).toBe(7);
    expect(tableExists(db, 'semantic_objc_state')).toBe(true);
    expect(tableExists(db, 'semantic_objc_units')).toBe(true);
    expect(tableExists(db, 'semantic_objc_unit_files')).toBe(true);
    expect(tableExists(db, 'semantic_objc_node_ownership')).toBe(true);
    expect(indexExists(db, 'idx_semantic_objc_unit_files_file_path')).toBe(true);
    expect(indexExists(db, 'idx_semantic_objc_node_ownership_file_path')).toBe(true);

    conn.close();
  });
});
