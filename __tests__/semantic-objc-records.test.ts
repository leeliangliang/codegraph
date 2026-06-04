import { describe, expect, it } from 'vitest';
import {
  evaluateSemanticDeltaCapability,
  isXcRecord,
  parseNdjsonLine,
  type XcCapabilityRecord,
} from '../src/extraction/semantic-objc';

const deltaCap: XcCapabilityRecord = {
  t: 'cap',
  semanticDeltaVersion: 1,
  helperVersion: 'codegraph-xchelper 1.0.0',
  unitFingerprintAlgorithm: 'index-unit-v1',
  recordKinds: ['unit', 'unit_file', 'sym', 'rel', 'ref'],
  sourceMembership: true,
};

describe('Semantic ObjC helper records', () => {
  it('accepts legacy and delta helper record discriminators', () => {
    expect(isXcRecord({ t: 'meta', sourceRoot: '.', languageFilter: ['objc'], includeSystem: false })).toBe(true);
    expect(isXcRecord(deltaCap)).toBe(true);
    expect(isXcRecord({ t: 'unit', unit_id: 'u1', fingerprint: 'f1', mtime: 1, main_file: 'A.m' })).toBe(true);
    expect(isXcRecord({ t: 'unit_file', unit_id: 'u1', file: 'A.h', role: 'header' })).toBe(true);
    expect(isXcRecord({ t: 'sym', usr: 'u', name: 'n', kind: 'class', lang: 'objc', file: 'A.m', line: 1, col: 1, isDecl: true, isDef: true, isSystem: false })).toBe(true);
    expect(isXcRecord({ t: 'ref', to_usr: 'u', role: 'call', file: 'A.m', line: 1, col: 1, dynamic: false })).toBe(true);
    expect(isXcRecord({ t: 'rel', kind: 'override', parent: 'p', child: 'c' })).toBe(true);
    expect(isXcRecord({ t: 'done', symbols: 1, refs: 1, rels: 1 })).toBe(true);
    expect(isXcRecord({ t: 'unknown' })).toBe(false);
  });

  it('parses delta helper NDJSON records', () => {
    expect(parseNdjsonLine(JSON.stringify(deltaCap))).toEqual(deltaCap);
    expect(parseNdjsonLine(JSON.stringify({ t: 'unit', unit_id: 'u1', fingerprint: 'f1' }))).toEqual({
      t: 'unit',
      unit_id: 'u1',
      fingerprint: 'f1',
    });
    expect(parseNdjsonLine(JSON.stringify({ t: 'unit_file', unit_id: 'u1', file: 'A.m', role: 'primary' }))).toEqual({
      t: 'unit_file',
      unit_id: 'u1',
      file: 'A.m',
      role: 'primary',
    });
    expect(parseNdjsonLine('{not json')).toBeNull();
    expect(parseNdjsonLine(JSON.stringify({ t: 'nope' }))).toBeNull();
  });

  it('requires capability metadata before treating helper output as delta-safe', () => {
    expect(evaluateSemanticDeltaCapability(undefined)).toEqual({
      safe: false,
      reason: 'helper-missing-delta-capability',
    });
    expect(evaluateSemanticDeltaCapability(deltaCap)).toEqual({
      safe: true,
      version: 1,
      helperVersion: 'codegraph-xchelper 1.0.0',
      fingerprintAlgorithm: 'index-unit-v1',
    });
  });

  it('rejects incomplete or unsupported delta capability metadata', () => {
    expect(evaluateSemanticDeltaCapability({ ...deltaCap, semanticDeltaVersion: 0 })).toMatchObject({
      safe: false,
      reason: 'helper-delta-version-unsupported',
    });
    expect(evaluateSemanticDeltaCapability({ ...deltaCap, unitFingerprintAlgorithm: 'unknown' })).toMatchObject({
      safe: false,
      reason: 'helper-fingerprint-algorithm-unsupported',
    });
    expect(evaluateSemanticDeltaCapability({ ...deltaCap, sourceMembership: false })).toMatchObject({
      safe: false,
      reason: 'helper-missing-source-membership',
    });
    expect(evaluateSemanticDeltaCapability({ ...deltaCap, recordKinds: ['unit', 'sym', 'rel', 'ref'] })).toMatchObject({
      safe: false,
      reason: 'helper-missing-record-kind:unit_file',
    });
  });
});
