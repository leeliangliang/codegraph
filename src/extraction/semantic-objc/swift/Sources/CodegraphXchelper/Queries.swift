// Queries — IndexStoreDB iteration that emits CodeGraph-friendly NDJSON.
//
// Each line is one self-contained JSON object with a `t` discriminator:
//   {"t":"sym",  ...}  symbol declaration / definition
//   {"t":"ref",  ...}  occurrence (call, read, write, etc.) of a symbol
//   {"t":"rel",  ...}  cross-symbol relation (override / conformance / etc.)
//   {"t":"meta", ...}  header before any data
//   {"t":"done", ...}  trailer with counts
//
// The Node side reads this stream and merges into the existing tree-sitter
// graph by (file, line) matching: tree-sitter nodes get their `usr` field
// populated and any new semantic edges (override / conformance / category→base)
// are inserted as additional edges with `semantic: 1`.

import Foundation
import IndexStoreDB

/// Extensions of compilable (primary) translation-unit sources. Single source
/// of truth shared with `sourceExtensions(for:)` in main.swift — a file the
/// dump indexes but this set misses loses its file→unit membership in
/// `emitUnitMembership` and is misclassified as `"header"` by `unitFileRole`.
let primarySourceFileExtensions: Set<String> = ["m", "mm", "c", "cc", "cpp", "cxx", "swift"]

struct Queries {
    let db: IndexStoreDB
    let sourceRoot: String
    let languageFilter: Set<Language> // empty = all
    let includeSystem: Bool

    /// Emit the full store as NDJSON on stdout. Returns (symbols, refs, rels) counts.
    ///
    /// Two-phase to avoid LMDB `MDB_BAD_RSLOT` from nested read transactions:
    ///   Phase 1 — collect every symbol name; no nested DB calls.
    ///   Phase 2 — outside the name callback, stream canonical occurrences and
    ///             per-USR occurrences without materializing whole result arrays.
    func dumpAll() throws -> (symbols: Int, refs: Int, rels: Int) {
        emitMeta()
        emitCap()

        // Phase 1: drain names into a flat array.
        var names: [String] = []
        names.reserveCapacity(64 * 1024)
        db.forEachSymbolName { name in
            names.append(name)
            return true
        }

        // Phase 2: per name → canonical occurrences → per USR walk all references.
        var symCount = 0
        var refCount = 0
        var relCount = 0
        var seenUSRs = Set<String>()
        seenUSRs.reserveCapacity(names.count)
        var indexedFiles = Set<String>()

        for name in names {
            // Drain per-name: occurrence iteration bridges ObjC/CF temporaries
            // (paths, USR strings) that otherwise pile up in the never-drained
            // top-level pool across hundreds of thousands of names.
            autoreleasepool {
                var canonicalOccurrencesForName: [SymbolOccurrence] = []
                db.forEachCanonicalSymbolOccurrence(byName: name) { occ in
                    canonicalOccurrencesForName.append(occ)
                    return true
                }

                for occ in canonicalOccurrencesForName {
                    if !languageMatches(occ.symbol.language) { continue }
                    if !includeSystem && occ.location.isSystem { continue }

                    let usr = occ.symbol.usr
                    if seenUSRs.contains(usr) { continue }
                    seenUSRs.insert(usr)

                    indexedFiles.insert(occ.location.path)
                    emitSym(occ)
                    symCount += 1

                    // Stream refs + rels for this USR. This callback does not issue
                    // nested IndexStoreDB queries, so it remains LMDB-safe.
                    db.forEachSymbolOccurrence(byUSR: usr, roles: .all) { ref in
                        if !includeSystem && ref.location.isSystem { return true }
                        indexedFiles.insert(ref.location.path)
                        let isDecl = ref.roles.contains(.declaration)
                        let isDef = ref.roles.contains(.definition)
                        let isDeclOrDef = isDecl || isDef
                        // A forward declaration at a different site than the
                        // canonical (definition) occurrence — e.g. the `.h`
                        // `@interface` method vs the `.m` `@implementation`. Emit a
                        // `dcl` record so the Node side can link decl → def.
                        if isDecl && !isDef
                            && !(ref.location.path == occ.location.path && ref.location.line == occ.location.line) {
                            emitDecl(ref, defUSR: usr)
                        }
                        if !isDeclOrDef && (ref.roles.contains(.reference) || ref.roles.contains(.call)
                            || ref.roles.contains(.read) || ref.roles.contains(.write)
                            || ref.roles.contains(.addressOf)) {
                            emitRef(ref, calleeUSR: usr)
                            refCount += 1
                        }
                        for rel in ref.relations {
                            if let kind = relationKind(rel.roles) {
                                emitRel(kind: kind, parent: rel.symbol.usr, child: usr, occurrence: ref)
                                relCount += 1
                            }
                        }
                        return true
                    }
                }
            }
        }

        emitUnitMembership(for: indexedFiles)
        emitDone(symbols: symCount, refs: refCount, rels: relCount)
        return (symCount, refCount, relCount)
    }

    // MARK: - Filters

    private func languageMatches(_ l: Language) -> Bool {
        if languageFilter.isEmpty { return true }
        return languageFilter.contains(l)
    }

    private func relationKind(_ roles: SymbolRole) -> String? {
        if roles.contains(.overrideOf) { return "override" }
        if roles.contains(.baseOf) { return "base" }
        if roles.contains(.extendedBy) { return "extended" }
        if roles.contains(.accessorOf) { return "accessor" }
        if roles.contains(.receivedBy) { return "receivedBy" }
        // An Interface Builder outlet/action declares a type — `ibType` links the
        // IB-annotated symbol to the class it's wired to. `specialization` links
        // a generic/template instantiation back to its generic declaration.
        if roles.contains(.ibTypeOf) { return "ibType" }
        if roles.contains(.specializationOf) { return "specialization" }
        // childOf / containedBy are common containment relations — we skip them
        // because tree-sitter already captures structural containment.
        return nil
    }

    /// The IndexStoreDB SymbolProperty flags CodeGraph consumes, as stable
    /// string tokens. Drives IB annotation, unit-test tagging, async marking,
    /// and generic/template-specialization handling on the Node side.
    private func symbolPropertyTokens(_ p: SymbolProperty) -> [String] {
        var tokens: [String] = []
        if p.contains(.ibAnnotated) { tokens.append("ibAnnotated") }
        if p.contains(.ibOutletCollection) { tokens.append("ibOutletCollection") }
        if p.contains(.unitTest) { tokens.append("unitTest") }
        if p.contains(.swiftAsync) { tokens.append("swiftAsync") }
        if p.contains(.generic) { tokens.append("generic") }
        if p.contains(.templateSpecialization) { tokens.append("templateSpecialization") }
        if p.contains(.templatePartialSpecialization) { tokens.append("templatePartialSpecialization") }
        if p.contains(.protocolInterface) { tokens.append("protocolInterface") }
        return tokens
    }

    // MARK: - NDJSON emission

    private func emitMeta() {
        write([
            "t": "meta",
            "sourceRoot": sourceRoot,
            "languageFilter": Array(languageFilter.map(languageName)),
            "includeSystem": includeSystem,
        ])
    }

    private func emitDone(symbols: Int, refs: Int, rels: Int) {
        write([
            "t": "done",
            "symbols": symbols,
            "refs": refs,
            "rels": rels,
        ])
    }

    private func emitCap() {
        write([
            "t": "cap",
            "semanticDeltaVersion": 1,
            "helperVersion": "codegraph-xchelper 1.1.1",
            "unitFingerprintAlgorithm": "index-unit-v1",
            "recordKinds": ["unit", "unit_file", "sym", "rel", "ref", "inc", "dcl"],
            "sourceMembership": true,
        ])
    }

    private func emitUnitMembership(for paths: Set<String>) {
        var unitFiles: [String: Set<String>] = [:]
        // Header files can be included by hundreds or thousands of translation
        // units. Reverse-querying every indexed header creates a huge
        // unit->file fan-out while adding little delta value; primary source
        // files are enough to track touched units and ownership.
        let membershipPaths = paths.filter(isPrimarySourceFile)
        for file in membershipPaths {
            db.forEachUnitNameContainingFile(path: file) { unitName in
                unitFiles[unitName, default: []].insert(file)
                return true
            }
        }

        for unitName in unitFiles.keys.sorted() {
            // Per-unit drain: fingerprinting stats every member file via
            // FileManager (one autoreleased attribute dictionary per file).
            autoreleasepool {
                let files = Array(unitFiles[unitName] ?? []).sorted()
                emitUnit(unitName: unitName, files: files)
                for file in files {
                    emitUnitFile(unitName: unitName, file: file)
                }
                emitIncludes(unitName: unitName)
            }
        }
    }

    /// Emit the `#include` / `#import` edges of a translation unit as `inc`
    /// records. Only edges whose *source* file is inside the project are
    /// emitted (the target may still be a system header — the Node side drops
    /// targets that don't resolve to a project file node). Deduped per unit.
    private func emitIncludes(unitName: String) {
        var seen = Set<String>()
        db.forEachIncludeOfUnit(unitName: unitName) { entry in
            // Both endpoints must be in-project — an `#import` of a system
            // header (Foundation, the SDK) has no project file node to link to.
            guard isInProject(entry.sourcePath), isInProject(entry.targetPath) else { return true }
            let key = "\(entry.sourcePath)\u{0}\(entry.targetPath)"
            if seen.contains(key) { return true }
            seen.insert(key)
            write([
                "t": "inc",
                "from": relativize(entry.sourcePath),
                "to": relativize(entry.targetPath),
                "line": entry.line,
            ])
            return true
        }
    }

    /// Symlink-robust "is this path inside the source root?" check. macOS keeps
    /// `/var` and `/tmp` as symlinks to `/private/var` and `/private/tmp`, and
    /// `resolvingSymlinksInPath` doesn't collapse them — so the indexer's
    /// `/private/var/...` paths wouldn't `hasPrefix` a `/var/...` root. Strip a
    /// leading `/private` from both sides before comparing.
    private func isInProject(_ path: String) -> Bool {
        func stripPrivate(_ p: String) -> String {
            return p.hasPrefix("/private/") ? String(p.dropFirst("/private".count)) : p
        }
        return stripPrivate(path).hasPrefix(stripPrivate(sourceRoot))
    }

    private func emitUnit(unitName: String, files: [String]) {
        let mainFile = files.first(where: isPrimarySourceFile) ?? files.first
        var obj: [String: Any] = [
            "t": "unit",
            "unit_id": unitName,
            "fingerprint": fingerprint(unitName: unitName, files: files),
        ]
        if let mainFile {
            obj["main_file"] = relativize(mainFile)
        }
        write(obj)
    }

    private func emitUnitFile(unitName: String, file: String) {
        write([
            "t": "unit_file",
            "unit_id": unitName,
            "file": relativize(file),
            "role": unitFileRole(file),
        ])
    }

    private func unitFileRole(_ file: String) -> String {
        if isPrimarySourceFile(file) { return "primary" }
        if file.contains("/DerivedData/") || file.contains("/Build/") { return "generated" }
        return "header"
    }

    private func isPrimarySourceFile(_ file: String) -> Bool {
        let ext = (file as NSString).pathExtension.lowercased()
        return primarySourceFileExtensions.contains(ext)
    }

    private func fingerprint(unitName: String, files: [String]) -> String {
        var parts = [unitName]
        for file in files.sorted() {
            let mtime = ((try? FileManager.default.attributesOfItem(atPath: file)[.modificationDate] as? Date) ?? nil)
                .map { String(Int64($0.timeIntervalSince1970 * 1000)) } ?? "0"
            parts.append("\(file):\(mtime)")
        }
        return String(format: "%016llx", fnv1a64(parts.joined(separator: "\u{0}")))
    }

    private func fnv1a64(_ string: String) -> UInt64 {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in string.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return hash
    }

    private func emitSym(_ occ: SymbolOccurrence) {
        let isCategory = occ.symbol.kind == .extension && occ.symbol.language == .objc
        var obj: [String: Any] = [
            "t": "sym",
            "usr": occ.symbol.usr,
            "name": occ.symbol.name,
            "kind": kindName(occ.symbol.kind),
            "lang": languageName(occ.symbol.language),
            "file": relativize(occ.location.path),
            "line": occ.location.line,
            "col": occ.location.utf8Column,
            "isDecl": occ.roles.contains(.declaration),
            "isDef": occ.roles.contains(.definition),
            "isSystem": occ.location.isSystem,
        ]
        if isCategory {
            obj["category"] = true
        }
        let props = symbolPropertyTokens(occ.symbol.properties)
        if !props.isEmpty {
            obj["props"] = props
        }
        write(obj)
    }

    private func emitRef(_ occ: SymbolOccurrence, calleeUSR: String) {
        let role: String
        // `addressOf` first: `@selector(foo)` / `#selector(foo)` / `&func`
        // reference a method or function as a callable value rather than
        // calling it directly — the target-action / function-pointer indirect
        // dispatch the merger turns into a selector edge. Checked before
        // call/read/write because a selector occurrence may also carry
        // `.reference`, and we want the more specific classification.
        if occ.roles.contains(.addressOf) { role = "selector" }
        else if occ.roles.contains(.call) { role = "call" }
        else if occ.roles.contains(.read) { role = "read" }
        else if occ.roles.contains(.write) { role = "write" }
        else { role = "reference" }

        write([
            "t": "ref",
            "to_usr": calleeUSR,
            "role": role,
            "file": relativize(occ.location.path),
            "line": occ.location.line,
            "col": occ.location.utf8Column,
            "dynamic": occ.roles.contains(.dynamic),
        ])
    }

    private func emitDecl(_ occ: SymbolOccurrence, defUSR: String) {
        write([
            "t": "dcl",
            "usr": defUSR,
            "file": relativize(occ.location.path),
            "line": occ.location.line,
            "col": occ.location.utf8Column,
        ])
    }

    private func emitRel(kind: String, parent: String, child: String, occurrence: SymbolOccurrence) {
        write([
            "t": "rel",
            "kind": kind,
            "parent": parent,
            "child": child,
            "file": relativize(occurrence.location.path),
            "line": occurrence.location.line,
            "col": occurrence.location.utf8Column,
        ])
    }

    private func relativize(_ path: String) -> String {
        if path.hasPrefix(sourceRoot) {
            var rel = String(path.dropFirst(sourceRoot.count))
            if rel.hasPrefix("/") { rel = String(rel.dropFirst()) }
            return rel
        }
        return path
    }

    private func write(_ obj: [String: Any]) {
        // JSONSerialization autoreleases a page-rounded (4 KB) NSData per call.
        // This runs once per emitted NDJSON line — millions of times on a large
        // store — and the top-level pool only drains at process exit, so without
        // a local pool the dump's footprint grows ~4 KB per line unbounded
        // (observed: 2.87 M lines → 12 GB of NSConcreteData/_NSJSONWriter).
        autoreleasepool {
            guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) else { return }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0a])) // newline
        }
    }

    // MARK: - Enum stringification

    private func kindName(_ k: IndexSymbolKind) -> String {
        switch k {
        case .unknown: return "unknown"
        case .module: return "module"
        case .namespace: return "namespace"
        case .namespaceAlias: return "namespaceAlias"
        case .macro: return "macro"
        case .enum: return "enum"
        case .struct: return "struct"
        case .class: return "class"
        case .protocol: return "protocol"
        case .extension: return "extension"
        case .union: return "union"
        case .typealias: return "typealias"
        case .function: return "function"
        case .variable: return "variable"
        case .field: return "field"
        case .enumConstant: return "enumConstant"
        case .instanceMethod: return "instanceMethod"
        case .classMethod: return "classMethod"
        case .staticMethod: return "staticMethod"
        case .instanceProperty: return "instanceProperty"
        case .classProperty: return "classProperty"
        case .staticProperty: return "staticProperty"
        case .constructor: return "constructor"
        case .destructor: return "destructor"
        case .conversionFunction: return "conversionFunction"
        case .parameter: return "parameter"
        case .using: return "using"
        case .concept: return "concept"
        case .commentTag: return "commentTag"
        }
    }

    private func languageName(_ l: Language) -> String {
        switch l {
        case .c: return "c"
        case .cxx: return "cpp"
        case .objc: return "objc"
        case .swift: return "swift"
        }
    }
}

/// Parse a CLI `--language` argument into the IndexStoreDB Language enum.
func parseLanguage(_ s: String) -> Language? {
    switch s.lowercased() {
    case "c": return .c
    case "cpp", "cxx", "c++": return .cxx
    case "objc", "objective-c", "objectivec": return .objc
    case "swift": return .swift
    default: return nil
    }
}
