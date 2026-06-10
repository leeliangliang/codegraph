/**
 * NDJSON record types emitted by the codegraph-xchelper Swift binary.
 *
 * The Swift side lives in `src/extraction/semantic-objc/swift/` and emits these
 * one per line on stdout. Keep these shapes in sync with the emitters in
 * `Sources/CodegraphXchelper/Queries.swift`.
 */

/** Header record. First line of any helper run. */
export interface XcMetaRecord {
  t: 'meta';
  sourceRoot: string;
  languageFilter: string[];
  includeSystem: boolean;
}

export interface XcCapabilityRecord {
  t: 'cap';
  semanticDeltaVersion: number;
  helperVersion: string;
  unitFingerprintAlgorithm: string;
  recordKinds: string[];
  sourceMembership: boolean;
}

export interface XcUnitRecord {
  t: 'unit';
  unit_id: string;
  fingerprint: string;
  mtime?: number;
  main_file?: string;
}

export interface XcUnitFileRecord {
  t: 'unit_file';
  unit_id: string;
  file: string;
  role: 'primary' | 'header' | 'generated';
}

/**
 * A symbol declaration or definition. `usr` is the Clang/Swift USR — the stable
 * cross-file identifier that lets us bridge to tree-sitter nodes after the
 * extraction pass.
 */
export interface XcSymRecord {
  t: 'sym';
  usr: string;
  name: string;
  /** IndexStoreDB symbol kind ('class' | 'instanceMethod' | 'extension' | …). */
  kind: string;
  lang: 'objc' | 'swift' | 'c' | 'cpp';
  /** File path, relative to `sourceRoot` when possible. */
  file: string;
  line: number;
  /** UTF-8 column (1-indexed). */
  col: number;
  isDecl: boolean;
  isDef: boolean;
  isSystem: boolean;
  /** True iff the symbol is an Objective-C category (`kind === 'extension'`, `lang === 'objc'`). */
  category?: boolean;
  /**
   * IndexStoreDB SymbolProperty tokens present on this symbol, e.g.
   * `ibAnnotated`, `ibOutletCollection`, `unitTest`, `swiftAsync`, `generic`,
   * `templateSpecialization`, `protocolInterface`. Absent when none apply.
   */
  props?: string[];
}

/** A reference to a symbol — a call site, a read, a write, or a generic reference. */
export interface XcRefRecord {
  t: 'ref';
  to_usr: string;
  /**
   * `call` — direct call. `read`/`write` — data access. `reference` — a
   * non-call mention (includes Swift `#selector` / function values, which the
   * indexer records as references to the method). `selector` — an `addressOf`
   * occurrence (`@selector` / `&func` taken as a value).
   */
  role: 'call' | 'read' | 'write' | 'reference' | 'selector';
  file: string;
  line: number;
  col: number;
  /** True when the call goes through Objective-C dynamic dispatch (`id`-typed receiver). */
  dynamic: boolean;
}

/**
 * A cross-symbol relation. `kind` describes the relationship, with `parent` and
 * `child` named from the consumer's POV (e.g. for `override`, the protocol or
 * superclass method is `parent` and the overriding method is `child`).
 */
export interface XcRelRecord {
  t: 'rel';
  kind: 'override' | 'base' | 'extended' | 'accessor' | 'receivedBy' | 'ibType' | 'specialization';
  parent: string;
  child: string;
  /** Occurrence location for callsite-specific relations such as `receivedBy`. */
  file?: string;
  line?: number;
  col?: number;
}

/**
 * A `#include` / `#import` edge between two in-project files (both endpoints
 * resolved to project file nodes; system-header targets are filtered out by
 * the helper). Drives the file-level header dependency graph.
 */
export interface XcIncludeRecord {
  t: 'inc';
  /** Including file (relative to sourceRoot when possible, else absolute). */
  from: string;
  /** Included file. */
  to: string;
  line: number;
}

/**
 * A forward declaration of a symbol whose definition lives elsewhere — e.g. an
 * Objective-C method's `.h` `@interface` declaration vs its `.m`
 * `@implementation`. `usr` is the definition's USR, so the Node side can link
 * the declaration node to the definition node.
 */
export interface XcDeclRecord {
  t: 'dcl';
  usr: string;
  file: string;
  line: number;
  col: number;
}

/** Trailer with counts. Last line of any helper run. */
export interface XcDoneRecord {
  t: 'done';
  symbols: number;
  refs: number;
  rels: number;
}

export type XcRecord =
  | XcMetaRecord
  | XcCapabilityRecord
  | XcUnitRecord
  | XcUnitFileRecord
  | XcSymRecord
  | XcRefRecord
  | XcRelRecord
  | XcIncludeRecord
  | XcDeclRecord
  | XcDoneRecord;

export interface SemanticDeltaCapability {
  safe: boolean;
  reason?: string;
  version?: number;
  helperVersion?: string;
  fingerprintAlgorithm?: string;
}

const DELTA_RECORD_KINDS = ['unit', 'unit_file', 'sym', 'rel', 'ref'];
const SUPPORTED_DELTA_VERSION = 1;
const SUPPORTED_FINGERPRINT_ALGORITHMS = new Set(['index-unit-v1']);

/**
 * Best-effort runtime narrowing for the `t` discriminator — used by the spawner
 * to drop malformed lines without crashing the whole enrichment pass.
 */
export function isXcRecord(value: unknown): value is XcRecord {
  if (!value || typeof value !== 'object') return false;
  const t = (value as { t?: unknown }).t;
  return (
    t === 'meta' ||
    t === 'cap' ||
    t === 'unit' ||
    t === 'unit_file' ||
    t === 'sym' ||
    t === 'ref' ||
    t === 'rel' ||
    t === 'inc' ||
    t === 'dcl' ||
    t === 'done'
  );
}

export function evaluateSemanticDeltaCapability(
  cap: XcCapabilityRecord | null | undefined
): SemanticDeltaCapability {
  if (!cap) {
    return { safe: false, reason: 'helper-missing-delta-capability' };
  }
  if (cap.semanticDeltaVersion < SUPPORTED_DELTA_VERSION) {
    return { safe: false, reason: 'helper-delta-version-unsupported' };
  }
  if (!SUPPORTED_FINGERPRINT_ALGORITHMS.has(cap.unitFingerprintAlgorithm)) {
    return { safe: false, reason: 'helper-fingerprint-algorithm-unsupported' };
  }
  if (!cap.sourceMembership) {
    return { safe: false, reason: 'helper-missing-source-membership' };
  }
  for (const kind of DELTA_RECORD_KINDS) {
    if (!cap.recordKinds.includes(kind)) {
      return { safe: false, reason: `helper-missing-record-kind:${kind}` };
    }
  }
  return {
    safe: true,
    version: cap.semanticDeltaVersion,
    helperVersion: cap.helperVersion,
    fingerprintAlgorithm: cap.unitFingerprintAlgorithm,
  };
}
