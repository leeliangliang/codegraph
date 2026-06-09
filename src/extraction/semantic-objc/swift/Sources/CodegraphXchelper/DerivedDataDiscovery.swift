// DerivedDataDiscovery — Locate the `.indexstore` Xcode produced for a given project.
//
// Strategy (mirrors drewalth/claude-xcindex):
//   1. Honour an explicit `--store-path` from the caller (handled in main.swift).
//   2. Read Xcode's `IDECustomDerivedDataLocation` default for a user-overridden root.
//   3. Scan the standard `~/Library/Developer/Xcode/DerivedData/` directory and
//      pick the entry whose `info.plist : WorkspacePath` matches the requested
//      source root. If multiple entries match (re-clones, rebuilds), pick the
//      one with the most-recent mtime.
//
// We do not parse `.xcodeproj` or `.xcworkspace`; the `info.plist` next to each
// DerivedData entry is enough.

import Foundation

struct DerivedDataDiscovery {
    enum DiscoveryError: Error, CustomStringConvertible {
        case noStoreFound(searchedRoots: [URL])
        case sourceRootMissing(URL)

        var description: String {
            switch self {
            case .noStoreFound(let roots):
                return "No matching Index.noindex/DataStore found under any of: \(roots.map(\.path).joined(separator: ", "))"
            case .sourceRootMissing(let url):
                return "Source root does not exist: \(url.path)"
            }
        }
    }

    /// Locate a `.indexstore` for the project rooted at `sourceRoot`.
    /// Returns the absolute filesystem path to the `Index.noindex/DataStore` directory.
    static func locateStore(for sourceRoot: URL) throws -> URL {
        guard FileManager.default.fileExists(atPath: sourceRoot.path) else {
            throw DiscoveryError.sourceRootMissing(sourceRoot)
        }

        // Non-Xcode stores first: a CMake / plain-clang build pointed at
        // `-index-store-path`, or a SwiftPM build. These live inside the project
        // tree — cheaper to find and more specific than scanning all of
        // DerivedData, and they cover the Xcode-free toolchains.
        if let inProject = locateInProjectStore(sourceRoot: sourceRoot) {
            return inProject
        }

        let candidates = derivedDataRoots()
        for root in candidates {
            if let match = try findMatchingStore(under: root, sourceRoot: sourceRoot) {
                return match
            }
        }
        throw DiscoveryError.noStoreFound(searchedRoots: candidates)
    }

    /// Conventional in-project IndexStore locations for non-Xcode builds:
    ///   - `<root>/.indexstore` and `<root>/Index.noindex/DataStore`
    ///     (CMake / plain `clang -index-store-path=...`).
    ///   - `<root>/.build/{debug,release}/index/store` and
    ///     `<root>/.build/index-build/index/store` (SwiftPM / SourceKit-LSP).
    /// Returns the first that looks like a real index store (has a `vN/units`).
    static func locateInProjectStore(sourceRoot: URL) -> URL? {
        let candidates = [
            ".indexstore",
            "Index.noindex/DataStore",
            ".build/debug/index/store",
            ".build/release/index/store",
            ".build/index-build/index/store",
        ].map { sourceRoot.appendingPathComponent($0) }
        return candidates.first(where: isIndexStore)
    }

    /// A clang/swift IndexStore is a directory with a versioned `vN/units`
    /// subdirectory (e.g. `v5/units`).
    static func isIndexStore(_ url: URL) -> Bool {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else { return false }
        guard let entries = try? fm.contentsOfDirectory(atPath: url.path) else { return false }
        for entry in entries where entry.hasPrefix("v") {
            if fm.fileExists(atPath: url.appendingPathComponent("\(entry)/units").path) {
                return true
            }
        }
        return false
    }

    /// Roots that may contain DerivedData entries. The custom path (if set in Xcode prefs)
    /// is searched first, then the default `~/Library/Developer/Xcode/DerivedData/`.
    static func derivedDataRoots() -> [URL] {
        var roots: [URL] = []
        if let custom = readCustomDerivedDataLocation() {
            roots.append(custom)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        roots.append(home.appendingPathComponent("Library/Developer/Xcode/DerivedData"))
        return roots
    }

    /// Read `IDECustomDerivedDataLocation` from Xcode prefs via `defaults`. Returns nil if unset.
    private static func readCustomDerivedDataLocation() -> URL? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/defaults")
        p.arguments = ["read", "com.apple.dt.Xcode", "IDECustomDerivedDataLocation"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do {
            try p.run()
            p.waitUntilExit()
            guard p.terminationStatus == 0 else { return nil }
            let data = out.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return path.isEmpty ? nil : URL(fileURLWithPath: path)
        } catch {
            return nil
        }
    }

    /// Scan `root` for entries whose `info.plist : WorkspacePath` resolves to `sourceRoot`.
    /// Among matches, return the one with the most recent mtime.
    private static func findMatchingStore(under root: URL, sourceRoot: URL) throws -> URL? {
        let fm = FileManager.default
        guard fm.fileExists(atPath: root.path) else { return nil }

        let entries: [URL]
        do {
            entries = try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles])
        } catch {
            return nil
        }

        let target = sourceRoot.resolvingSymlinksInPath().standardized.path

        var best: (URL, Int, Date)? = nil
        for entry in entries {
            // Skip non-project entries (caches, etc.).
            if entry.lastPathComponent.hasPrefix("ModuleCache") || entry.lastPathComponent.hasPrefix("SDKStat") || entry.lastPathComponent.hasPrefix("Symbol") {
                continue
            }
            let infoPlist = entry.appendingPathComponent("info.plist")
            guard fm.fileExists(atPath: infoPlist.path) else { continue }

            guard let workspacePath = readWorkspacePath(from: infoPlist) else { continue }
            let workspaceURL = URL(fileURLWithPath: workspacePath).resolvingSymlinksInPath().standardized
            guard let score = matchScore(workspacePath: workspaceURL.path, sourceRoot: target) else { continue }

            let store = entry.appendingPathComponent("Index.noindex/DataStore")
            guard fm.fileExists(atPath: store.path) else { continue }

            let mtime = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date.distantPast
            if best == nil || score > best!.1 || (score == best!.1 && mtime > best!.2) {
                best = (store, score, mtime)
            }
        }
        return best?.0
    }

    private static func matchScore(workspacePath: String, sourceRoot: String) -> Int? {
        if workspacePath == sourceRoot { return 3 }
        if workspacePath.hasPrefix(sourceRoot + "/") { return 2 }

        let workspaceParent = URL(fileURLWithPath: workspacePath).deletingLastPathComponent().path
        if sourceRoot == workspaceParent || sourceRoot.hasPrefix(workspaceParent + "/") { return 1 }
        return nil
    }

    private static func readWorkspacePath(from plist: URL) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/libexec/PlistBuddy")
        p.arguments = ["-c", "Print :WorkspacePath", plist.path]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do {
            try p.run()
            p.waitUntilExit()
            guard p.terminationStatus == 0 else { return nil }
            let data = out.fileHandleForReading.readDataToEndOfFile()
            let raw = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? nil : raw
        } catch {
            return nil
        }
    }
}
