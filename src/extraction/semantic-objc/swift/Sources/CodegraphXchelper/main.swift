// main.swift — codegraph-xchelper CLI entry.
//
// Subcommands:
//   discover      Find the Index.noindex/DataStore for a given source root.
//   dump          Emit the full IndexStoreDB content as NDJSON on stdout.
//   status        Print store path + mtime + a small probe of contents.
//
// All subcommands fail with a non-zero exit code and a human-readable error on stderr
// if the store is missing or the IndexStore library cannot be loaded. The Node side
// uses this exit-code as the signal to fall back to tree-sitter-only mode.

import ArgumentParser
import Foundation
import IndexStoreDB

// MARK: - libIndexStore.dylib discovery

enum LibraryDiscovery {
    /// Locate `libIndexStore.dylib` by querying `xcrun -f swift` and walking up to the lib dir.
    static func locateLibrary() throws -> URL {
        // `xcrun -f swift` returns something like /Applications/Xcode.app/.../usr/bin/swift
        // — go up two directories to `usr/`, then into `lib/libIndexStore.dylib`.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        p.arguments = ["-f", "swift"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            throw RuntimeError("Failed to invoke xcrun to discover Swift toolchain")
        }
        let raw = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let swiftPath = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !swiftPath.isEmpty else {
            throw RuntimeError("xcrun returned empty path for swift")
        }
        // .../usr/bin/swift → .../usr/lib/libIndexStore.dylib
        let usrLib = URL(fileURLWithPath: swiftPath)
            .deletingLastPathComponent()  // bin
            .deletingLastPathComponent()  // usr
            .appendingPathComponent("lib")
        let candidates = [
            usrLib.appendingPathComponent("libIndexStore.dylib"),
            // Some Xcode layouts put it under the Swift toolchain instead:
            URL(fileURLWithPath: "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/libIndexStore.dylib"),
        ]
        for cand in candidates {
            if FileManager.default.fileExists(atPath: cand.path) {
                return cand
            }
        }
        throw RuntimeError("libIndexStore.dylib not found. Tried: \(candidates.map(\.path).joined(separator: ", "))")
    }
}

struct RuntimeError: LocalizedError {
    let message: String
    init(_ m: String) { self.message = m }
    var errorDescription: String? { message }
}

// MARK: - Explicit unit discovery

/// Return IndexStore output paths for source files under `sourceRoot`.
///
/// IndexStoreDB normally imports every unit in the DataStore before queries can
/// run. Large DerivedData stores may include old targets, dependencies, and
/// generated units unrelated to the current project root; importing all of them
/// expands the transient LMDB map dramatically. `useExplicitOutputUnits` lets us
/// enqueue only the units whose compiler output paths correspond to source files
/// in this project.
func collectExplicitOutputUnitPaths(storeURL: URL, sourceRoot: URL) -> [String] {
    let fm = FileManager.default
    let sourceRootURL = sourceRoot.resolvingSymlinksInPath().standardizedFileURL
    let desiredOutputNames = collectProjectOutputNames(sourceRootURL: sourceRootURL)
    if desiredOutputNames.isEmpty { return [] }

    var scanRoots: [URL] = []
    if let derivedRoot = derivedDataRoot(forStoreURL: storeURL) {
        scanRoots.append(derivedRoot.appendingPathComponent("Build", isDirectory: true))
    }
    // Non-Xcode tests and clang/CMake builds often place object files next to
    // the sources or under an in-project build directory.
    scanRoots.append(sourceRootURL)

    var seen = Set<String>()
    var out: [String] = []
    for root in scanRoots {
        guard fm.fileExists(atPath: root.path) else { continue }
        guard let enumerator = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { continue }

        for case let url as URL in enumerator {
            guard desiredOutputNames.contains(url.lastPathComponent) else { continue }
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            let path = url.resolvingSymlinksInPath().standardized.path
            if seen.insert(path).inserted {
                out.append(path)
            }
        }
    }
    return out.sorted()
}

private func collectProjectOutputNames(sourceRootURL: URL) -> Set<String> {
    let fm = FileManager.default
    let sourceExts: Set<String> = ["m", "mm", "c", "cc", "cpp", "cxx", "swift"]
    var names = Set<String>()

    guard let enumerator = fm.enumerator(
        at: sourceRootURL,
        includingPropertiesForKeys: [.isRegularFileKey],
        options: [.skipsHiddenFiles, .skipsPackageDescendants]
    ) else { return names }

    for case let url as URL in enumerator {
        let ext = url.pathExtension.lowercased()
        guard sourceExts.contains(ext) else { continue }
        guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
        let base = url.deletingPathExtension().lastPathComponent
        names.insert("\(base).o")
        names.insert("\(url.lastPathComponent).o")
    }
    return names
}

private func derivedDataRoot(forStoreURL storeURL: URL) -> URL? {
    let standardized = storeURL.standardizedFileURL
    guard standardized.lastPathComponent == "DataStore",
          standardized.deletingLastPathComponent().lastPathComponent == "Index.noindex" else {
        return nil
    }
    return standardized.deletingLastPathComponent().deletingLastPathComponent()
}

// MARK: - Root command

struct Xchelper: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "codegraph-xchelper",
        abstract: "Emit Xcode IndexStore data as NDJSON for CodeGraph semantic enrichment.",
        subcommands: [Discover.self, Dump.self, Status.self]
    )
}

// `main.swift` is Swift's implicit entry point, so we cannot use `@main`.
// Drive the command tree from the file's top-level scope instead.
Xchelper.main()

// MARK: - discover

struct Discover: ParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Find the Index.noindex/DataStore for a source root."
    )

    @Option(name: .long, help: "Project source root (a directory containing the .xcodeproj/.xcworkspace, or its parent).")
    var sourceRoot: String

    func run() throws {
        let store = try DerivedDataDiscovery.locateStore(for: URL(fileURLWithPath: sourceRoot))
        FileHandle.standardOutput.write((store.path + "\n").data(using: .utf8)!)
    }
}

// MARK: - dump

struct Dump: ParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Emit the full IndexStore content as NDJSON on stdout."
    )

    @Option(name: .long, help: "Path to Index.noindex/DataStore. If omitted, will run discovery from --source-root.")
    var storePath: String?

    @Option(name: .long, help: "Project source root (used to make file paths relative).")
    var sourceRoot: String

    @Option(name: .long, parsing: .upToNextOption, help: "Languages to include (objc, swift, c, cpp). Empty = all.")
    var language: [String] = []

    @Flag(name: .long, help: "Include occurrences in SDK / system headers (default: filtered out).")
    var includeSystem: Bool = false

    func run() throws {
        let storeURL: URL
        if let p = storePath {
            storeURL = URL(fileURLWithPath: p)
        } else {
            storeURL = try DerivedDataDiscovery.locateStore(for: URL(fileURLWithPath: sourceRoot))
        }
        let libURL = try LibraryDiscovery.locateLibrary()

        let lib = try IndexStoreLibrary(dylibPath: libURL.path)
        let tmpDB = NSTemporaryDirectory() + "codegraph-xchelper-db-\(UUID().uuidString)"
        // LMDB needs the directory to already exist (especially with readonly:true).
        // We create it explicitly so the database path is unambiguous regardless of flags.
        try FileManager.default.createDirectory(atPath: tmpDB, withIntermediateDirectories: true)
        let explicitOutputUnitPaths = collectExplicitOutputUnitPaths(
            storeURL: storeURL,
            sourceRoot: URL(fileURLWithPath: sourceRoot)
        )
        let db = try IndexStoreDB(
            storePath: storeURL.path,
            databasePath: tmpDB,
            library: lib,
            useExplicitOutputUnits: !explicitOutputUnitPaths.isEmpty,
            waitUntilDoneInitializing: explicitOutputUnitPaths.isEmpty,
            listenToUnitEvents: false
        )
        if !explicitOutputUnitPaths.isEmpty {
            db.addUnitOutFilePaths(explicitOutputUnitPaths, waitForProcessing: true)
        }

        // Parse --language args into the IndexStoreDB Language enum.
        var langs: Set<Language> = []
        for raw in language {
            guard let l = parseLanguage(raw) else {
                throw RuntimeError("Unknown language: \(raw). Allowed: objc, swift, c, cpp")
            }
            langs.insert(l)
        }

        let q = Queries(
            db: db,
            sourceRoot: URL(fileURLWithPath: sourceRoot).resolvingSymlinksInPath().standardized.path,
            languageFilter: langs,
            includeSystem: includeSystem
        )
        _ = try q.dumpAll()
    }
}

// MARK: - status

struct Status: ParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Print store path, mtime, and a small probe of contents."
    )

    @Option(name: .long) var sourceRoot: String
    @Option(name: .long) var storePath: String?

    func run() throws {
        let storeURL: URL
        if let p = storePath {
            storeURL = URL(fileURLWithPath: p)
        } else {
            storeURL = try DerivedDataDiscovery.locateStore(for: URL(fileURLWithPath: sourceRoot))
        }
        let attrs = try FileManager.default.attributesOfItem(atPath: storeURL.path)
        let mtime = (attrs[.modificationDate] as? Date) ?? .distantPast

        // Quick probe: count `v5/units` and `v5/records` entries.
        var unitCount = 0
        var recordCount = 0
        let v5 = storeURL.appendingPathComponent("v5")
        if let units = try? FileManager.default.contentsOfDirectory(atPath: v5.appendingPathComponent("units").path) {
            unitCount = units.count
        }
        if let records = try? FileManager.default.contentsOfDirectory(atPath: v5.appendingPathComponent("records").path) {
            recordCount = records.count
        }

        let json: [String: Any] = [
            "storePath": storeURL.path,
            "mtime": ISO8601DateFormatter().string(from: mtime),
            "unitCount": unitCount,
            "recordCount": recordCount,
        ]
        let data = try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .withoutEscapingSlashes])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
}
