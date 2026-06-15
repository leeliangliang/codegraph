import * as crypto from 'crypto';
import { parseSemanticObjcWatchConfig } from '../extraction/semantic-objc/config';

export interface DaemonSemanticObjcConfigInfo {
  fingerprint: string;
  watchActive: boolean;
}

export function describeDaemonSemanticObjcConfig(value: unknown): DaemonSemanticObjcConfigInfo {
  const config = parseSemanticObjcWatchConfig(value);
  const watchActive = config.enabled && config.watchIndexStore;
  const normalized = watchActive
    ? {
        enabled: true,
        watchIndexStore: true,
        storePath: config.storePath,
        helperPath: config.helperPath,
        languages: Array.from(new Set(config.languages)).sort(),
        deltaMode: config.deltaMode,
        fallback: config.fallback,
        quiescence: config.quiescence,
        scheduler: config.scheduler,
      }
    : { enabled: false, watchIndexStore: false };

  return {
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16),
    watchActive,
  };
}

export function daemonSemanticObjcConfigMatches(
  actual: DaemonSemanticObjcConfigInfo | undefined,
  expected: DaemonSemanticObjcConfigInfo,
): boolean {
  if (!actual) return !expected.watchActive;
  return actual.fingerprint === expected.fingerprint;
}
