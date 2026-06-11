// swift-tools-version: 5.9
//
// codegraph-xchelper — Mac-native helper that reads Xcode's IndexStore
// (Index.noindex/DataStore) and emits NDJSON for the Node.js CodeGraph
// process to merge into its tree-sitter graph as a semantic enrichment.
//
// This is the Phase 2-alpha standalone prototype. It is NOT yet wired into
// the parent Node project — `swift build -c release` here produces a
// binary you can spawn manually with `--store-path` + `--source-root`.

import PackageDescription

let package = Package(
    name: "codegraph-xchelper",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "codegraph-xchelper", targets: ["CodegraphXchelper"]),
    ],
    dependencies: [
        // IndexStoreDB — Apple's Swift wrapper over libIndexStore.dylib that
        // reads the Xcode `.indexstore` format. Pinned to the swift-6.0.3-RELEASE
        // tag (matches the Swift 6.0.3 toolchain shipped with Xcode 16). Bump
        // this when the project's required Swift toolchain version changes.
        .package(url: "https://github.com/swiftlang/indexstore-db.git", revision: "swift-6.0.3-RELEASE"),
        // ArgumentParser — Apple's Swift CLI parser. 1.5.0 is broadly stable
        // across Swift 5.9 / 6.x toolchains.
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0"),
    ],
    targets: [
        .executableTarget(
            name: "CodegraphXchelper",
            dependencies: [
                .product(name: "IndexStoreDB", package: "indexstore-db"),
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
                "CodegraphXchelperSupport",
            ]
        ),
        .target(
            name: "CodegraphXchelperSupport",
            dependencies: [
                .product(name: "IndexStoreDB_CXX", package: "indexstore-db"),
            ],
            publicHeadersPath: "include"
        ),
    ]
)
