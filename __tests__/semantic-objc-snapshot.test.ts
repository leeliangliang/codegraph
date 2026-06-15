import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  compareSemanticObjcSnapshots,
  evaluateSemanticObjcSnapshotReadiness,
  normalizeSemanticObjcSnapshot,
  parseSemanticObjcSnapshotLine,
  semanticObjcSnapshotStability,
  spawnSemanticObjcSnapshot,
  waitForSemanticObjcSnapshotStability,
  type SemanticObjcSnapshotRecord,
} from '../src/extraction/semantic-objc';

const baseSnapshot: SemanticObjcSnapshotRecord = {
  t: 'snapshot',
  helperVersion: 'codegraph-xchelper 1.1.1',
  semanticDeltaVersion: 1,
  unitFingerprintAlgorithm: 'index-unit-v1',
  recordKinds: ['ref', 'unit_file', 'sym', 'unit', 'rel'],
  sourceMembership: true,
  languageFilter: ['swift', 'objc'],
  includeSystem: false,
  explicitOutputUnits: true,
  unitCount: 2,
  unitFileCount: 3,
  sourceMembershipCount: 2,
  aggregateFingerprint: 'abc123',
};

describe('Semantic ObjC semantic snapshot protocol', () => {
  it('parses and normalizes a helper snapshot deterministically', () => {
    const parsed = parseSemanticObjcSnapshotLine(JSON.stringify(baseSnapshot));

    expect(parsed).toEqual(baseSnapshot);
    expect(normalizeSemanticObjcSnapshot(parsed!)).toMatchObject({
      helperVersion: 'codegraph-xchelper 1.1.1',
      semanticDeltaVersion: 1,
      unitFingerprintAlgorithm: 'index-unit-v1',
      recordKinds: ['ref', 'rel', 'sym', 'unit', 'unit_file'],
      languageFilter: ['objc', 'swift'],
      aggregateFingerprint: 'abc123',
    });
  });

  it('compares snapshots ordering-insensitively but content-sensitively', () => {
    expect(compareSemanticObjcSnapshots(
      baseSnapshot,
      { ...baseSnapshot, recordKinds: [...baseSnapshot.recordKinds].reverse(), languageFilter: ['objc', 'swift'] }
    )).toBe(true);

    expect(compareSemanticObjcSnapshots(
      baseSnapshot,
      { ...baseSnapshot, aggregateFingerprint: 'changed' }
    )).toBe(false);
    expect(compareSemanticObjcSnapshots(
      baseSnapshot,
      { ...baseSnapshot, unitFileCount: baseSnapshot.unitFileCount + 1 }
    )).toBe(false);
  });

  it('rejects malformed snapshot output', () => {
    expect(parseSemanticObjcSnapshotLine('{not json')).toBeNull();
    expect(parseSemanticObjcSnapshotLine(JSON.stringify({ t: 'snapshot', unitCount: 1 }))).toBeNull();
    expect(parseSemanticObjcSnapshotLine(JSON.stringify({ ...baseSnapshot, t: 'unit' }))).toBeNull();
  });

  it('marks incomplete or delta-unsafe snapshots as not ready', () => {
    expect(evaluateSemanticObjcSnapshotReadiness(baseSnapshot)).toEqual({ ready: true });
    expect(evaluateSemanticObjcSnapshotReadiness({ ...baseSnapshot, sourceMembership: false })).toEqual({
      ready: false,
      reason: 'helper-missing-source-membership',
    });
    expect(evaluateSemanticObjcSnapshotReadiness({ ...baseSnapshot, unitCount: 0 })).toEqual({
      ready: false,
      reason: 'snapshot-missing-units',
    });
    expect(evaluateSemanticObjcSnapshotReadiness({ ...baseSnapshot, sourceMembershipCount: 1 })).toEqual({
      ready: false,
      reason: 'snapshot-missing-source-membership',
    });
  });

  it('calculates stable threshold from trailing normalized snapshots', () => {
    const changed = { ...baseSnapshot, aggregateFingerprint: 'changed' };

    expect(semanticObjcSnapshotStability([], 2)).toEqual({ stable: false, count: 0 });
    expect(semanticObjcSnapshotStability([baseSnapshot], 2)).toEqual({ stable: false, count: 1 });
    expect(semanticObjcSnapshotStability([changed, baseSnapshot, { ...baseSnapshot }], 2)).toEqual({
      stable: true,
      count: 2,
      snapshot: normalizeSemanticObjcSnapshot(baseSnapshot),
    });
    expect(semanticObjcSnapshotStability([baseSnapshot, changed], 2)).toEqual({
      stable: false,
      count: 1,
      snapshot: normalizeSemanticObjcSnapshot(changed),
    });
  });

  it('retries transient not-ready snapshots until they become stable', async () => {
    vi.useFakeTimers();
    const samples = [
      { ...baseSnapshot, unitCount: 0, unitFileCount: 0, sourceMembershipCount: 0, aggregateFingerprint: 'empty-1' },
      { ...baseSnapshot, unitFileCount: 0, aggregateFingerprint: 'empty-2' },
      { ...baseSnapshot, sourceMembershipCount: 1, aggregateFingerprint: 'partial-1' },
      { ...baseSnapshot, aggregateFingerprint: 'stable' },
      { ...baseSnapshot, aggregateFingerprint: 'stable' },
    ];

    try {
      const outcomePromise = waitForSemanticObjcSnapshotStability({
        sample: async () => samples.shift()!,
        sampleIntervalMs: 5,
        stableSamples: 2,
        maxWaitMs: 50,
      });
      await vi.runAllTimersAsync();
      await expect(outcomePromise).resolves.toMatchObject({
        status: 'stable',
        samples: 5,
        snapshot: normalizeSemanticObjcSnapshot({ ...baseSnapshot, aggregateFingerprint: 'stable' }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out if transient not-ready snapshots never recover', async () => {
    vi.useFakeTimers();

    try {
      const outcomePromise = waitForSemanticObjcSnapshotStability({
        sample: async () => ({
          ...baseSnapshot,
          unitCount: 0,
          unitFileCount: 0,
          sourceMembershipCount: 0,
          aggregateFingerprint: String(Date.now()),
        }),
        sampleIntervalMs: 5,
        stableSamples: 2,
        maxWaitMs: 20,
      });
      await vi.runAllTimersAsync();
      await expect(outcomePromise).resolves.toMatchObject({
        status: 'timeout',
        reason: 'semantic-snapshot-timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not abort a slow helper snapshot just because the stability window elapsed', async () => {
    vi.useFakeTimers();
    let sampleSawAbort = false;

    try {
      const outcomePromise = waitForSemanticObjcSnapshotStability({
        sample: async (signal?: AbortSignal) => new Promise<SemanticObjcSnapshotRecord>((resolve, reject) => {
          signal?.addEventListener('abort', () => {
            sampleSawAbort = true;
            reject(new Error('sample aborted'));
          }, { once: true });
          setTimeout(() => resolve({ ...baseSnapshot }), 50);
        }),
        sampleIntervalMs: 5,
        stableSamples: 1,
        maxWaitMs: 10,
      });

      await vi.advanceTimersByTimeAsync(60);
      await expect(outcomePromise).resolves.toMatchObject({
        status: 'stable',
        samples: 1,
      });
      expect(sampleSawAbort).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still returns unsafe-capability immediately for non-transient readiness failures', async () => {
    await expect(waitForSemanticObjcSnapshotStability({
      sample: async () => ({ ...baseSnapshot, sourceMembership: false }),
      sampleIntervalMs: 5,
      stableSamples: 2,
      maxWaitMs: 20,
    })).resolves.toMatchObject({
      status: 'unsafe-capability',
      reason: 'helper-missing-source-membership',
      samples: 1,
    });
  });

  it('aborts an in-flight helper snapshot sample', async () => {
    const controller = new AbortController();
    let sampleSawAbort = false;
    const outcomePromise = waitForSemanticObjcSnapshotStability({
      sample: async (signal?: AbortSignal) => new Promise<SemanticObjcSnapshotRecord>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          sampleSawAbort = true;
          reject(new Error('sample aborted'));
        }, { once: true });
      }),
      sampleIntervalMs: 50,
      stableSamples: 2,
      maxWaitMs: 1000,
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort();

    await expect(outcomePromise).resolves.toMatchObject({
      status: 'aborted',
      reason: 'semantic-snapshot-wait-aborted',
    });
    expect(sampleSawAbort).toBe(true);
  });

  it('aborts while sleeping between snapshot samples', async () => {
    const controller = new AbortController();
    const outcomePromise = waitForSemanticObjcSnapshotStability({
      sample: async () => ({ ...baseSnapshot }),
      sampleIntervalMs: 1000,
      stableSamples: 2,
      maxWaitMs: 5000,
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort();

    await expect(outcomePromise).resolves.toMatchObject({
      status: 'aborted',
      reason: 'semantic-snapshot-wait-aborted',
      samples: 1,
    });
  });

  it('spawns the helper snapshot subcommand and parses compact output', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semobjc-snapshot-'));
    const helperPath = path.join(dir, 'fake-helper.js');
    const argsPath = path.join(dir, 'args.json');
    fs.writeFileSync(helperPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify(${JSON.stringify(baseSnapshot)}));
`);
    fs.chmodSync(helperPath, 0o755);
    try {
      await expect(spawnSemanticObjcSnapshot({
        helperPath,
        sourceRoot: '/project',
        storePath: '/store',
        languages: ['objc', 'swift'],
      })).resolves.toMatchObject({
        ...baseSnapshot,
        capturedAtMs: expect.any(Number),
      });
      expect(JSON.parse(fs.readFileSync(argsPath, 'utf8'))).toEqual([
        'snapshot',
        '--source-root',
        '/project',
        '--store-path',
        '/store',
        '--language',
        'objc',
        'swift',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
