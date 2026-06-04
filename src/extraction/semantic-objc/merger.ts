/**
 * Merger — consume a stream of `XcRecord`s from the Swift helper and merge
 * the semantic information into the SQLite graph built by the tree-sitter pass.
 *
 * Three responsibilities, all idempotent:
 *
 *   Phase A (streamed inline):
 *     For each `sym`, look up the tree-sitter node at (file, start_line). If we
 *     find one, populate its `usr` column. After this phase any node we know
 *     about has its Clang/Swift USR attached.
 *
 *   Phase B (after stream end):
 *     For each buffered `rel` (override / extended / accessor / etc.), look up
 *     both endpoints via the newly-populated `usr` index. If both resolve, insert
 *     an edge with `provenance = 'semantic-objc'`. Existing edges with the same
 *     (source, target, kind, provenance) are skipped — re-running enrichment
 *     does not duplicate edges.
 *
 *   Phase C (after Phase B):
 *     For each buffered `ref` with role `call`, locate the containing source
 *     node at (file, line) via `start_line ≤ line ≤ end_line`, look up the
 *     callee by `to_usr`, and insert a `calls` edge with provenance
 *     `semantic-objc`. The tree-sitter pass already emits a *syntactic* call
 *     edge for the same call site (by selector name) — we add the semantic
 *     edge alongside, distinguished by provenance. The query layer can prefer
 *     the semantic one when both exist, and fall back to the syntactic edge
 *     for calls IndexStoreDB couldn't resolve (cross-module, dynamic `id`-typed).
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { SqliteDatabase } from '../../db/sqlite-adapter';
import type { SpawnerHandle } from './spawner';
import type {
  XcCapabilityRecord,
  XcRecord,
  XcRefRecord,
  XcRelRecord,
  XcSymRecord,
  XcUnitFileRecord,
  XcUnitRecord,
} from './types';
import { markSemanticObjcFresh } from './state';
import { planSemanticObjcDelta, type StoredSemanticObjcUnit } from './delta';
import { applySemanticObjcDeltaRewrite } from './rewrite';

/**
 * Realpath a path, returning the original on failure. macOS reports file paths
 * through symlink-resolved forms (notably `/var/folders/…` → `/private/var/folders/…`)
 * even when the caller passed the symlinked form. We canonicalise both sides
 * so prefix comparisons in `canonicaliseSymPath` actually line up.
 */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export interface MergeOptions {
  /** The CodeGraph project root — what `nodes.file_path` is relative to. */
  projectRoot: string;
  /** What the helper used as `--source-root` — what `sym.file` is relative to. */
  helperSourceRoot: string;
}

export interface MergeSummary {
  symsSeen: number;
  /** Symbols whose USR we attached to a tree-sitter node. */
  symsMerged: number;
  /** Symbols that landed outside the project tree (DerivedData, frameworks, …). */
  symsOutsideProject: number;
  /** Symbols inside the project but with no tree-sitter node at that location. */
  symsNotMatched: number;
  unitsSeen: number;
  unitsMerged: number;
  unitFilesSeen: number;
  unitFilesMerged: number;
  ownershipRowsMerged: number;
  relsSeen: number;
  /** Relations where both endpoints resolved to nodes and an edge was inserted. */
  relsMerged: number;
  /** Relations whose parent or child USR was not present in the project. */
  relsSkipped: number;
  /** Relations whose edges were already present from a prior enrichment run. */
  relsAlreadyPresent: number;
  refsSeen: number;
  /** Call refs that produced a new semantic `calls` edge. */
  refsMerged: number;
  /** Refs whose call site lived outside the project tree. */
  refsOutsideProject: number;
  /** Refs whose containing source node could not be located. */
  refsNoSource: number;
  /** Refs whose callee USR was not present as a node in the project. */
  refsNoTarget: number;
  /** Refs whose semantic call edge was already present from a prior run. */
  refsAlreadyPresent: number;
  /** Non-call refs (read / write / generic reference) we deliberately ignored. */
  refsNonCall: number;
}

/**
 * Consume the helper's record stream and apply all three phases. Returns
 * counts suitable for surfacing to the user / status command.
 */
export async function mergeFromHelper(
  db: SqliteDatabase,
  handle: SpawnerHandle,
  opts: MergeOptions
): Promise<MergeSummary> {
  const summary: MergeSummary = {
    symsSeen: 0,
    symsMerged: 0,
    symsOutsideProject: 0,
    symsNotMatched: 0,
    unitsSeen: 0,
    unitsMerged: 0,
    unitFilesSeen: 0,
    unitFilesMerged: 0,
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
  };

  // Prepared statements live for the whole merge. node:sqlite doesn't need an
  // explicit close — they're released when the SqliteDatabase closes.
  const findNodeStmt = db.prepare(
    'SELECT id FROM nodes WHERE file_path = ? AND start_line = ? LIMIT 1'
  );
  const updateUSRStmt = db.prepare('UPDATE nodes SET usr = ? WHERE id = ?');
  const findNodeByUSRStmt = db.prepare('SELECT id FROM nodes WHERE usr = ? LIMIT 1');
  // Containing-node lookup for ref call sites — pick the *innermost* node
  // (smallest line span) that brackets the (file, line). Without ORDER BY,
  // a top-level `class` would shadow the method inside it.
  const findContainingNodeStmt = db.prepare(
    'SELECT id FROM nodes WHERE file_path = ? AND start_line <= ? AND end_line >= ? ' +
      'ORDER BY (end_line - start_line) ASC LIMIT 1'
  );
  const checkEdgeStmt = db.prepare(
    'SELECT 1 FROM edges WHERE source = ? AND target = ? AND kind = ? AND provenance = ? LIMIT 1'
  );
  const insertEdgeStmt = db.prepare(
    'INSERT INTO edges (source, target, kind, metadata, line, col, provenance) VALUES (?, ?, ?, NULL, NULL, NULL, ?)'
  );
  const insertCallEdgeStmt = db.prepare(
    'INSERT INTO edges (source, target, kind, metadata, line, col, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const upsertUnitStmt = db.prepare(`
    INSERT INTO semantic_objc_units
      (unit_id, fingerprint, fingerprint_algo, helper_version, last_seen_at, status)
    VALUES (?, ?, ?, ?, ?, 'fresh')
    ON CONFLICT(unit_id) DO UPDATE SET
      fingerprint = excluded.fingerprint,
      fingerprint_algo = excluded.fingerprint_algo,
      helper_version = excluded.helper_version,
      last_seen_at = excluded.last_seen_at,
      status = excluded.status
  `);
  const insertUnitFileStmt = db.prepare(`
    INSERT OR REPLACE INTO semantic_objc_unit_files (unit_id, file_path, role)
    VALUES (?, ?, ?)
  `);
  const deleteUnitFilesStmt = db.prepare('DELETE FROM semantic_objc_unit_files WHERE unit_id = ?');
  const insertOwnershipStmt = db.prepare(`
    INSERT OR REPLACE INTO semantic_objc_node_ownership (node_id, unit_id, file_path, usr, ownership)
    VALUES (?, ?, ?, ?, 'exclusive')
  `);

  // Resolve symlinks once at the merger boundary — see realpathSafe doc.
  const projectRoot = realpathSafe(path.resolve(opts.projectRoot));
  const helperRoot = realpathSafe(path.resolve(opts.helperSourceRoot));

  // Buffer rels and refs until Phase A is done. mvbox produced ~184k rels +
  // ~253k refs — both fit comfortably in memory at a few dozen MB.
  const relBuffer: XcRelRecord[] = [];
  const refBuffer: XcRefRecord[] = [];
  const symBuffer: XcSymRecord[] = [];
  const unitBuffer: XcUnitRecord[] = [];
  const unitFileBuffer: XcUnitFileRecord[] = [];
  let capRecord: XcCapabilityRecord | null = null;

  for await (const record of handle.records()) {
    switch ((record as XcRecord).t) {
      case 'cap':
        capRecord = record as XcCapabilityRecord;
        break;
      case 'unit':
        summary.unitsSeen++;
        unitBuffer.push(record as XcUnitRecord);
        break;
      case 'unit_file':
        summary.unitFilesSeen++;
        unitFileBuffer.push(record as XcUnitFileRecord);
        break;
      case 'sym':
        summary.symsSeen++;
        symBuffer.push(record as XcSymRecord);
        break;
      case 'rel':
        summary.relsSeen++;
        relBuffer.push(record as XcRelRecord);
        break;
      case 'ref': {
        const ref = record as XcRefRecord;
        summary.refsSeen++;
        if (ref.role !== 'call') {
          summary.refsNonCall++;
          break;
        }
        refBuffer.push(ref);
        break;
      }
      default:
        break;
    }
  }

  await handle.wait();

  if (capRecord) {
    const deltaUnitFiles = canonicaliseUnitFiles(unitFileBuffer, helperRoot, projectRoot);
    const plan = planSemanticObjcDelta({
      capability: capRecord,
      currentUnits: unitBuffer,
      currentUnitFiles: deltaUnitFiles,
      storedUnits: loadStoredSemanticObjcUnits(db),
      uncertainOwnership: hasAmbiguousPrimaryOwnership(deltaUnitFiles),
    });
    const rewrite = applySemanticObjcDeltaRewrite(db, plan);
    if (rewrite.mode === 'stale') return summary;
  }

  const matchedSyms: Array<{ nodeId: string; filePath: string; usr: string }> = [];

  db.exec('BEGIN');
  try {
    for (const sym of symBuffer) {
      const filePath = canonicaliseSymPath(sym.file, helperRoot, projectRoot);
      if (filePath === null) {
        summary.symsOutsideProject++;
        continue;
      }
      const node = findNodeStmt.get(filePath, sym.line) as { id?: string } | undefined;
      if (!node?.id) {
        summary.symsNotMatched++;
        continue;
      }
      updateUSRStmt.run(sym.usr, node.id);
      matchedSyms.push({ nodeId: node.id, filePath, usr: sym.usr });
      summary.symsMerged++;
    }

    if (capRecord) {
      const seenUnits = new Set<string>();
      for (const unit of unitBuffer) {
        upsertUnitStmt.run(
          unit.unit_id,
          unit.fingerprint,
          capRecord.unitFingerprintAlgorithm,
          capRecord.helperVersion,
          Date.now()
        );
        seenUnits.add(unit.unit_id);
        summary.unitsMerged++;
      }
      for (const unitId of seenUnits) {
        deleteUnitFilesStmt.run(unitId);
      }
      for (const unitFile of unitFileBuffer) {
        if (!seenUnits.has(unitFile.unit_id)) continue;
        const filePath = canonicaliseSymPath(unitFile.file, helperRoot, projectRoot);
        if (filePath === null) continue;
        insertUnitFileStmt.run(unitFile.unit_id, filePath, unitFile.role);
        summary.unitFilesMerged++;
      }
      const primaryUnitsByFile = new Map<string, string[]>();
      for (const unitFile of unitFileBuffer) {
        if (unitFile.role !== 'primary' || !seenUnits.has(unitFile.unit_id)) continue;
        const filePath = canonicaliseSymPath(unitFile.file, helperRoot, projectRoot);
        if (filePath === null) continue;
        const units = primaryUnitsByFile.get(filePath) ?? [];
        units.push(unitFile.unit_id);
        primaryUnitsByFile.set(filePath, units);
      }
      for (const sym of matchedSyms) {
        const units = primaryUnitsByFile.get(sym.filePath);
        if (!units || units.length !== 1) continue;
        insertOwnershipStmt.run(sym.nodeId, units[0], sym.filePath, sym.usr);
        summary.ownershipRowsMerged++;
      }
    }

    for (const rel of relBuffer) {
      const parentRow = findNodeByUSRStmt.get(rel.parent) as { id?: string } | undefined;
      const childRow = findNodeByUSRStmt.get(rel.child) as { id?: string } | undefined;
      if (!parentRow?.id || !childRow?.id) {
        summary.relsSkipped++;
        continue;
      }
      // child override-of parent — `child` is the overriding implementation,
      // `parent` is the original method on the protocol or superclass.
      const exists = checkEdgeStmt.get(childRow.id, parentRow.id, rel.kind, 'semantic-objc');
      if (exists) {
        summary.relsAlreadyPresent++;
        continue;
      }
      insertEdgeStmt.run(childRow.id, parentRow.id, rel.kind, 'semantic-objc');
      summary.relsMerged++;
    }

    for (const ref of refBuffer) {
      const filePath = canonicaliseSymPath(ref.file, helperRoot, projectRoot);
      if (filePath === null) {
        summary.refsOutsideProject++;
        continue;
      }
      const source = findContainingNodeStmt.get(filePath, ref.line, ref.line) as
        | { id?: string }
        | undefined;
      if (!source?.id) {
        summary.refsNoSource++;
        continue;
      }
      const target = findNodeByUSRStmt.get(ref.to_usr) as { id?: string } | undefined;
      if (!target?.id) {
        summary.refsNoTarget++;
        continue;
      }
      const exists = checkEdgeStmt.get(source.id, target.id, 'calls', 'semantic-objc');
      if (exists) {
        summary.refsAlreadyPresent++;
        continue;
      }
      const metadata = JSON.stringify({ dynamic: ref.dynamic, role: ref.role });
      insertCallEdgeStmt.run(
        source.id,
        target.id,
        'calls',
        metadata,
        ref.line,
        ref.col,
        'semantic-objc'
      );
      summary.refsMerged++;
    }
    markSemanticObjcFresh(db);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return summary;
}

/**
 * Normalise a path emitted by the Swift helper into the form CodeGraph's
 * `nodes.file_path` column uses.
 *
 *   - Helper-emitted relative paths (already relative to `helperRoot`) are
 *     re-rooted at `projectRoot` if the two roots are identical, or rebased if
 *     they're different. When `helperRoot === projectRoot` the path is
 *     returned unchanged.
 *   - Absolute paths that fall inside the project tree are made relative.
 *   - Absolute paths outside the project tree (DerivedData, vendored
 *     frameworks, SDK headers) return `null` — those are outside our index.
 */
function canonicaliseUnitFiles(
  unitFiles: XcUnitFileRecord[],
  helperRoot: string,
  projectRoot: string
): XcUnitFileRecord[] {
  const canonical: XcUnitFileRecord[] = [];
  for (const unitFile of unitFiles) {
    const filePath = canonicaliseSymPath(unitFile.file, helperRoot, projectRoot);
    if (filePath === null) continue;
    canonical.push({ ...unitFile, file: filePath });
  }
  return canonical;
}

function hasAmbiguousPrimaryOwnership(unitFiles: XcUnitFileRecord[]): boolean {
  const primaryUnitsByFile = new Map<string, Set<string>>();
  for (const unitFile of unitFiles) {
    if (unitFile.role !== 'primary') continue;
    const units = primaryUnitsByFile.get(unitFile.file) ?? new Set<string>();
    units.add(unitFile.unit_id);
    primaryUnitsByFile.set(unitFile.file, units);
  }
  for (const units of primaryUnitsByFile.values()) {
    if (units.size !== 1) return true;
  }
  return false;
}

function loadStoredSemanticObjcUnits(db: SqliteDatabase): StoredSemanticObjcUnit[] {
  const rows = db.prepare(`
    SELECT unit_id, fingerprint, fingerprint_algo, helper_version, status
    FROM semantic_objc_units
  `).all() as Array<{
    unit_id: string;
    fingerprint: string;
    fingerprint_algo: string;
    helper_version: string;
    status: string;
  }>;
  const files = db.prepare(`
    SELECT file_path AS filePath, role
    FROM semantic_objc_unit_files
    WHERE unit_id = ?
    ORDER BY file_path, role
  `);
  return rows.map((row) => ({
    unitId: row.unit_id,
    fingerprint: row.fingerprint,
    fingerprintAlgo: row.fingerprint_algo,
    helperVersion: row.helper_version,
    status: row.status,
    files: files.all(row.unit_id) as Array<{ filePath: string; role: string }>,
  }));
}

export function canonicaliseSymPath(
  symFile: string,
  helperRoot: string,
  projectRoot: string
): string | null {
  if (path.isAbsolute(symFile)) {
    // Realpath the absolute path so macOS `/private/var/…` collapses to
    // the symlinked form the projectRoot lives under (or vice versa).
    // Files outside the project tree (DerivedData, frameworks) likely still
    // exist and realpath fine — the prefix check filters them.
    const abs = realpathSafe(path.resolve(symFile));
    const rel = path.relative(projectRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel;
  }
  // Relative form: it's relative to helperRoot. Translate to projectRoot.
  const abs = path.resolve(helperRoot, symFile);
  const rel = path.relative(projectRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}
