# codegraph-xchelper

Mac-native helper that reads Xcode's IndexStore (`Index.noindex/DataStore`) and
emits NDJSON for the Node.js CodeGraph process to merge into its tree-sitter
graph as a **semantic enrichment**.

This is the **Phase 2-alpha prototype** — standalone, not yet wired into the
parent Node project. The integration plan lives in
`.omc/research/research-20260522-xcindex/report.md`.

## Why

CodeGraph's tree-sitter pass is fast, deterministic, cross-platform, and zero
config — but it's *syntactic*. It sees `[obj msg]` as a message send to
selector `msg`, but it can't tell you which concrete method runs.

Xcode already does the semantic work during a normal build (`-index-store-path`),
producing a binary index in `DerivedData`. This helper reads that index via
Apple's `swiftlang/indexstore-db` and emits the data CodeGraph needs to
*upgrade* its syntactic edges to semantic ones.

## Build

Requires Swift 5.9+ and Xcode 14+ (we test against Swift 6.0.3 / Xcode 16).

```bash
swift build -c release
```

The binary lands at `.build/release/codegraph-xchelper`.

## Subcommands

```bash
# Find the .indexstore for a project source root.
codegraph-xchelper discover --source-root /path/to/proj

# Print store path + mtime + unit/record counts.
codegraph-xchelper status --source-root /path/to/proj

# Stream the full store as NDJSON. Default filters to Objective-C symbols only.
codegraph-xchelper dump \
    --source-root /path/to/proj \
    --language objc

# Pass an explicit store path (skip discovery).
codegraph-xchelper dump \
    --store-path ~/Library/Developer/Xcode/DerivedData/MyProj-xxx/Index.noindex/DataStore \
    --source-root /path/to/proj
```

## NDJSON output shape

Each line is one JSON object. The discriminator is the `t` field.

```jsonc
// header
{"t":"meta","sourceRoot":"...","languageFilter":["objc"],"includeSystem":false}

// symbol declaration / definition
{"t":"sym","usr":"c:objc(cs)MyVC","name":"MyVC","kind":"class","lang":"objc",
 "file":"Sources/MyVC.m","line":12,"col":17,"isDecl":false,"isDef":true,
 "isSystem":false}

// reference (call / read / write)
{"t":"ref","to_usr":"c:objc(cs)UIVC(im)viewDidLoad","role":"call",
 "file":"Sources/MyVC.m","line":15,"col":11,"dynamic":false}

// cross-symbol relation (override / conformance / extension)
{"t":"rel","kind":"override","parent":"c:objc(cs)UIVC(im)viewDidLoad",
 "child":"c:objc(cs)MyVC(im)viewDidLoad"}

// trailer
{"t":"done","symbols":1234,"refs":98765,"rels":456}
```

## How the Node side will consume it (Phase 2-β)

Not yet implemented. The plan:
1. CodeGraph's `ExtractionOrchestrator` finishes the tree-sitter pass.
2. On macOS, if a `.indexstore` is discoverable, spawn `codegraph-xchelper dump`.
3. A new `semantic-objc/merger.ts` reads NDJSON line-by-line, matches by
   `(file, line)` to the tree-sitter nodes already in SQLite, and:
   - populates `nodes.usr` for matched nodes
   - upgrades syntactic `calls` edges (resolved by name) to semantic edges
     (resolved by USR) with `target_usr` filled in and `semantic = 1`
   - inserts new edges for `override`, `conformance`, `category→base`
     relationships that the tree-sitter pass can't express.

## Known limits (intentional)

- macOS only. Requires Xcode CLI Tools at minimum (for `libIndexStore.dylib`).
- Requires a prior Xcode build (the `.indexstore` is a build artifact).
- Dynamic `id`-typed dispatch is marked `dynamic: true` but not resolved —
  ObjC's type system genuinely can't disambiguate it. Periphery (the unused-code
  detector) skips ObjC entirely for the same reason.
- Categories use `kind: "extension"` in the IndexStoreDB schema. The merger
  will decode `(ext CategoryName)` from the USR to recover the base class link.

## Why not fork drewalth/claude-xcindex?

It's an MCP server for Claude Code (its own MCP tool surface). CodeGraph
already has its own MCP server. Forking would tangle two separate product
surfaces. The portable value (~250 lines) lives in claude-xcindex's
`Queries.swift` + `DerivedData.swift` — we port that, skip its MCP layer.
