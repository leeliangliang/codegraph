/**
 * Database Migrations
 *
 * Schema versioning and migration support.
 */

import { SqliteDatabase } from './sqlite-adapter';

/**
 * Current schema version
 */
export const CURRENT_SCHEMA_VERSION = 7;

/**
 * Migration definition
 */
interface Migration {
  version: number;
  description: string;
  up: (db: SqliteDatabase) => void;
}

/**
 * All migrations in order
 *
 * Note: Version 1 is the initial schema, handled by schema.sql
 * Future migrations go here.
 */
const migrations: Migration[] = [
  {
    version: 2,
    description: 'Add project metadata, provenance tracking, and unresolved ref context',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        ALTER TABLE unresolved_refs ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE unresolved_refs ADD COLUMN language TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE edges ADD COLUMN provenance TEXT DEFAULT NULL;
        CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
        CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);
      `);
    },
  },
  {
    version: 3,
    description: 'Add lower(name) expression index for memory-efficient case-insensitive lookups',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
      `);
    },
  },
  {
    version: 4,
    description:
      'Drop redundant idx_edges_source / idx_edges_target (covered by source_kind / target_kind composites)',
    up: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_edges_source;
        DROP INDEX IF EXISTS idx_edges_target;
      `);
    },
  },
  {
    version: 5,
    description:
      'Add nodes.usr for Objective-C / Swift semantic enrichment (IndexStoreDB on macOS)',
    up: (db) => {
      db.exec(`
        ALTER TABLE nodes ADD COLUMN usr TEXT;
        CREATE INDEX IF NOT EXISTS idx_nodes_usr ON nodes(usr);
      `);
    },
  },
  {
    version: 6,
    description: 'Add semantic ObjC unit delta state tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS semantic_objc_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS semantic_objc_units (
          unit_id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          fingerprint_algo TEXT NOT NULL,
          helper_version TEXT NOT NULL,
          last_seen_at INTEGER NOT NULL,
          status TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS semantic_objc_unit_files (
          unit_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          role TEXT NOT NULL,
          PRIMARY KEY (unit_id, file_path, role),
          FOREIGN KEY (unit_id) REFERENCES semantic_objc_units(unit_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS semantic_objc_node_ownership (
          node_id TEXT NOT NULL,
          unit_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          usr TEXT,
          ownership TEXT NOT NULL,
          PRIMARY KEY (node_id, unit_id),
          FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
          FOREIGN KEY (unit_id) REFERENCES semantic_objc_units(unit_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_semantic_objc_unit_files_file_path
          ON semantic_objc_unit_files(file_path);
        CREATE INDEX IF NOT EXISTS idx_semantic_objc_node_ownership_unit_id
          ON semantic_objc_node_ownership(unit_id);
        CREATE INDEX IF NOT EXISTS idx_semantic_objc_node_ownership_node_id
          ON semantic_objc_node_ownership(node_id);
        CREATE INDEX IF NOT EXISTS idx_semantic_objc_node_ownership_file_path
          ON semantic_objc_node_ownership(file_path);
      `);
    },
  },
  {
    version: 7,
    description: 'Add nodes.is_test for compiler-confirmed unit-test symbols (IndexStoreDB unitTest property)',
    up: (db) => {
      db.exec(`
        ALTER TABLE nodes ADD COLUMN is_test INTEGER DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_nodes_is_test ON nodes(is_test);
      `);
    },
  },
];

/**
 * Get the current schema version from the database
 */
export function getCurrentVersion(db: SqliteDatabase): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as version FROM schema_versions')
      .get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Record a migration as applied
 */
function recordMigration(db: SqliteDatabase, version: number, description: string): void {
  db.prepare(
    'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)'
  ).run(version, Date.now(), description);
}

/**
 * Run all pending migrations
 */
export function runMigrations(db: SqliteDatabase, fromVersion: number): void {
  const pending = migrations.filter((m) => m.version > fromVersion);

  if (pending.length === 0) {
    return;
  }

  // Sort by version
  pending.sort((a, b) => a.version - b.version);

  // Run each migration in a transaction
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      recordMigration(db, migration.version, migration.description);
    })();
  }
}

/**
 * Check if the database needs migration
 */
export function needsMigration(db: SqliteDatabase): boolean {
  const current = getCurrentVersion(db);
  return current < CURRENT_SCHEMA_VERSION;
}

/**
 * Get list of pending migrations
 */
export function getPendingMigrations(db: SqliteDatabase): Migration[] {
  const current = getCurrentVersion(db);
  return migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
}

/**
 * Get migration history from database
 */
export function getMigrationHistory(
  db: SqliteDatabase
): Array<{ version: number; appliedAt: number; description: string | null }> {
  const rows = db
    .prepare('SELECT version, applied_at, description FROM schema_versions ORDER BY version')
    .all() as Array<{ version: number; applied_at: number; description: string | null }>;

  return rows.map((row) => ({
    version: row.version,
    appliedAt: row.applied_at,
    description: row.description,
  }));
}
