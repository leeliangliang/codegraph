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
 *     For each buffered `ref`, locate the containing source node at (file, line)
 *     via `start_line ≤ line ≤ end_line` and look up the referent by `to_usr`:
 *       - role `call` → a `calls` edge (provenance `semantic-objc`). The
 *         tree-sitter pass already emits a *syntactic* call edge for the same
 *         site (by selector name); we add the semantic one alongside,
 *         distinguished by provenance. The query layer prefers the semantic
 *         edge when both exist and falls back to the syntactic one for calls
 *         IndexStoreDB couldn't resolve (cross-module, dynamic `id`-typed).
 *       - role `read` / `write` / `reference` → a `references` edge carrying
 *         `metadata.role`. This is the def-use / data-flow layer the
 *         tree-sitter pass can't express: "which functions read or write this
 *         property / ivar / global". It rides the `references` edge kind the
 *         query layer already traverses, so `callers(prop)` answers it.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { SqliteDatabase } from '../../db/sqlite-adapter';
import type { SpawnerHandle } from './spawner';
import type {
  XcCapabilityRecord,
  XcDeclRecord,
  XcIncludeRecord,
  XcRecord,
  XcRefRecord,
  XcRelRecord,
  XcSymRecord,
  XcUnitFileRecord,
  XcUnitRecord,
} from './types';
import { markSemanticObjcFresh, markSemanticObjcMergeCompleted } from './state';
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

/**
 * Node kinds that are *callable* — a non-call `reference` to one of these is
 * indirect dispatch (a selector / `#selector` / function value referenced to
 * be invoked later), which the merger bridges as a heuristic `calls` edge. A
 * reference to anything else (property, field, variable) is data-flow.
 */
const CALLABLE_KINDS = new Set(['method', 'function', 'constructor']);

/**
 * Map IndexStore IB SymbolProperty tokens to CodeGraph decorator labels, using
 * the node kind to tell an `@IBOutlet` (a property/field) from an `@IBAction`
 * (a method). `ibOutletCollection` is its own thing.
 */
function ibDecoratorsFor(props: string[], kind: string | undefined): string[] {
  if (props.includes('ibOutletCollection')) return ['IBOutletCollection'];
  if (props.includes('ibAnnotated')) {
    return kind === 'method' || kind === 'function' ? ['IBAction'] : ['IBOutlet'];
  }
  return [];
}

/**
 * Informational decorators from generic/template SymbolProperty tokens — so a
 * `generic` decl or a `templateSpecialization` instance is visible in the
 * node's metadata. The structural link (specialization → generic decl) is a
 * separate `references` edge from the `specialization` relation.
 */
/**
 * Extract the framework type name from an external override target USR — an
 * Objective-C protocol requirement (`c:objc(pl)<Protocol>(im)<sel>`) or a
 * framework class method (`c:objc(cs)<Class>(im)<sel>`). Returns null for
 * anything that isn't a recognizable framework symbol, so we never mis-mark an
 * unresolved *in-project* parent.
 */
function frameworkSymbolName(usr: string): string | null {
  const m = /objc\((?:pl|cs)\)([^()]+)\(/.exec(usr);
  return m?.[1] ?? null;
}

function isObjcMethodUSRForClass(methodUSR: string, classUSR: string): boolean {
  return methodUSR.startsWith(`${classUSR}(im)`) || methodUSR.startsWith(`${classUSR}(cm)`);
}

function genericDecoratorsFor(props: string[]): string[] {
  const out: string[] = [];
  if (props.includes('generic')) out.push('generic');
  if (props.includes('templateSpecialization') || props.includes('templatePartialSpecialization')) {
    out.push('specialized');
  }
  return out;
}

/**
 * Merge `toAdd` into a node's JSON `decorators` array, deduped. Returns true
 * (and writes) only when it actually added something, so re-running enrichment
 * is idempotent.
 */
function mergeDecorators(
  existing: string | null | undefined,
  toAdd: string[],
  nodeId: string,
  stmt: { run: (decorators: string, id: string) => unknown }
): boolean {
  let current: string[] = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed)) current = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      current = [];
    }
  }
  const set = new Set(current);
  let changed = false;
  for (const d of toAdd) {
    if (!set.has(d)) {
      set.add(d);
      changed = true;
    }
  }
  if (changed) stmt.run(JSON.stringify([...set]), nodeId);
  return changed;
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
  /**
   * Read / write / generic-reference refs that produced a semantic `references`
   * edge (data-flow: function → property/field/global it reads or writes).
   * The edge carries `metadata.role` ('read' | 'write' | 'reference') so the
   * query layer can answer "who writes this property" without a grep.
   */
  refsDataflowMerged: number;
  /** Data-flow refs whose `references` edge was already present from a prior run. */
  refsDataflowAlreadyPresent: number;
  /** Refs with a role we don't classify (defensive; normally 0). */
  refsNonCall: number;
  /** Dynamic call sites (calls edge with metadata.dynamic) that had ≥1 concrete override to resolve. */
  dynamicCallSitesResolved: number;
  /**
   * Synthesized `caller → concrete-impl` edges added for dynamic dispatch.
   * IndexStore resolves `[obj foo]` to the abstract method + records each
   * concrete override; we bridge caller → each override so the flow connects
   * end-to-end through dynamic dispatch (provenance `heuristic`).
   */
  dynamicDispatchSynthesized: number;
  /** Dynamic-dispatch edges already present from a prior run. */
  dynamicDispatchAlreadyPresent: number;
  /**
   * Indirect-dispatch `calls` edges synthesized from a selector / `#selector` /
   * function-value reference (method referenced as a callable, invoked later).
   * provenance `heuristic`, synthesizedBy `indexstore-indirect-ref`.
   */
  selectorEdgesSynthesized: number;
  /** Indirect-dispatch edges already present from a prior run. */
  selectorAlreadyPresent: number;
  /** Symbols tagged with an Interface Builder decorator (IBOutlet / IBAction / IBOutletCollection). */
  ibSymbolsMarked: number;
  /** Nodes marked `is_async` from the compiler `swiftAsync` property. */
  asyncSymbolsMarked: number;
  /** Nodes marked `is_test` from the compiler `unitTest` property. */
  testSymbolsMarked: number;
  /**
   * Methods marked as framework callbacks — they override an external protocol
   * requirement / framework superclass method, so the framework invokes them
   * (delegate methods, lifecycle hooks). Tagged with a `framework:<Type>`
   * decorator; no edge (there's no in-project caller).
   */
  frameworkConformanceMarked: number;
  /** File→file `imports` edges added from the `#include`/`#import` graph. */
  includeEdgesMerged: number;
  /** decl→def `references` edges added (`.h` declaration → `.m` definition). */
  declEdgesMerged: number;
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
    refsDataflowMerged: 0,
    refsDataflowAlreadyPresent: 0,
    refsNonCall: 0,
    dynamicCallSitesResolved: 0,
    dynamicDispatchSynthesized: 0,
    dynamicDispatchAlreadyPresent: 0,
    selectorEdgesSynthesized: 0,
    selectorAlreadyPresent: 0,
    ibSymbolsMarked: 0,
    asyncSymbolsMarked: 0,
    testSymbolsMarked: 0,
    frameworkConformanceMarked: 0,
    includeEdgesMerged: 0,
    declEdgesMerged: 0,
  };

  // Prepared statements live for the whole merge. node:sqlite doesn't need an
  // explicit close — they're released when the SqliteDatabase closes.
  const findNodeStmt = db.prepare(
    'SELECT id, kind, decorators FROM nodes WHERE file_path = ? AND start_line = ? LIMIT 1'
  );
  const updateUSRStmt = db.prepare('UPDATE nodes SET usr = ? WHERE id = ?');
  const updateDecoratorsStmt = db.prepare('UPDATE nodes SET decorators = ? WHERE id = ?');
  const markAsyncStmt = db.prepare('UPDATE nodes SET is_async = 1 WHERE id = ? AND is_async = 0');
  const markTestStmt = db.prepare('UPDATE nodes SET is_test = 1 WHERE id = ? AND is_test = 0');
  const findNodeByUSRStmt = db.prepare('SELECT id, kind, name, decorators FROM nodes WHERE usr = ? LIMIT 1');
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
  // Data-flow `references` edges are deduped by (source, target, role) — a
  // `read` and a `write` between the same pair are two distinct facts ("who
  // reads" vs "who writes"), so the bare (source,target,kind,provenance) key
  // would wrongly collapse them. We read existing roles for the pair and
  // compare in JS (avoids json_extract, which isn't guaranteed across the
  // native / wasm backends). Sees uncommitted inserts within this txn, so
  // repeated reads in one run collapse correctly too.
  const findRefEdgeMetadataStmt = db.prepare(
    "SELECT metadata FROM edges WHERE source = ? AND target = ? AND kind = 'references' AND provenance = 'semantic-objc'"
  );
  // Phase D (dynamic dispatch) statements: every resolved semantic call, the
  // concrete overriders of a given abstract method, and node name/path.
  const findSemanticCallEdgesStmt = db.prepare(
    "SELECT source, target, line, col, metadata FROM edges WHERE kind = 'calls' AND provenance = 'semantic-objc'"
  );
  const findOverridersOfStmt = db.prepare(
    "SELECT source FROM edges WHERE target = ? AND kind = 'override' AND provenance = 'semantic-objc'"
  );
  const findNodeMetaStmt = db.prepare('SELECT name, kind, file_path, usr FROM nodes WHERE id = ? LIMIT 1');
  const findFileNodeStmt = db.prepare(
    "SELECT id FROM nodes WHERE file_path = ? AND kind = 'file' LIMIT 1"
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
  const includeBuffer: XcIncludeRecord[] = [];
  const declBuffer: XcDeclRecord[] = [];
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
        summary.refsSeen++;
        // Buffer every ref role. `call` → semantic `calls` edge (Phase C);
        // read / write / reference → semantic `references` edge with a role
        // discriminator in metadata. Both ride edge kinds the query layer
        // already traverses (`calls` / `references`), so the data-flow shows
        // up under `callers`/`callees` and `codegraph_explore` for free.
        refBuffer.push(record as XcRefRecord);
        break;
      }
      case 'inc':
        includeBuffer.push(record as XcIncludeRecord);
        break;
      case 'dcl':
        declBuffer.push(record as XcDeclRecord);
        break;
      default:
        break;
    }
  }

  await handle.wait();

  const deltaUnitFiles = canonicaliseUnitFiles(unitFileBuffer, helperRoot, projectRoot);
  let deltaSafe = false;
  if (capRecord) {
    const plan = planSemanticObjcDelta({
      capability: capRecord,
      currentUnits: unitBuffer,
      currentUnitFiles: deltaUnitFiles,
      storedUnits: loadStoredSemanticObjcUnits(db),
      uncertainOwnership: hasAmbiguousPrimaryOwnership(deltaUnitFiles),
    });
    const rewrite = applySemanticObjcDeltaRewrite(db, plan);
    deltaSafe = rewrite.mode === 'rewritten';
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
      const node = findNodeStmt.get(filePath, sym.line) as
        | { id?: string; kind?: string; decorators?: string | null }
        | undefined;
      if (!node?.id) {
        summary.symsNotMatched++;
        continue;
      }
      updateUSRStmt.run(sym.usr, node.id);
      matchedSyms.push({ nodeId: node.id, filePath, usr: sym.usr });
      summary.symsMerged++;

      // Interface Builder marking: an `ibAnnotated` property/field is an
      // `@IBOutlet`; an `ibAnnotated` method is an `@IBAction` (invoked by the
      // storyboard/XIB, not by code — so it isn't dead, even with no caller).
      // `ibOutletCollection` is an outlet collection. Record as node decorators
      // so the agent sees how the symbol is wired. Idempotent (deduped).
      if (sym.props && sym.props.length > 0) {
        const decorators = [...ibDecoratorsFor(sym.props, node.kind), ...genericDecoratorsFor(sym.props)];
        if (decorators.length > 0 && mergeDecorators(node.decorators, decorators, node.id, updateDecoratorsStmt)) {
          // count an IB tag specifically (the high-signal one).
          if (decorators.some((d) => d.startsWith('IB'))) summary.ibSymbolsMarked++;
        }
        // Compiler-confirmed flags (more precise than path/name heuristics).
        if (sym.props.includes('swiftAsync')) {
          summary.asyncSymbolsMarked += markAsyncStmt.run(node.id).changes;
        }
        if (sym.props.includes('unitTest')) {
          summary.testSymbolsMarked += markTestStmt.run(node.id).changes;
        }
      }
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
      // CONTRACT: the helper emits the FULL current unit set every run — the
      // delta planner's removedUnitIds detection relies on the same invariant.
      // A partial dump here would wrongly prune surviving units' rows. This
      // also means the language set must stay stable across runs for one
      // project: a dump made with `--language objc` prunes units that were
      // recorded from an earlier `--language objc swift` run.
      pruneStaleSemanticObjcUnits(db, seenUnits);
      for (const unitId of seenUnits) {
        deleteUnitFilesStmt.run(unitId);
      }
      for (const unitFile of deltaUnitFiles) {
        if (!seenUnits.has(unitFile.unit_id)) continue;
        insertUnitFileStmt.run(unitFile.unit_id, unitFile.file, unitFile.role);
        summary.unitFilesMerged++;
      }
      if (deltaSafe) {
        const primaryUnitsByFile = new Map<string, string[]>();
        for (const unitFile of deltaUnitFiles) {
          if (unitFile.role !== 'primary' || !seenUnits.has(unitFile.unit_id)) continue;
          const units = primaryUnitsByFile.get(unitFile.file) ?? [];
          units.push(unitFile.unit_id);
          primaryUnitsByFile.set(unitFile.file, units);
        }
        for (const sym of matchedSyms) {
          const units = primaryUnitsByFile.get(sym.filePath);
          if (!units || units.length !== 1) continue;
          insertOwnershipStmt.run(sym.nodeId, units[0], sym.filePath, sym.usr);
          summary.ownershipRowsMerged++;
        }
      }
    }

    for (const rel of relBuffer) {
      const parentRow = findNodeByUSRStmt.get(rel.parent) as { id?: string } | undefined;
      const childRow = findNodeByUSRStmt.get(rel.child) as
        | { id?: string; decorators?: string | null }
        | undefined;

      // Framework callback: an `override` whose child is in-project but whose
      // parent (the overridden protocol requirement / superclass method) is an
      // external framework symbol. The method is invoked by the framework
      // (a delegate method, a `viewDidLoad`-style lifecycle hook), not by any
      // in-project caller — so it isn't dead code. Mark it, naming the
      // framework type, but synthesize NO edge: there's no in-project caller to
      // point from. (Increment B covers the case where a caller DOES exist.)
      if (rel.kind === 'override' && childRow?.id && !parentRow?.id) {
        const framework = frameworkSymbolName(rel.parent);
        if (
          framework &&
          mergeDecorators(childRow.decorators, [`framework:${framework}`], childRow.id, updateDecoratorsStmt)
        ) {
          summary.frameworkConformanceMarked++;
        }
        summary.relsSkipped++;
        continue;
      }

      if (!parentRow?.id || !childRow?.id) {
        summary.relsSkipped++;
        continue;
      }
      // child override-of parent — `child` is the overriding implementation,
      // `parent` is the original method on the protocol or superclass.
      // `ibType`/`specialization` map to canonical EdgeKinds; the others keep
      // their helper name (Phase D queries `override` literally, so don't remap
      // it). `type_of`/`references` flow points the declared type at the symbol.
      const edgeKind =
        rel.kind === 'ibType' ? 'type_of' : rel.kind === 'specialization' ? 'references' : rel.kind;
      const exists = checkEdgeStmt.get(childRow.id, parentRow.id, edgeKind, 'semantic-objc');
      if (exists) {
        summary.relsAlreadyPresent++;
        continue;
      }
      insertEdgeStmt.run(childRow.id, parentRow.id, edgeKind, 'semantic-objc');
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
      const target = findNodeByUSRStmt.get(ref.to_usr) as
        | { id?: string; kind?: string; name?: string }
        | undefined;
      if (!target?.id) {
        summary.refsNoTarget++;
        continue;
      }
      // `call` → semantic `calls` edge. `read`/`write`/`reference` →
      // semantic `references` edge (data-flow). The edge kind is chosen so
      // the query layer (callers/callees filter `calls`+`references`, explore
      // ranks both) surfaces it without a new traversal path.
      if (ref.role === 'call') {
        if (checkEdgeStmt.get(source.id, target.id, 'calls', 'semantic-objc')) {
          summary.refsAlreadyPresent++;
          continue;
        }
        const metadata = JSON.stringify({ dynamic: ref.dynamic, role: ref.role });
        insertCallEdgeStmt.run(
          source.id, target.id, 'calls', metadata, ref.line, ref.col, 'semantic-objc'
        );
        summary.refsMerged++;
        continue;
      }

      // Indirect dispatch: a `selector` ref (`@selector`/`#selector`/`&func`,
      // role `addressOf`) or a `reference` whose target is a callable
      // (method/function/constructor) is the method referenced as a *value* —
      // a target-action selector, a Swift `#selector`, or a function reference
      // that will be invoked later. Bridge it as a heuristic `calls` edge so
      // the flow connects (registrar → handler), the same way the tree-sitter
      // callback synthesizer bridges closures. References to *data* fall
      // through to the data-flow branch below.
      if (ref.role === 'selector' || (ref.role === 'reference' && CALLABLE_KINDS.has(target.kind ?? ''))) {
        if (checkEdgeStmt.get(source.id, target.id, 'calls', 'heuristic')) {
          summary.selectorAlreadyPresent++;
          continue;
        }
        const metadata = JSON.stringify({
          synthesizedBy: 'indexstore-indirect-ref',
          via: target.name ?? undefined,
          dynamic: true,
          registeredAt: `${filePath}:${ref.line}`,
        });
        insertCallEdgeStmt.run(
          source.id, target.id, 'calls', metadata, ref.line, ref.col, 'heuristic'
        );
        summary.selectorEdgesSynthesized++;
        continue;
      }

      // Data-flow ref: dedupe on (source, target, role).
      const existingRoles = (
        findRefEdgeMetadataStmt.all(source.id, target.id) as Array<{ metadata: string | null }>
      ).map((row) => {
        try {
          return row.metadata ? (JSON.parse(row.metadata).role as string) : undefined;
        } catch {
          return undefined;
        }
      });
      if (existingRoles.includes(ref.role)) {
        summary.refsDataflowAlreadyPresent++;
        continue;
      }
      const metadata = JSON.stringify({ dynamic: ref.dynamic, role: ref.role });
      insertCallEdgeStmt.run(
        source.id, target.id, 'references', metadata, ref.line, ref.col, 'semantic-objc'
      );
      summary.refsDataflowMerged++;
    }

    // Phase D — dynamic dispatch resolution (compiler-grounded).
    //
    // IndexStore resolves a dynamic message send `[obj foo]` to the ABSTRACT
    // method (protocol requirement / overridable superclass method) and records
    // an `override` relation from every concrete implementation to it. By now
    // we've inserted both halves: `caller --calls(dynamic)--> abstract` (Phase
    // C) and `concreteImpl --override--> abstract` (Phase B). The agent would
    // otherwise have to read every conformer to find which impls can run — so
    // we bridge the gap: synthesize `caller --calls--> concreteImpl` for each
    // override, tagged `provenance:'heuristic'` so `codegraph_explore` surfaces
    // it inline as a dynamic-dispatch hop. This is strictly more precise than
    // the tree-sitter `interface-impl` / `cpp-override` heuristics: the override
    // set comes from the compiler, not from name-matching.
    // Callsite-specific receiver refinements from IndexStore. `receivedBy`
    // means: at this occurrence, the dynamic send's receiver is this concrete
    // class. Keep this separate from the graph-level relation edge because the
    // same abstract method can be received by many classes at many callsites.
    const receiverUSRsByCallsite = new Map<string, string[]>();
    for (const rel of relBuffer) {
      if (rel.kind !== 'receivedBy' || !rel.file || rel.line == null || rel.col == null) continue;
      const filePath = canonicaliseSymPath(rel.file, helperRoot, projectRoot);
      if (filePath === null) continue;
      const key = `${rel.child}\0${filePath}\0${rel.line}\0${rel.col}`;
      const values = receiverUSRsByCallsite.get(key) ?? [];
      values.push(rel.parent);
      receiverUSRsByCallsite.set(key, values);
    }

    const semanticCallEdges = findSemanticCallEdgesStmt.all() as Array<{
      source: string;
      target: string;
      line: number | null;
      col: number | null;
      metadata: string | null;
    }>;
    for (const edge of semanticCallEdges) {
      let isDynamic = false;
      try {
        isDynamic = edge.metadata ? JSON.parse(edge.metadata).dynamic === true : false;
      } catch {
        isDynamic = false;
      }
      if (!isDynamic) continue;

      const overriders = findOverridersOfStmt.all(edge.target) as Array<{ source: string }>;
      if (overriders.length === 0) continue;

      // `receivedBy` is IndexStore's receiver-type refinement for a dynamic send.
      // On a call like `[_faceTask initTask]`, the semantic call may point to the
      // overridable superclass method (`BEAlgorithmTask.initTask`) while the
      // relation says the receiver is `BEFaceAlgorithmTask`. Without this filter,
      // Phase D fans out to EVERY override of `initTask`, which is exactly the
      // kind of partial/over-broad dynamic coverage that makes agents read again.
      // Prefer receiver-compatible overrides; fall back to all overriders only
      // when the helper/indexer provided no usable receiver narrowing.
      const abstractNode = findNodeMetaStmt.get(edge.target) as { name?: string; usr?: string | null } | undefined;
      const callerNode = findNodeMetaStmt.get(edge.source) as { file_path?: string } | undefined;
      const callsiteKey =
        abstractNode?.usr && callerNode?.file_path && edge.line != null && edge.col != null
          ? `${abstractNode.usr}\0${callerNode.file_path}\0${edge.line}\0${edge.col}`
          : null;
      const receiverUSRs = callsiteKey ? (receiverUSRsByCallsite.get(callsiteKey) ?? []) : [];
      const narrowedOverriders = receiverUSRs.length > 0
        ? overriders.filter((overrider) => {
            const node = findNodeMetaStmt.get(overrider.source) as { usr?: string | null } | undefined;
            return typeof node?.usr === 'string' && receiverUSRs.some((receiverUSR) =>
              isObjcMethodUSRForClass(node.usr!, receiverUSR)
            );
          })
        : [];
      const dispatchTargets = narrowedOverriders.length > 0 ? narrowedOverriders : overriders;
      if (dispatchTargets.length === 0) continue;
      summary.dynamicCallSitesResolved++;

      const via = abstractNode?.name ?? 'dynamic dispatch';
      const registeredAt =
        callerNode?.file_path && edge.line != null ? `${callerNode.file_path}:${edge.line}` : undefined;

      for (const overrider of dispatchTargets) {
        if (overrider.source === edge.source || overrider.source === edge.target) continue;
        if (checkEdgeStmt.get(edge.source, overrider.source, 'calls', 'heuristic')) {
          summary.dynamicDispatchAlreadyPresent++;
          continue;
        }
        const meta = JSON.stringify({
          synthesizedBy: 'indexstore-dynamic-dispatch',
          via,
          dynamic: true,
          ...(registeredAt ? { registeredAt } : {}),
        });
        insertCallEdgeStmt.run(edge.source, overrider.source, 'calls', meta, edge.line, null, 'heuristic');
        summary.dynamicDispatchSynthesized++;
      }
    }

    // Phase E — file-level `#include`/`#import` graph. Link the project file
    // nodes so "what would changing this header touch" is a graph hop.
    for (const inc of includeBuffer) {
      const fromPath = canonicaliseSymPath(inc.from, helperRoot, projectRoot);
      const toPath = canonicaliseSymPath(inc.to, helperRoot, projectRoot);
      if (fromPath === null || toPath === null) continue;
      const fromNode = findFileNodeStmt.get(fromPath) as { id?: string } | undefined;
      const toNode = findFileNodeStmt.get(toPath) as { id?: string } | undefined;
      if (!fromNode?.id || !toNode?.id) continue;
      if (checkEdgeStmt.get(fromNode.id, toNode.id, 'imports', 'semantic-objc')) continue;
      insertEdgeStmt.run(fromNode.id, toNode.id, 'imports', 'semantic-objc');
      summary.includeEdgesMerged++;
    }

    // Phase F — decl → def. Link a `.h` declaration node to its `.m`
    // definition (`references`, so `callees(decl)` reaches the implementation).
    for (const dcl of declBuffer) {
      const declPath = canonicaliseSymPath(dcl.file, helperRoot, projectRoot);
      if (declPath === null) continue;
      const declNode = findNodeStmt.get(declPath, dcl.line) as { id?: string } | undefined;
      if (!declNode?.id) continue;
      const defNode = findNodeByUSRStmt.get(dcl.usr) as { id?: string } | undefined;
      if (!defNode?.id || defNode.id === declNode.id) continue;
      if (checkEdgeStmt.get(declNode.id, defNode.id, 'references', 'semantic-objc')) continue;
      insertCallEdgeStmt.run(
        declNode.id,
        defNode.id,
        'references',
        JSON.stringify({ role: 'declaration' }),
        dcl.line,
        dcl.col,
        'semantic-objc'
      );
      summary.declEdgesMerged++;
    }

    markSemanticObjcMergeCompleted(db, {
      symsSeen: summary.symsSeen,
      symsMerged: summary.symsMerged,
      symsOutsideProject: summary.symsOutsideProject,
      symsNotMatched: summary.symsNotMatched,
      unitsSeen: summary.unitsSeen,
      unitsMerged: summary.unitsMerged,
      unitFilesSeen: summary.unitFilesSeen,
      unitFilesMerged: summary.unitFilesMerged,
      ownershipRowsMerged: summary.ownershipRowsMerged,
      relsSeen: summary.relsSeen,
      relsMerged: summary.relsMerged,
      relsSkipped: summary.relsSkipped,
      relsAlreadyPresent: summary.relsAlreadyPresent,
      refsSeen: summary.refsSeen,
      refsMerged: summary.refsMerged,
      refsOutsideProject: summary.refsOutsideProject,
      refsNoSource: summary.refsNoSource,
      refsNoTarget: summary.refsNoTarget,
      refsAlreadyPresent: summary.refsAlreadyPresent,
      refsDataflowMerged: summary.refsDataflowMerged,
      refsDataflowAlreadyPresent: summary.refsDataflowAlreadyPresent,
      refsNonCall: summary.refsNonCall,
      dynamicCallSitesResolved: summary.dynamicCallSitesResolved,
      dynamicDispatchSynthesized: summary.dynamicDispatchSynthesized,
      dynamicDispatchAlreadyPresent: summary.dynamicDispatchAlreadyPresent,
      selectorEdgesSynthesized: summary.selectorEdgesSynthesized,
      selectorAlreadyPresent: summary.selectorAlreadyPresent,
      ibSymbolsMarked: summary.ibSymbolsMarked,
      asyncSymbolsMarked: summary.asyncSymbolsMarked,
      testSymbolsMarked: summary.testSymbolsMarked,
      frameworkConformanceMarked: summary.frameworkConformanceMarked,
      includeEdgesMerged: summary.includeEdgesMerged,
      declEdgesMerged: summary.declEdgesMerged,
    });
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

function pruneStaleSemanticObjcUnits(db: SqliteDatabase, seenUnits: Set<string>): void {
  if (seenUnits.size === 0) return;
  const unitIds = [...seenUnits];
  const placeholders = unitIds.map(() => '?').join(', ');
  db.prepare(`DELETE FROM semantic_objc_unit_files WHERE unit_id NOT IN (${placeholders})`).run(...unitIds);
  db.prepare(`DELETE FROM semantic_objc_node_ownership WHERE unit_id NOT IN (${placeholders})`).run(...unitIds);
  db.prepare(`DELETE FROM semantic_objc_units WHERE unit_id NOT IN (${placeholders})`).run(...unitIds);
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
