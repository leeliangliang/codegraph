# @colbymchenry/codegraph-mac-objc-enricher

Prebuilt macOS universal binary (`codegraph-xchelper`) that powers
`codegraph enrich-objc` in the main [`@colbymchenry/codegraph`][cg] package.

This package is **not** used directly. It is an `optionalDependency` of the
main `@colbymchenry/codegraph` install — npm pulls it automatically on
darwin/arm64 + darwin/x64 and skips it on every other platform.

The binary links Apple's [`swiftlang/indexstore-db`][isdb] and reads Xcode's
`Index.noindex/DataStore` to surface semantic information (USRs, override
edges, protocol conformance) that the cross-platform tree-sitter pass cannot
produce on its own.

Source for the Swift project lives at
`src/extraction/semantic-objc/swift/` in the main repo. The binary in this
package is built by `.github/workflows/build-mac-objc-helper.yml` from that
source — both architectures (`arm64`, `x86_64`) are merged via `lipo` into a
single universal binary before publish.

[cg]: https://www.npmjs.com/package/@colbymchenry/codegraph
[isdb]: https://github.com/swiftlang/indexstore-db
