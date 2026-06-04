import { evaluateSemanticDeltaCapability, type XcCapabilityRecord, type XcUnitFileRecord, type XcUnitRecord } from './types';

export interface StoredSemanticObjcUnit {
  unitId: string;
  fingerprint: string;
  fingerprintAlgo: string;
  helperVersion: string;
  status: string;
  files: Array<{ filePath: string; role: string }>;
}

export interface SemanticObjcDeltaPlanInput {
  capability?: XcCapabilityRecord | null;
  currentUnits: XcUnitRecord[];
  currentUnitFiles: XcUnitFileRecord[];
  storedUnits: StoredSemanticObjcUnit[];
  uncertainOwnership?: boolean;
}

export interface SemanticObjcDeltaPlan {
  mode: 'delta' | 'needs-reconcile';
  reason?: string;
  changedUnitIds: string[];
  addedUnitIds: string[];
  removedUnitIds: string[];
  unchangedUnitIds: string[];
  affectedFiles: string[];
}

export function planSemanticObjcDelta(input: SemanticObjcDeltaPlanInput): SemanticObjcDeltaPlan {
  const empty = emptyPlan();
  const capability = evaluateSemanticDeltaCapability(input.capability);
  if (!capability.safe) {
    return { ...empty, mode: 'needs-reconcile', reason: capability.reason };
  }
  if (input.currentUnits.length === 0) {
    return { ...empty, mode: 'needs-reconcile', reason: 'helper-missing-units' };
  }
  if (input.currentUnitFiles.length === 0) {
    return { ...empty, mode: 'needs-reconcile', reason: 'helper-missing-unit-files' };
  }
  if (input.uncertainOwnership) {
    return { ...empty, mode: 'needs-reconcile', reason: 'semantic-ownership-uncertain' };
  }

  const currentById = new Map(input.currentUnits.map((unit) => [unit.unit_id, unit]));
  const storedById = new Map(input.storedUnits.map((unit) => [unit.unitId, unit]));
  const filesByUnit = new Map<string, Set<string>>();
  const unitsByHeader = new Map<string, Set<string>>();
  for (const unitFile of input.currentUnitFiles) {
    if (!currentById.has(unitFile.unit_id)) {
      return { ...empty, mode: 'needs-reconcile', reason: 'unit-file-without-unit' };
    }
    const files = filesByUnit.get(unitFile.unit_id) ?? new Set<string>();
    files.add(unitFile.file);
    filesByUnit.set(unitFile.unit_id, files);
    if (unitFile.role === 'header') {
      const units = unitsByHeader.get(unitFile.file) ?? new Set<string>();
      units.add(unitFile.unit_id);
      unitsByHeader.set(unitFile.file, units);
    }
  }

  for (const units of unitsByHeader.values()) {
    if (units.size > 1) {
      return { ...empty, mode: 'needs-reconcile', reason: 'shared-header-ambiguity' };
    }
  }

  for (const unit of input.currentUnits) {
    if (!filesByUnit.has(unit.unit_id)) {
      return { ...empty, mode: 'needs-reconcile', reason: 'unit-missing-source-membership' };
    }
  }

  const addedUnitIds: string[] = [];
  const changedUnitIds: string[] = [];
  const removedUnitIds: string[] = [];
  const unchangedUnitIds: string[] = [];
  const affectedFiles = new Set<string>();

  for (const unit of input.currentUnits) {
    const stored = storedById.get(unit.unit_id);
    if (!stored) {
      addedUnitIds.push(unit.unit_id);
      addUnitFiles(affectedFiles, filesByUnit.get(unit.unit_id));
      continue;
    }
    if (stored.fingerprintAlgo !== capability.fingerprintAlgorithm) {
      return { ...empty, mode: 'needs-reconcile', reason: 'stored-fingerprint-algorithm-mismatch' };
    }
    if (stored.fingerprint !== unit.fingerprint) {
      changedUnitIds.push(unit.unit_id);
      addUnitFiles(affectedFiles, filesByUnit.get(unit.unit_id));
      addStoredFiles(affectedFiles, stored.files);
    } else {
      unchangedUnitIds.push(unit.unit_id);
    }
  }

  for (const stored of input.storedUnits) {
    if (!currentById.has(stored.unitId)) {
      removedUnitIds.push(stored.unitId);
      addStoredFiles(affectedFiles, stored.files);
    }
  }

  return {
    mode: 'delta',
    changedUnitIds: changedUnitIds.sort(),
    addedUnitIds: addedUnitIds.sort(),
    removedUnitIds: removedUnitIds.sort(),
    unchangedUnitIds: unchangedUnitIds.sort(),
    affectedFiles: [...affectedFiles].sort(),
  };
}

function emptyPlan(): SemanticObjcDeltaPlan {
  return {
    mode: 'needs-reconcile',
    changedUnitIds: [],
    addedUnitIds: [],
    removedUnitIds: [],
    unchangedUnitIds: [],
    affectedFiles: [],
  };
}

function addUnitFiles(target: Set<string>, files: Set<string> | undefined): void {
  for (const file of files ?? []) target.add(file);
}

function addStoredFiles(target: Set<string>, files: Array<{ filePath: string }>): void {
  for (const file of files) target.add(file.filePath);
}
