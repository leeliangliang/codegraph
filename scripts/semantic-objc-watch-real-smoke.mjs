#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseConnection } from '../dist/db/index.js';
import {
  SemanticObjcIndexStoreWatcher,
  enrichWithIndexStore,
  getSemanticObjcState,
  parseSemanticObjcWatchConfig,
  spawnSemanticObjcSnapshot,
} from '../dist/extraction/semantic-objc/index.js';

const args = parseArgs(process.argv.slice(2));
const required = ['scheme', 'sourceRoot', 'helper', 'derivedData'];
for (const key of required) {
  if (!args[key]) {
    usage();
    process.exit(1);
  }
}
if (!args.workspace && !args.project) {
  usage();
  process.exit(1);
}

const sourceRoot = path.resolve(args.sourceRoot);
const helperPath = path.resolve(args.helper);
const derivedDataPath = path.resolve(args.derivedData);
const storePath = path.join(derivedDataPath, 'Index.noindex', 'DataStore');
const logPath = path.resolve(args.log ?? '/private/tmp/codegraph-semantic-objc-watch-smoke-xcodebuild.log');
const outputPath = path.resolve(args.out ?? '.omc/research/semantic-objc-watch-real-smoke.json');
const dbDir = path.resolve(args.dbDir ?? '/private/tmp/codegraph-semantic-objc-watch-smoke-db');
const languages = args.languages.length > 0 ? args.languages : ['objc'];
const activeWindowMs = args.activeWindowMs ?? 9000;
const afterStopWindowMs = args.afterStopWindowMs ?? 30000;

fs.rmSync(derivedDataPath, { recursive: true, force: true });
fs.rmSync(dbDir, { recursive: true, force: true });
fs.mkdirSync(dbDir, { recursive: true });
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const log = fs.createWriteStream(logPath, { flags: 'w' });
const xcodebuildArgs = [
  ...(args.workspace ? ['-workspace', path.resolve(args.workspace)] : ['-project', path.resolve(args.project)]),
  '-scheme', args.scheme,
  '-configuration', args.configuration ?? 'Debug',
  '-sdk', args.sdk ?? 'iphonesimulator',
  '-destination', args.destination ?? 'generic/platform=iOS Simulator',
  '-derivedDataPath', derivedDataPath,
  'COMPILER_INDEX_STORE_ENABLE=YES',
  'CODE_SIGNING_ALLOWED=NO',
  ...args.xcodebuildArgs,
  'build',
];
const xb = spawn('xcodebuild', xcodebuildArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
xb.stdout.pipe(log);
xb.stderr.pipe(log);

const states = [];
const publications = [];
let runs = 0;
let xcodebuildExit = null;
const conn = DatabaseConnection.initialize(path.join(dbDir, 'codegraph.db'));
xb.on('exit', (code, signal) => {
  xcodebuildExit = { code, signal };
});

const initialRecursiveEntries = await waitForStoreEntries(storePath, 20, 90000);
const config = parseSemanticObjcWatchConfig({
  enabled: true,
  watchIndexStore: true,
  storePath,
  helperPath,
  languages,
  quiescence: {
    sampleIntervalMs: args.sampleIntervalMs ?? 500,
    stableSamples: args.stableSamples ?? 2,
    maxWaitMs: args.maxWaitMs ?? 5000,
  },
});

const watcher = new SemanticObjcIndexStoreWatcher({
  config,
  sourceRoot,
  isIdle: () => true,
  onState: (status, reason) => {
    states.push({ t: new Date().toISOString(), state: reason ? `${status}:${reason}` : status });
  },
  snapshot: () => spawnSemanticObjcSnapshot({
    helperPath,
    storePath,
    sourceRoot,
    languages,
  }),
  onSemanticDelta: async () => {
    runs++;
    states.push({ t: new Date().toISOString(), state: 'delta-run' });
    const startedAt = Date.now();
    try {
      const summary = await enrichWithIndexStore(conn.getDb(), {
        helperPath,
        storePath,
        projectRoot: sourceRoot,
        helperSourceRoot: sourceRoot,
        languages,
      });
      publications.push({
        ok: true,
        elapsedMs: Date.now() - startedAt,
        summary: {
          symsSeen: summary.symsSeen,
          symsMerged: summary.symsMerged,
          unitsSeen: summary.unitsSeen,
          unitsMerged: summary.unitsMerged,
          unitFilesSeen: summary.unitFilesSeen,
          unitFilesMerged: summary.unitFilesMerged,
        },
      });
    } catch (err) {
      publications.push({
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});

watcher.notifyChanged();
await sleep(activeWindowMs);
const runsWhileActive = runs;
xb.kill('SIGINT');
await sleep(5000);
if (xcodebuildExit === null) xb.kill('SIGTERM');
watcher.notifyChanged();
await sleep(afterStopWindowMs);
watcher.stop();
log.end();
const semanticObjcState = getSemanticObjcState(conn.getDb());
conn.close();

const result = {
  startedAt: new Date().toISOString(),
  sourceRoot,
  helperPath,
  xcodebuildArgs,
  derivedDataPath,
  storePath,
  dbDir,
  languages,
  initialRecursiveEntries,
  runsWhileActive,
  runsAfterStop: runs,
  publications,
  semanticObjcState,
  states,
  xcodebuildExit,
  xcodebuildLog: logPath,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function waitForStoreEntries(storePath, minEntries, maxWaitMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= maxWaitMs) {
    if (fs.existsSync(storePath)) {
      const entries = fs.readdirSync(storePath, { recursive: true }).length;
      if (entries >= minEntries) return entries;
    }
    await sleep(1000);
  }
  return fs.existsSync(storePath) ? fs.readdirSync(storePath, { recursive: true }).length : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const parsed = { languages: [], xcodebuildArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--workspace':
        parsed.workspace = argv[++i];
        break;
      case '--project':
        parsed.project = argv[++i];
        break;
      case '--scheme':
        parsed.scheme = argv[++i];
        break;
      case '--source-root':
        parsed.sourceRoot = argv[++i];
        break;
      case '--helper':
        parsed.helper = argv[++i];
        break;
      case '--derived-data':
        parsed.derivedData = argv[++i];
        break;
      case '--language':
        parsed.languages.push(argv[++i]);
        break;
      case '--configuration':
        parsed.configuration = argv[++i];
        break;
      case '--sdk':
        parsed.sdk = argv[++i];
        break;
      case '--destination':
        parsed.destination = argv[++i];
        break;
      case '--log':
        parsed.log = argv[++i];
        break;
      case '--out':
        parsed.out = argv[++i];
        break;
      case '--db-dir':
        parsed.dbDir = argv[++i];
        break;
      case '--active-window-ms':
        parsed.activeWindowMs = Number(argv[++i]);
        break;
      case '--after-stop-window-ms':
        parsed.afterStopWindowMs = Number(argv[++i]);
        break;
      case '--sample-interval-ms':
        parsed.sampleIntervalMs = Number(argv[++i]);
        break;
      case '--stable-samples':
        parsed.stableSamples = Number(argv[++i]);
        break;
      case '--max-wait-ms':
        parsed.maxWaitMs = Number(argv[++i]);
        break;
      case '--xcodebuild-arg':
        parsed.xcodebuildArgs.push(argv[++i]);
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
  node scripts/semantic-objc-watch-real-smoke.mjs \\
    --workspace /path/to/App.xcworkspace \\
    --scheme App \\
    --source-root /path/to/project \\
    --helper packages/mac-objc-enricher/bin/codegraph-xchelper \\
    --derived-data /private/tmp/codegraph-watch-dd \\
    [--language objc] [--out .omc/research/watch.json] \\
    [--xcodebuild-arg KEY=VALUE]

Use --project instead of --workspace for .xcodeproj targets.
`);
}
