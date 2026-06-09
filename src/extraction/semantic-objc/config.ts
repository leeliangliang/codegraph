import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_INDEXSTORE_QUIESCENCE, type IndexStoreQuiescenceOptions } from './quiescence';

export type SemanticObjcDeltaMode = 'unit';
export type SemanticObjcFallback = 'stale-then-idle-reconcile';
export type SemanticObjcSchedulerMode = 'idle-only';

export interface SemanticObjcWatchConfig {
  enabled: boolean;
  watchIndexStore: boolean;
  storePath: string | null;
  helperPath: string | null;
  languages: string[];
  deltaMode: SemanticObjcDeltaMode;
  fallback: SemanticObjcFallback;
  quiescence: IndexStoreQuiescenceOptions;
  scheduler: {
    mode: SemanticObjcSchedulerMode;
    maxQueueDepth: number;
  };
}

export const DEFAULT_SEMANTIC_OBJC_WATCH_CONFIG: SemanticObjcWatchConfig = {
  enabled: false,
  watchIndexStore: false,
  storePath: null,
  helperPath: null,
  // C/C++ are covered by the same clang IndexStore (overload resolution,
  // templates, virtual dispatch — what tree-sitter can't do). Enabled by
  // default so any clang-built target (Xcode, CMake, SwiftPM) is enriched.
  languages: ['objc', 'swift', 'c', 'cpp'],
  deltaMode: 'unit',
  fallback: 'stale-then-idle-reconcile',
  quiescence: DEFAULT_INDEXSTORE_QUIESCENCE,
  scheduler: {
    mode: 'idle-only',
    maxQueueDepth: 1,
  },
};

const QUIESCENCE_BOUNDS = {
  sampleIntervalMs: { min: 100, max: 10000 },
  stableSamples: { min: 1, max: 10 },
  maxWaitMs: { min: 1000, max: 300000 },
  maxQueueDepth: { min: 1, max: 10 },
};

export function parseSemanticObjcWatchConfig(value: unknown): SemanticObjcWatchConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const quiescence = raw.quiescence && typeof raw.quiescence === 'object'
    ? raw.quiescence as Record<string, unknown>
    : {};
  const scheduler = raw.scheduler && typeof raw.scheduler === 'object'
    ? raw.scheduler as Record<string, unknown>
    : {};

  return {
    enabled: raw.enabled === true,
    watchIndexStore: raw.watchIndexStore === true,
    storePath: normalizeIndexStorePath(raw.storePath),
    helperPath: normalizeFilePath(raw.helperPath),
    languages: Array.isArray(raw.languages) && raw.languages.every((lang) => typeof lang === 'string')
      ? raw.languages as string[]
      : DEFAULT_SEMANTIC_OBJC_WATCH_CONFIG.languages,
    deltaMode: raw.deltaMode === 'unit' ? 'unit' : DEFAULT_SEMANTIC_OBJC_WATCH_CONFIG.deltaMode,
    fallback: raw.fallback === 'stale-then-idle-reconcile'
      ? 'stale-then-idle-reconcile'
      : DEFAULT_SEMANTIC_OBJC_WATCH_CONFIG.fallback,
    quiescence: {
      sampleIntervalMs: boundedNumberOption(
        quiescence.sampleIntervalMs,
        DEFAULT_INDEXSTORE_QUIESCENCE.sampleIntervalMs,
        QUIESCENCE_BOUNDS.sampleIntervalMs.min,
        QUIESCENCE_BOUNDS.sampleIntervalMs.max
      ),
      stableSamples: boundedNumberOption(
        quiescence.stableSamples,
        DEFAULT_INDEXSTORE_QUIESCENCE.stableSamples,
        QUIESCENCE_BOUNDS.stableSamples.min,
        QUIESCENCE_BOUNDS.stableSamples.max
      ),
      maxWaitMs: boundedNumberOption(
        quiescence.maxWaitMs,
        DEFAULT_INDEXSTORE_QUIESCENCE.maxWaitMs,
        QUIESCENCE_BOUNDS.maxWaitMs.min,
        QUIESCENCE_BOUNDS.maxWaitMs.max
      ),
    },
    scheduler: {
      mode: scheduler.mode === 'idle-only' ? 'idle-only' : DEFAULT_SEMANTIC_OBJC_WATCH_CONFIG.scheduler.mode,
      maxQueueDepth: boundedNumberOption(
        scheduler.maxQueueDepth,
        DEFAULT_SEMANTIC_OBJC_WATCH_CONFIG.scheduler.maxQueueDepth,
        QUIESCENCE_BOUNDS.maxQueueDepth.min,
        QUIESCENCE_BOUNDS.maxQueueDepth.max
      ),
    },
  };
}

function normalizeIndexStorePath(value: unknown): string | null {
  const normalized = normalizeFilePath(value);
  if (!normalized) return null;
  const parts = normalized.split(path.sep);
  return parts.includes('Index.noindex') && path.basename(normalized) === 'DataStore' ? normalized : null;
}

function normalizeFilePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function boundedNumberOption(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
