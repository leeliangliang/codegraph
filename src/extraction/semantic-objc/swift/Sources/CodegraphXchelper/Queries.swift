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

struct Queries {
    let db: IndexStoreDB
    let sourceRoot: String
    let languageFilter: Set<Language> // empty = all
    let includeSystem: Bool

    /// Emit the full store as NDJSON on stdout. Returns (symbols, refs, rels) counts.
    ///
    /// Two-phase to avoid LMDB `MDB_BAD_RSLOT` from nested read transactions:
    ///   Phase 1 — collect every symbol name into an array. The `forEachSymbolName`
    ///             callback does nothing but append; no nested DB calls.
    ///   Phase 2 — outside any callback, walk the array and run the heavy queries.
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
            let canonicals = db.canonicalOccurrences(ofName: name)
            for occ in canonicals {
                if !languageMatches(occ.symbol.language) { continue }
                if !includeSystem && occ.location.isSystem { continue }

                let usr = occ.symbol.usr
                if seenUSRs.contains(usr) { continue }
                seenUSRs.insert(usr)

                indexedFiles.insert(occ.location.path)
                emitSym(occ)
                symCount += 1

                // Collect refs + rels for this USR via `occurrences(ofUSR:roles:)`,
                // which returns an array — no nested callback, LMDB-safe.
                let refs = db.occurrences(ofUSR: usr, roles: .all)
                for ref in refs {
                    if !includeSystem && ref.location.isSystem { continue }
                    indexedFiles.insert(ref.location.path)
                    let isDeclOrDef = ref.roles.contains(.declaration) || ref.roles.contains(.definition)
                    if !isDeclOrDef && (ref.roles.contains(.reference) || ref.roles.contains(.call)
                        || ref.roles.contains(.read) || ref.roles.contains(.write)) {
                        emitRef(ref, calleeUSR: usr)
                        refCount += 1
                    }
                    for rel in ref.relations {
                        if let kind = relationKind(rel.roles) {
                            emitRel(kind: kind, parent: rel.symbol.usr, child: usr)
                            relCount += 1
                        }
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
        // childOf / containedBy are common containment relations — we skip them
        // because tree-sitter already captures structural containment.
        return nil
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
            "helperVersion": "codegraph-xchelper 1.0.0",
            "unitFingerprintAlgorithm": "index-unit-v1",
            "recordKinds": ["unit", "unit_file", "sym", "rel", "ref"],
            "sourceMembership": true,
        ])
    }

    private func emitUnitMembership(for paths: Set<String>) {
        var unitFiles: [String: Set<String>] = [:]
        for file in paths {
            for unitName in db.unitNamesContainingFile(path: file) {
                unitFiles[unitName, default: []].insert(file)
            }
        }

        for unitName in unitFiles.keys.sorted() {
            let files = Array(unitFiles[unitName] ?? []).sorted()
            emitUnit(unitName: unitName, files: files)
            for file in files {
                emitUnitFile(unitName: unitName, file: file)
            }
        }
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
        let lower = file.lowercased()
        return lower.hasSuffix(".m") || lower.hasSuffix(".mm") || lower.hasSuffix(".swift")
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
        write(obj)
    }

    private func emitRef(_ occ: SymbolOccurrence, calleeUSR: String) {
        let role: String
        if occ.roles.contains(.call) { role = "call" }
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

    private func emitRel(kind: String, parent: String, child: String) {
        write([
            "t": "rel",
            "kind": kind,
            "parent": parent,
            "child": child,
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
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a])) // newline
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
