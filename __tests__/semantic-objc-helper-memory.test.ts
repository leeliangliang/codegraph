import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const queriesPath = path.resolve(
  __dirname,
  '../src/extraction/semantic-objc/swift/Sources/CodegraphXchelper/Queries.swift'
);
const mainPath = path.resolve(
  __dirname,
  '../src/extraction/semantic-objc/swift/Sources/CodegraphXchelper/main.swift'
);
const packagePath = path.resolve(
  __dirname,
  '../src/extraction/semantic-objc/swift/Package.swift'
);
const supportPath = path.resolve(
  __dirname,
  '../src/extraction/semantic-objc/swift/Sources/CodegraphXchelperSupport/CodegraphXchelperSupport.cpp'
);

describe('codegraph-xchelper memory profile', () => {
  it('streams IndexStoreDB dump queries instead of materializing occurrence arrays', () => {
    const source = fs.readFileSync(queriesPath, 'utf8');

    expect(source).toContain('forEachCanonicalSymbolOccurrence(byName: name)');
    expect(source).toContain('forEachSymbolOccurrence(byUSR: usr, roles: .all)');
    expect(source).toContain('forEachUnitNameContainingFile(path: file)');
    expect(source).toContain('forEachIncludeOfUnit(unitName: unitName)');

    expect(source).not.toContain('canonicalOccurrences(ofName: name)');
    expect(source).not.toContain('occurrences(ofUSR: usr, roles: .all)');
    expect(source).not.toContain('unitNamesContainingFile(path: file)');
    expect(source).not.toContain('includesOfUnit(unitName: unitName)');
  });

  it('initializes IndexStoreDB with explicit output units when project object files are available', () => {
    const source = fs.readFileSync(mainPath, 'utf8');

    expect(source).toContain('collectExplicitOutputUnitPaths');
    expect(source).toContain('useExplicitOutputUnits: !explicitOutputUnitPaths.isEmpty');
    expect(source).toContain('waitUntilDoneInitializing: explicitOutputUnitPaths.isEmpty');
    expect(source).toContain('db.addUnitOutFilePaths(explicitOutputUnitPaths, waitForProcessing: true)');
  });

  it('collects explicit output unit paths from IndexStore unit metadata', () => {
    const mainSource = fs.readFileSync(mainPath, 'utf8');
    const packageSource = fs.readFileSync(packagePath, 'utf8');

    expect(mainSource).toContain('import CodegraphXchelperSupport');
    expect(mainSource).toContain('codegraph_xc_collect_unit_output_paths');
    expect(mainSource).toContain('languages: langs');
    expect(packageSource).toContain('name: "CodegraphXchelperSupport"');
    expect(packageSource).toContain('"CodegraphXchelperSupport"');
  });

  it('limits explicit unit collection to source extensions for the requested languages', () => {
    const source = fs.readFileSync(mainPath, 'utf8');

    expect(source).toContain('sourceExtensions(for languages: Set<Language>)');
    expect(source).toContain('if languages.isEmpty');
    expect(source).toContain('extensions.insert("m")');
    expect(source).toContain('extensions.insert("mm")');
    expect(source).not.toContain('let sourceExts: Set<String> = ["m", "mm", "c", "cc", "cpp", "cxx", "swift"]');
  });

  it('does not fan out unit membership through headers included by many translation units', () => {
    const source = fs.readFileSync(queriesPath, 'utf8');

    expect(source).toContain('let membershipPaths = paths.filter(isPrimarySourceFile)');
    expect(source).toContain('for file in membershipPaths');
    expect(source).not.toContain('for file in paths {\n            db.forEachUnitNameContainingFile(path: file)');
  });

  it('matches project-root paths on directory boundaries only', () => {
    const source = fs.readFileSync(supportPath, 'utf8');

    expect(source).not.toContain('return p.rfind(root, 0) == 0;');
    expect(source).toContain('p == root');
    expect(source).toContain("p[root.size()] == '/'");
  });

  it('falls back to full IndexStoreDB import when explicit output unit collection fails', () => {
    const source = fs.readFileSync(mainPath, 'utf8');

    expect(source).toContain('catch');
    expect(source).toContain('falling back to full import');
    expect(source).toContain('explicitOutputUnitPaths = []');
    expect(source).not.toContain('let explicitOutputUnitPaths = try collectExplicitOutputUnitPaths');
  });
});
