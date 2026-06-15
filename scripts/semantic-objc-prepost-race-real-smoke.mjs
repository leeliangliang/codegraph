#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseConnection } from '../dist/db/index.js';
import {
  enrichWithIndexStore,
  getSemanticObjcState,
  spawnSemanticObjcSnapshot,
} from '../dist/extraction/semantic-objc/index.js';

const args = parseArgs(process.argv.slice(2));
for (const key of ['helper', 'sourceRoot', 'storePath']) {
  if (!args[key]) {
    usage();
    process.exit(1);
  }
}

const helperPath = path.resolve(args.helper);
const sourceRoot = path.resolve(args.sourceRoot);
const storePath = path.resolve(args.storePath);
const outPath = path.resolve(args.out ?? '.omc/research/semantic-objc-prepost-race-real-smoke.json');
const dbDir = path.resolve(args.dbDir ?? '/private/tmp/codegraph-semantic-objc-prepost-race-db');
const languages = args.languages.length > 0 ? args.languages : ['objc'];
fs.rmSync(dbDir, { recursive: true, force: true });
fs.mkdirSync(dbDir, { recursive: true });

const touchTarget = await findFirstUnitFile({ helperPath, sourceRoot, storePath, languages });
const originalStat = fs.statSync(touchTarget);
const conn = DatabaseConnection.initialize(path.join(dbDir, 'codegraph.db'));
const startedAt = Date.now();
let enrichment;
let touchedAt = null;
let snapshotCalls = 0;

try {
  try {
    const summary = await enrichWithIndexStore(conn.getDb(), {
      helperPath,
      storePath,
      projectRoot: sourceRoot,
      helperSourceRoot: sourceRoot,
      languages,
      snapshot: async () => {
        const snapshot = await spawnSemanticObjcSnapshot({
          helperPath,
          storePath,
          sourceRoot,
          languages,
        });
        snapshotCalls++;
        if (snapshotCalls === 1) {
          touchedAt = new Date().toISOString();
          const now = new Date();
          fs.utimesSync(touchTarget, now, now);
        }
        return snapshot;
      },
    });
    enrichment = {
      ok: true,
      summary: {
        symsSeen: summary.symsSeen,
        unitsSeen: summary.unitsSeen,
        unitFilesSeen: summary.unitFilesSeen,
      },
    };
  } catch (err) {
    enrichment = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
} finally {
  fs.utimesSync(touchTarget, originalStat.atime, originalStat.mtime);
}

const state = getSemanticObjcState(conn.getDb());
const snapshotAfterRestore = await spawnSemanticObjcSnapshot({
  helperPath,
  storePath,
  sourceRoot,
  languages,
});
conn.close();

const result = {
  startedAt: new Date(startedAt).toISOString(),
  elapsedMs: Date.now() - startedAt,
  helperPath,
  sourceRoot,
  storePath,
  languages,
  touchTarget,
  touchedAt,
  snapshotCalls,
  enrichment,
  state,
  snapshotAfterRestore,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function findFirstUnitFile({ helperPath, sourceRoot, storePath, languages }) {
  return new Promise((resolve, reject) => {
    const helperArgs = ['dump', '--source-root', sourceRoot, '--store-path', storePath];
    for (const language of languages) helperArgs.push('--language', language);

    const child = spawn(helperPath, helperArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuffer = '';
    let stderr = '';
    let resolved = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const file = unitFileFromLine(line, sourceRoot);
        if (!file) continue;
        resolved = true;
        child.kill('SIGTERM');
        resolve(file);
        return;
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (resolved) return;
      const file = unitFileFromLine(stdoutBuffer, sourceRoot);
      if (file) {
        resolve(file);
        return;
      }
      reject(new Error(`No unit_file emitted before helper exit code=${code} signal=${signal ?? ''}: ${stderr.trim()}`));
    });
  });
}

function unitFileFromLine(line, sourceRoot) {
  if (!line.trim()) return null;
  try {
    const record = JSON.parse(line);
    if (record?.t !== 'unit_file' || record.role !== 'primary' || typeof record.file !== 'string') return null;
    const filePath = path.isAbsolute(record.file) ? record.file : path.join(sourceRoot, record.file);
    return fs.existsSync(filePath) ? filePath : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const parsed = { languages: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--helper':
        parsed.helper = argv[++i];
        break;
      case '--source-root':
        parsed.sourceRoot = argv[++i];
        break;
      case '--store-path':
        parsed.storePath = argv[++i];
        break;
      case '--language':
        parsed.languages.push(argv[++i]);
        break;
      case '--db-dir':
        parsed.dbDir = argv[++i];
        break;
      case '--out':
        parsed.out = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  parsed.languages = parsed.languages.filter(Boolean);
  return parsed;
}

function usage() {
  process.stderr.write(`Usage:
  node scripts/semantic-objc-prepost-race-real-smoke.mjs \\
    --helper packages/mac-objc-enricher/bin/codegraph-xchelper \\
    --source-root /path/to/project \\
    --store-path /path/to/Index.noindex/DataStore \\
    [--language objc] [--out .omc/research/prepost-race.json]
`);
}
