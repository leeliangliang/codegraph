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
});
