# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CodeGraph is a local-first code intelligence library + CLI + MCP server. It parses any supported codebase with tree-sitter, stores symbols/edges/files in SQLite (FTS5), and exposes a knowledge graph to AI agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent) over MCP. Per-project data lives in `.codegraph/`. Extraction is deterministic — derived from AST, not LLM-summarized.

Distributed as `@colbymchenry/codegraph` on npm; same binary serves as installer, indexer, and MCP server.

## Build, Test, Run

```bash
npm run build                  # tsc + copy schema.sql and *.wasm into dist/; chmods dist/bin/codegraph.js
npm run dev                    # tsc --watch
npm run clean                  # remove dist/
npm run copy-assets            # copy schema.sql and grammar WASMs into dist/
npm run build:mac-objc-helper  # rebuild the optional macOS Objective-C semantic helper

npm test                       # vitest run (all)
npm run test:watch             # vitest watch mode
npm run test:eval              # only __tests__/evaluation/
npm run eval                   # build then run __tests__/evaluation/runner.ts via tsx

npm run cli                    # build then run the local dist binary
npm link                       # make global `codegraph` point at this local build

# Single test file / pattern
npx vitest run __tests__/installer-targets.test.ts
npx vitest run __tests__/extraction.test.ts -t "TypeScript"
```

There is no lint script in `package.json`; use `npm run build` for TypeScript validation.

When testing unpublished local changes, run `npm run build && npm link` from this repository before configuring agents. That makes the global `codegraph` command resolve to the local `dist/bin/codegraph.js` instead of the published npm package; verify with `which codegraph`, `codegraph --version`, and command help such as `codegraph enrich-objc --help`.

`npm link` is normally one-time per Node/npm prefix. After changing CodeGraph source, run `npm run build` again because the linked CLI executes `dist/bin/codegraph.js`, not `src/bin/codegraph.ts`. Re-run `npm link` only if the global link is lost, the npm prefix changes, or the package metadata/bin mapping changes.

`copy-assets` (called from `build`) copies `src/db/schema.sql` and all `src/extraction/wasm/*.wasm` files into `dist/`. **Any new SQL or grammar wasm must be copied or it won't ship.**

Node engines: `>=20.0.0 <25.0.0`. The CLI hard-blocks Node below 20 and Node 25.x unless `CODEGRAPH_ALLOW_UNSAFE_NODE=1` is set (see `src/bin/node-version-check.ts`).

## Architecture

### Layered pipeline

```
files → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/files)
              ↓
       ReferenceResolver (imports, name-matching, framework patterns)
              ↓
       GraphQueryManager / GraphTraverser (callers, callees, impact)
              ↓
       ContextBuilder (markdown/JSON for AI consumption)
```

The public API surface is `src/index.ts` — the `CodeGraph` class wires all the layers and re-exports types. Library users only touch this file; the MCP server and CLI also drive it.

### Module layout

- `src/index.ts` — `CodeGraph` class: `init`/`open`/`close`, `indexAll`, `sync`, `searchNodes`, `getCallers`/`getCallees`, `getImpactRadius`, `buildContext`, `watch`/`unwatch`.
- `src/db/` — `DatabaseConnection`, `QueryBuilder` (prepared statements), `schema.sql`. Backed by Node's built-in `node:sqlite` (`SqliteBackend = 'node-sqlite'`) with WAL/FTS5; self-contained releases bundle a compatible Node runtime, while source runs require Node 22.5+ for `node:sqlite`.
- `src/extraction/` — `ExtractionOrchestrator`, tree-sitter wrappers, per-language extractors under `languages/` (one file per language), plus standalone extractors for non-tree-sitter formats (`svelte-extractor.ts`, `vue-extractor.ts`, `liquid-extractor.ts`, `dfm-extractor.ts` for Delphi). `grammars.ts` is the source of truth for extension → language mapping; YAML/Twig are file-level tracking only. `semantic-objc/` is the macOS Xcode IndexStore enrichment layer for Objective-C / Swift. `parse-worker.ts` runs heavy parsing off the main thread.
- `src/resolution/` — `ReferenceResolver` orchestrates `import-resolver.ts` (with `path-aliases.ts` for tsconfig path aliases + cargo workspace member globs), `name-matcher.ts`, and `frameworks/` (Express, Laravel, Rails, FastAPI, Django, Flask, Spring, Gin, Axum, ASP.NET, Vapor, React Router, SvelteKit, Vue/Nuxt, Cargo workspaces). Frameworks emit `route` nodes and `references` edges.
- `src/graph/` — `GraphTraverser` (BFS/DFS, impact radius, path finding) and `GraphQueryManager` (high-level queries).
- `src/context/` — `ContextBuilder` + formatter for markdown/JSON output.
- `src/search/` — full-text query parser and helpers for FTS5.
- `src/sync/` — `FileWatcher` (native FSEvents/inotify/RDCW) with debounce + filter, and git-hook helpers.
- `src/mcp/` — MCP server (`MCPServer`, `tools.ts`, `transport.ts`). `server-instructions.ts` is what the server returns in the MCP `initialize` response — keep it in sync with the user-facing tool guidance.
- `src/installer/` — see below.
- `src/bin/codegraph.ts` — CLI (commander). Subcommands: `install`, `init`, `uninit`, `index`, `sync`, `status`, `query`, `files`, `context`, `affected`, `serve --mcp`.
- `src/ui/` — terminal UI (shimmer progress, worker).

### Objective-C / Swift semantic enrichment

Objective-C and Swift have two layers:

1. The normal tree-sitter pass is cross-platform and zero-config. It indexes `.swift`, `.m`, `.mm`, and Objective-C-looking `.h` files, extracting classes, protocols, methods/selectors, properties, imports, C-style functions, and syntactic call/message-send edges.
2. The macOS-only semantic layer reads Xcode's IndexStore (`DerivedData/.../Index.noindex/DataStore`) via the Swift helper `codegraph-xchelper` in `src/extraction/semantic-objc/swift/`. It enriches SQLite with Clang/Swift USRs plus semantic calls, overrides, conformance/base relationships, and category links using `provenance = 'semantic-objc'`.

Common local workflow for an iOS/macOS project:

```bash
# From this CodeGraph repo, when testing unpublished IndexStore work:
npm run build && npm link
codegraph enrich-objc --help  # verify the linked CLI exposes the local command

# In the target Xcode project, build first so Xcode writes IndexStore data:
xcodebuild -workspace YourApp.xcworkspace -scheme YourScheme build

# Then initialize/index and run semantic enrichment:
codegraph init -i /path/to/project
codegraph index --with-semantic-objc /path/to/project

# Or run enrichment separately, including Swift records explicitly:
codegraph enrich-objc /path/to/project --language objc swift

# If discovery fails, pass the Xcode store/helper explicitly:
codegraph enrich-objc /path/to/project \
  --store-path ~/Library/Developer/Xcode/DerivedData/YourApp-xxxx/Index.noindex/DataStore \
  --helper /Users/lee/Documents/Codegraph/packages/mac-objc-enricher/bin/codegraph-xchelper \
  --language objc swift
```

`codegraph index` and `codegraph sync` both expose `--with-semantic-objc`, `--semantic-objc-helper <path>`, and `--semantic-objc-store-path <path>`. The Swift helper requires macOS with Xcode / `libIndexStore.dylib`; Xcode's prior build is mandatory because the IndexStore is a build artifact.

For a target OC/Swift project, `codegraph init -i` is a one-time setup. After source-only edits, the MCP server's watcher usually syncs automatically; otherwise run `codegraph sync /path/to/project`. After an Xcode build changes IndexStore data and semantic edges matter, run `codegraph sync --with-semantic-objc /path/to/project` or `codegraph enrich-objc /path/to/project --language objc swift`.

Incremental semantic refresh is MCP-configured through `codegraph serve --mcp --semantic-objc-config '<json>'`. The current config shape is `semanticObjc`-style JSON with `enabled`, `watchIndexStore`, `storePath`, `helperPath`, `languages`, `deltaMode: "unit"`, `fallback: "stale-then-idle-reconcile"`, `quiescence`, and `scheduler: { "mode": "idle-only" }`. CodeGraph watches the IndexStore after Xcode updates it, waits for quiescence (file count, mtime, size stability), and uses confidence-gated unit delta planning; if helper capability, source membership, or ownership scope is uncertain, it marks semantic ObjC stale instead of deleting existing `provenance = 'semantic-objc'` data. `codegraph_status` surfaces semantic fresh/stale state.

### NodeKind / EdgeKind

Defined in `src/types.ts`. Both extractors and resolvers must use these exact strings.

- **NodeKind**: `file`, `module`, `class`, `struct`, `interface`, `trait`, `protocol`, `function`, `method`, `property`, `field`, `variable`, `constant`, `enum`, `enum_member`, `type_alias`, `namespace`, `parameter`, `import`, `export`, `route`, `component`.
- **EdgeKind**: `contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, `decorates`.

### Multi-agent installer

`src/installer/` is the entry point for `codegraph install` (and the bare `codegraph`/`npx @colbymchenry/codegraph` invocation). Architecture:

- `targets/registry.ts` lists every supported agent.
- `targets/types.ts` defines the `AgentTarget` interface — adding another agent (Continue, Zed, Windsurf…) is **one new file in `targets/` + one entry in `registry.ts`**. Each target owns its config-file location, MCP-server JSON/TOML/JSONC writing, and instructions-file path.
- Current targets: `claude.ts`, `cursor.ts`, `codex.ts`, `opencode.ts`, `hermes.ts`.
- `targets/toml.ts` is a hand-rolled TOML serializer scoped to `[mcp_servers.codegraph]` (used by Codex). Sibling tables and `[[array_of_tables]]` are preserved verbatim. No new dependency.
- opencode reads `opencode.jsonc` by default; the installer prefers existing `.jsonc`, falls back to `.json`, and creates `.jsonc` for greenfield installs. Edits are surgical via `jsonc-parser` so user comments and formatting survive install/re-install/uninstall round-trips.
- `instructions-template.ts` is the agent-agnostic instructions file written to each target (e.g. `CLAUDE.md`, `.cursor/rules/codegraph.mdc`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`). It explicitly says "trust codegraph results, don't re-verify with grep" — earlier versions prescribed Claude-specific "spawn an Explore agent" and confused other agents.
- `claude-md-template.ts` is the legacy Claude-only template, retained for compatibility paths.
- All installer changes need matching coverage in `__tests__/installer-targets.test.ts` — there are ~47 parameterized contract tests covering install idempotency, sibling preservation, uninstall reverses install, byte-equal re-runs returning `unchanged`, and partial-state recovery for Codex.

### Cursor MCP working-directory quirk

Cursor launches MCP subprocesses with the wrong cwd and doesn't pass `rootUri` in `initialize`. The installer injects `--path` into Cursor's MCP args — absolute path for local installs, `${workspaceFolder}` for global installs. If you touch Cursor wiring, preserve this.

### MCP server instructions

`src/mcp/server-instructions.ts` is sent back to the agent in the MCP `initialize` response. This is the *first* thing every agent sees about how to use the tools — treat it as the authoritative tool guidance and keep it in sync with `instructions-template.ts` and `.cursor/rules/codegraph.mdc`. Current guidance says to use CodeGraph directly for structural questions, trust AST results, avoid grep/read re-verification, and avoid delegating exploration just to repeat CodeGraph's index work.

## Tests

Tests live in `__tests__/` and mirror the module they cover. Notable ones beyond the obvious:

- `installer-targets.test.ts` — parameterized contract suite across all agent targets (see installer notes above).
- `evaluation/` — `runner.ts` + `test-cases.ts` exercise codegraph against synthetic projects and score the results; run via `npm run eval` (builds first). Not part of `npm test`.
- `sqlite-backend.test.ts` — covers `node:sqlite` backend reporting and WAL/FTS behavior.
- `pr19-improvements.test.ts`, `frameworks-integration.test.ts` — regression coverage for specific past PRs/incidents; don't rename these, the names anchor to git history.

Tests create temp dirs with `fs.mkdtempSync` and clean up in `afterEach`. They write real files and exercise real SQLite — there is no DB mocking.

## Releases

Released to npm and mirrored as [GitHub Releases](https://github.com/colbymchenry/codegraph/releases). `CHANGELOG.md` is the source of truth; GitHub Release notes are extracted from it.

### Writing changelog entries

When asked for an entry for a new version:

1. Add a new `## [X.Y.Z] - YYYY-MM-DD` block at the **top** of `CHANGELOG.md` (under the intro, above the previous version).
2. Group under `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Deprecated`, `### Security` — omit empty sections.
3. Write from the **user's perspective**, not the implementation's. Lead with the observable symptom or capability; mention internals only if a user needs them (e.g., to work around an existing bad install).
4. Add the link reference at the bottom: `[X.Y.Z]: https://github.com/colbymchenry/codegraph/releases/tag/vX.Y.Z`.

### Release flow (the user runs these)

Releases are built and published by the **GitHub Actions "Release" workflow**
(`.github/workflows/release.yml`). It bundles a Node runtime per platform
(`scripts/build-bundle.sh`) and publishes both the GitHub Release and the npm
thin-installer (`scripts/pack-npm.sh`: a shim package + per-platform packages).
Publishing manually is **wrong** now — a plain `npm publish` ships the root
package (non-bundled), which breaks anyone on Node < 22.5.

After the changelog entry is written and `package.json` is bumped:

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: X.Y.Z (<one-line summary>)"
git push
```

Then trigger **Actions → Release → Run workflow** (on `main`). It reads the
version from `package.json`, builds every platform bundle on one runner, creates
the GitHub Release with notes from the matching `CHANGELOG.md` section, and
publishes to npm. Requires the `NPM_TOKEN` repo secret.

**Do not run `npm publish`, `git push`, or `git tag` yourself** — these are
publish actions on shared state. Write the files, hand the user the commands.

## House rules

- Any change to `src/installer/` (especially `targets/`) needs corresponding test coverage and a CHANGELOG entry — installer regressions break every new install silently.
- When changing what the MCP tools do or how agents should use them, update **all three** of `src/mcp/server-instructions.ts`, `src/installer/instructions-template.ts`, and `.cursor/rules/codegraph.mdc` — they're written to different places but say the same thing.
- CodeGraph provides **code context**, not product requirements. For new features, ask the user about UX, edge cases, and acceptance criteria — the graph won't tell you.
