#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (!args.helper || !args.sourceRoot) {
  usage();
  process.exit(1);
}

const languages = args.languages.length > 0 ? args.languages : ['objc'];
const samples = Math.max(1, args.samples ?? 1);
const output = {
  startedAt: new Date().toISOString(),
  sourceRoot: resolve(args.sourceRoot),
  storePath: args.storePath ? resolve(args.storePath) : null,
  helperPath: resolve(args.helper),
  languages,
  samples: [],
  fullDump: null,
  status: null,
};

for (let i = 0; i < samples; i++) {
  output.samples.push(await runSnapshot({
    helper: output.helperPath,
    sourceRoot: output.sourceRoot,
    storePath: output.storePath,
    languages,
  }));
}

if (args.fullDump) {
  output.fullDump = await runFullDump({
    helper: output.helperPath,
    sourceRoot: output.sourceRoot,
    storePath: output.storePath,
    languages,
  });
}

if (args.statusProject) {
  output.status = runStatusJson(resolve(args.statusProject));
}

output.finishedAt = new Date().toISOString();
const json = `${JSON.stringify(output, null, 2)}\n`;
if (args.out) {
  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json);
} else {
  process.stdout.write(json);
}

function runSnapshot({ helper, sourceRoot, storePath, languages }) {
  return new Promise((resolveSnapshot, reject) => {
    const helperArgs = ['snapshot', '--source-root', sourceRoot];
    if (storePath) helperArgs.push('--store-path', storePath);
    for (const language of languages) helperArgs.push('--language', language);

    const startedAt = Date.now();
    const child = spawn(helper, helperArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let maxRssKb = null;
    let rssUnavailableReason = null;
    const rssTimer = setInterval(() => {
      const rss = readRssKb(child.pid);
      if (rss.ok) {
        maxRssKb = Math.max(maxRssKb ?? 0, rss.value);
      } else {
        rssUnavailableReason = rss.reason;
      }
    }, 100);
    rssTimer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearInterval(rssTimer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearInterval(rssTimer);
      const elapsedMs = Date.now() - startedAt;
      if (code !== 0) {
        reject(new Error(`snapshot helper failed code=${code} signal=${signal ?? ''}: ${stderr.trim()}`));
        return;
      }
      const snapshotLine = stdout.split('\n').find((line) => line.trim().startsWith('{'));
      if (!snapshotLine) {
        reject(new Error(`snapshot helper emitted no JSON snapshot: ${stderr.trim()}`));
        return;
      }
      const snapshot = JSON.parse(snapshotLine);
      resolveSnapshot({
        elapsedMs,
        maxRssKb,
        ...(rssUnavailableReason ? { rssUnavailableReason } : {}),
        snapshot,
        stderr: stderr.trim() || undefined,
      });
    });
  });
}

function runFullDump({ helper, sourceRoot, storePath, languages }) {
  return new Promise((resolveDump, reject) => {
    const helperArgs = ['dump', '--source-root', sourceRoot];
    if (storePath) helperArgs.push('--store-path', storePath);
    for (const language of languages) helperArgs.push('--language', language);

    const startedAt = Date.now();
    const child = spawn(helper, helperArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuffer = '';
    let stderr = '';
    let maxRssKb = null;
    let rssUnavailableReason = null;
    const recordCounts = {};
    let jsonLines = 0;
    let malformedLines = 0;
    const rssTimer = setInterval(() => {
      const rss = readRssKb(child.pid);
      if (rss.ok) {
        maxRssKb = Math.max(maxRssKb ?? 0, rss.value);
      } else {
        rssUnavailableReason = rss.reason;
      }
    }, 100);
    rssTimer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record && typeof record.t === 'string') {
            recordCounts[record.t] = (recordCounts[record.t] ?? 0) + 1;
            jsonLines++;
          } else {
            malformedLines++;
          }
        } catch {
          malformedLines++;
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearInterval(rssTimer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearInterval(rssTimer);
      if (stdoutBuffer.trim()) {
        try {
          const record = JSON.parse(stdoutBuffer);
          if (record && typeof record.t === 'string') {
            recordCounts[record.t] = (recordCounts[record.t] ?? 0) + 1;
            jsonLines++;
          } else {
            malformedLines++;
          }
        } catch {
          malformedLines++;
        }
      }
      const elapsedMs = Date.now() - startedAt;
      const result = {
        elapsedMs,
        maxRssKb,
        ...(rssUnavailableReason ? { rssUnavailableReason } : {}),
        recordCounts,
        jsonLines,
        malformedLines,
        stderr: stderr.trim() || undefined,
      };
      if (code !== 0) {
        reject(new Error(`dump helper failed code=${code} signal=${signal ?? ''}: ${stderr.trim()}`));
        return;
      }
      resolveDump(result);
    });
  });
}

function readRssKb(pid) {
  if (!pid) return { ok: false, reason: 'missing-pid' };
  const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0) return { ok: false, reason: `ps-exit-${result.status}` };
  if (typeof result.stdout !== 'string') return { ok: false, reason: 'ps-output-unavailable' };
  const rss = Number(result.stdout.trim());
  return Number.isFinite(rss) ? { ok: true, value: rss } : { ok: false, reason: 'ps-rss-unparseable' };
}

function runStatusJson(projectRoot) {
  const result = spawnSync('codegraph', ['status', projectRoot, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    return {
      error: `codegraph status failed with exit ${result.status}`,
      stderr: result.stderr.trim(),
    };
  }
  const line = result.stdout.trim().split('\n').filter(Boolean).pop();
  return line ? JSON.parse(line) : null;
}

function parseArgs(argv) {
  const parsed = {
    helper: null,
    sourceRoot: null,
    storePath: null,
    statusProject: null,
    out: null,
    samples: 1,
    fullDump: false,
    languages: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--helper':
        parsed.helper = argv[++i] ?? null;
        break;
      case '--source-root':
        parsed.sourceRoot = argv[++i] ?? null;
        break;
      case '--store-path':
        parsed.storePath = argv[++i] ?? null;
        break;
      case '--status-project':
        parsed.statusProject = argv[++i] ?? null;
        break;
      case '--out':
        parsed.out = argv[++i] ?? null;
        break;
      case '--samples':
        parsed.samples = Number(argv[++i]);
        break;
      case '--full-dump':
        parsed.fullDump = true;
        break;
      case '--language':
        parsed.languages.push(argv[++i] ?? '');
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
  node scripts/semantic-objc-validate.mjs \\
    --helper packages/mac-objc-enricher/bin/codegraph-xchelper \\
    --source-root /path/to/Xcode/project \\
    [--store-path /path/to/Index.noindex/DataStore] \\
    [--language objc --language swift] \\
    [--samples 3] \\
    [--full-dump] \\
    [--status-project /path/to/codegraph/project] \\
    [--out .omc/research/semantic-objc-validation.json]
`);
}
