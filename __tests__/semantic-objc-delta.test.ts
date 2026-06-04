import { describe, expect, it } from 'vitest';
import {
  planSemanticObjcDelta,
  type StoredSemanticObjcUnit,
  type XcCapabilityRecord,
  type XcUnitFileRecord,
  type XcUnitRecord,
} from '../src/extraction/semantic-objc';

const capability: XcCapabilityRecord = {
  t: 'cap',
  semanticDeltaVersion: 1,
  helperVersion: 'codegraph-xchelper 1.0.0',
  unitFingerprintAlgorithm: 'index-unit-v1',
  recordKinds: ['unit', 'unit_file', 'sym', 'rel', 'ref'],
  sourceMembership: true,
};

function storedUnit(unitId: string, fingerprint: string, files: string[]): StoredSemanticObjcUnit {
  return {
    unitId,
    fingerprint,
    fingerprintAlgo: 'index-unit-v1',
    helperVersion: 'codegraph-xchelper 1.0.0',
    status: 'fresh',
    files: files.map((filePath) => ({ filePath, role: 'primary' })),
  };
}

function unit(unitId: string, fingerprint: string): XcUnitRecord {
  return { t: 'unit', unit_id: unitId, fingerprint };
}

function unitFile(unitId: string, file: string, role: XcUnitFileRecord['role'] = 'primary'): XcUnitFileRecord {
  return { t: 'unit_file', unit_id: unitId, file, role };
}

describe('Semantic ObjC delta planner', () => {
  it('classifies added, changed, removed, and unchanged units', () => {
    const plan = planSemanticObjcDelta({
      capability,
      storedUnits: [
        storedUnit('unchanged', 'same', ['A.m']),
        storedUnit('changed', 'old', ['B.m', 'B.h']),
        storedUnit('removed', 'gone', ['C.m']),
      ],
      currentUnits: [
        unit('unchanged', 'same'),
        unit('changed', 'new'),
        unit('added', 'fresh'),
      ],
      currentUnitFiles: [
        unitFile('unchanged', 'A.m'),
        unitFile('changed', 'B.m'),
        unitFile('changed', 'B.h', 'header'),
        unitFile('added', 'D.m'),
      ],
    });

    expect(plan).toEqual({
      mode: 'delta',
      changedUnitIds: ['changed'],
      addedUnitIds: ['added'],
      removedUnitIds: ['removed'],
      unchangedUnitIds: ['unchanged'],
      affectedFiles: ['B.h', 'B.m', 'C.m', 'D.m'],
    });
  });

  it('allows a no-op delta when every unit is unchanged and scoped', () => {
    const plan = planSemanticObjcDelta({
      capability,
      storedUnits: [storedUnit('unit-1', 'same', ['A.m'])],
      currentUnits: [unit('unit-1', 'same')],
      currentUnitFiles: [unitFile('unit-1', 'A.m')],
    });

    expect(plan.mode).toBe('delta');
    expect(plan.affectedFiles).toEqual([]);
    expect(plan.unchangedUnitIds).toEqual(['unit-1']);
  });

  it('falls back when helper capability is missing or unsupported', () => {
    expect(planSemanticObjcDelta({ capability: undefined, storedUnits: [], currentUnits: [], currentUnitFiles: [] })).toMatchObject({
      mode: 'needs-reconcile',
      reason: 'helper-missing-delta-capability',
    });
    expect(planSemanticObjcDelta({
      capability: { ...capability, recordKinds: ['unit', 'sym', 'rel', 'ref'] },
      storedUnits: [],
      currentUnits: [unit('u', 'f')],
      currentUnitFiles: [unitFile('u', 'A.m')],
    })).toMatchObject({
      mode: 'needs-reconcile',
      reason: 'helper-missing-record-kind:unit_file',
    });
  });

  it('falls back when source membership or ownership scope is uncertain', () => {
    expect(planSemanticObjcDelta({
      capability,
      storedUnits: [],
      currentUnits: [unit('u', 'f')],
      currentUnitFiles: [],
    })).toMatchObject({ mode: 'needs-reconcile', reason: 'helper-missing-unit-files' });

    expect(planSemanticObjcDelta({
      capability,
      storedUnits: [],
      currentUnits: [unit('u', 'f')],
      currentUnitFiles: [unitFile('other', 'A.m')],
    })).toMatchObject({ mode: 'needs-reconcile', reason: 'unit-file-without-unit' });

    expect(planSemanticObjcDelta({
      capability,
      storedUnits: [],
      currentUnits: [unit('u', 'f')],
      currentUnitFiles: [unitFile('u', 'A.m')],
      uncertainOwnership: true,
    })).toMatchObject({ mode: 'needs-reconcile', reason: 'semantic-ownership-uncertain' });

    expect(planSemanticObjcDelta({
      capability,
      storedUnits: [],
      currentUnits: [unit('u1', 'f1'), unit('u2', 'f2')],
      currentUnitFiles: [
        unitFile('u1', 'A.m'),
        unitFile('u1', 'Shared.h', 'header'),
        unitFile('u2', 'B.m'),
        unitFile('u2', 'Shared.h', 'header'),
      ],
    })).toMatchObject({ mode: 'needs-reconcile', reason: 'shared-header-ambiguity' });
  });

  it('falls back when stored fingerprints use a different algorithm', () => {
    expect(planSemanticObjcDelta({
      capability,
      storedUnits: [{ ...storedUnit('u', 'old', ['A.m']), fingerprintAlgo: 'old-algo' }],
      currentUnits: [unit('u', 'new')],
      currentUnitFiles: [unitFile('u', 'A.m')],
    })).toMatchObject({
      mode: 'needs-reconcile',
      reason: 'stored-fingerprint-algorithm-mismatch',
    });
  });
});
