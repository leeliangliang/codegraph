#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseConnection } from '../dist/db/index.js';
import {
  enrichWithIndexStore,
  getSemanticObjcState,
} from '../dist/extraction/semantic-objc/index.js';

const args = parseArgs(process.argv.slice(2));
const required = ['project', 'scheme', 'sourceRoot', 'helper', 'derivedData'];
for (const key of required) {
  if (!args[key]) {
    usage();
    process.exit(1);
  }
}

const sourceRoot = path.resolve(args.sourceRoot);
const helperPath = path.resolve(args.helper);
const derivedDataPath = path.resolve(args.derivedData);
const storePath = path.join(derivedDataPath, 'Index.noindex', 'DataStore');
const outPath = path.resolve(args.out ?? '.omc/research/semantic-objc-race-real-smoke.json');
const dbDir = path.resolve(args.dbDir ?? '/private/tmp/codegraph-semantic-objc-race-db');
const logPath = path.resolve(args.log ?? '/private/tmp/codegraph-semantic-objc-race-xcodebuild.log');
const languages = args.languages.length > 0 ? args.languages : ['objc'];

fs.rmSync(dbDir, { recursive: true, force: true });
fs.mkdirSync(dbDir, { recursive: true });
fs.mkdirSync(path.dirname(logPath), { recursive: true });

const conn = DatabaseConnection.initialize(path.join(dbDir, 'codegraph.db'));
const xcodebuildArgs = [
  '-project', path.resolve(args.project),
  '-scheme', args.scheme,
  '-configuration', args.configuration ?? 'Debug',
  '-sdk', args.sdk ?? 'iphonesimulator',
  '-destination', args.destination ?? 'generic/platform=iOS Simulator',
  '-derivedDataPath', derivedDataPath,
  'COMPILER_INDEX_STORE_ENABLE=YES',
  'build',
];

let xcodebuildExit = null;
let enrichment = null;
const startedAt = Date.now();
const log = fs.createWriteStream(logPath, { flags: 'w' });
const xb = spawn('xcodebuild', xcodebuildArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
xb.stdout.pipe(log);
xb.stderr.pipe(log);
xb.on('exit', (code, signal) => {
  xcodebuildExit = { code, signal };
});

await sleep(args.preEnrichDelayMs ?? 3000);
try {
  const summary = await enrichWithIndexStore(conn.getDb(), {
    helperPath,
    storePath,
    projectRoot: sourceRoot,
    helperSourceRoot: sourceRoot,
    languages,
  });
  enrichment = {
    ok: true,
    summary: {
      symsSeen: summary.symsSeen,
      symsMerged: summary.symsMerged,
      unitsSeen: summary.unitsSeen,
      unitsMerged: summary.unitsMerged,
      unitFilesSeen: summary.unitFilesSeen,
      unitFilesMerged: summary.unitFilesMerged,
    },
  };
} catch (err) {
  enrichment = {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

xb.kill('SIGINT');
await sleep(5000);
if (xcodebuildExit === null) xb.kill('SIGTERM');
await sleep(1000);
log.end();

const state = getSemanticObjcState(conn.getDb());
conn.close();

const result = {
  startedAt: new Date(startedAt).toISOString(),
  elapsedMs: Date.now() - startedAt,
  sourceRoot,
  helperPath,
  derivedDataPath,
  storePath,
  languages,
  xcodebuildArgs,
  xcodebuildExit,
  xcodebuildLog: logPath,
  enrichment,
  state,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const parsed = { languages: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
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
      case '--pre-enrich-delay-ms':
        parsed.preEnrichDelayMs = Number(argv[++i]);
        break;
      case '--db-dir':
        parsed.dbDir = argv[++i];
        break;
      case '--log':
        parsed.log = argv[++i];
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
  node scripts/semantic-objc-race-real-smoke.mjs \\
    --project /path/to/App.xcodeproj \\
    --scheme App \\
    --source-root /path/to/project \\
    --helper packages/mac-objc-enricher/bin/codegraph-xchelper \\
    --derived-data /private/tmp/codegraph-race-dd \\
    [--language objc] [--out .omc/research/race.json]
`);
}
