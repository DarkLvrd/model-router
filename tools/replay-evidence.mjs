/**
 * Replay a saved evidence run into a throwaway ledger and print `status`.
 *
 *   node tools/replay-evidence.mjs [evidence/raw-jev-....json]
 *
 * Why this exists: the README shows what `model-router status` looks like after
 * the 10-message test. Hand-writing that output would be a claim. This makes it
 * a reproduction — same rule, same ledger, same formatter, no Jev calls.
 *
 * It writes to a temp directory, never to the captain's real ledger, because
 * the sample messages are not the captain's messages. Every import below is
 * dynamic and happens AFTER MODEL_ROUTER_HOME is set, so there is no way for
 * this tool to reach the real state directory.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const REPO_ROOT = join(HERE, '..');
const evidenceDir = join(REPO_ROOT, 'evidence');

function latestEvidence() {
  const files = readdirSync(evidenceDir)
    .filter((f) => f.startsWith('raw-jev-') && f.endsWith('.json'))
    .sort();
  if (!files.length) throw new Error(`no raw-jev-*.json in ${evidenceDir}`);
  return join(evidenceDir, files[files.length - 1]);
}

const file = process.argv[2] ? join(process.cwd(), process.argv[2]) : latestEvidence();
const raw = JSON.parse(readFileSync(file, 'utf8'));

// Set this BEFORE importing anything that reads config, and refuse to run
// against the default location so this tool can never touch the real ledger.
const home = mkdtempSync(join(tmpdir(), 'model-router-replay-'));
process.env.MODEL_ROUTER_HOME = home;

const { resetState, recordDecision, recordJevCall } = await import('../lib/ledger.mjs');
const { decide } = await import('../lib/policy.mjs');

resetState();

// The warm-up calls are real Jev calls and belong in the totals.
const warmCalls = raw.warmup?.calls ?? 1;
if (raw.warmup?.inputTokens) {
  for (let i = 0; i < warmCalls; i++) {
    recordJevCall({
      ok: raw.warmup.ok !== false,
      ms: Math.round((raw.warmup.ms ?? 0) / warmCalls),
      inputTokens: Math.round(raw.warmup.inputTokens / warmCalls),
      outputTokens: Math.round((raw.warmup.outputTokens ?? 0) / warmCalls),
      reason: raw.warmup.reason ?? undefined,
    });
  }
}

for (const s of raw.samples) {
  const usable = Boolean(s.raw?.rawChoice);
  const verdict = usable
    ? {
        size: s.raw.size,
        rawChoice: s.raw.rawChoice,
        isCannotTell: s.raw.isCannotTell,
        confidence: s.raw.confidence,
        clarity: s.raw.clarity,
        standalone: s.raw.standalone,
      }
    : null;

  recordJevCall({
    ok: usable,
    ms: s.ms,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    reason: usable ? undefined : (s.raw?.error ?? 'unavailable'),
  });
  recordDecision(decide({ enabled: true, verdict, fallbackReason: usable ? null : s.raw?.error }));
}

console.log(`# replayed from ${file.slice(REPO_ROOT.length + 1)}`);
console.log('# produced by tools/replay-evidence.mjs into a throwaway state dir\n');

// Print through the real CLI, so what you see is exactly what the captain sees.
const { execFileSync } = await import('node:child_process');
process.stdout.write(
  execFileSync(process.execPath, [join(REPO_ROOT, 'bin', 'router.mjs'), 'status'], {
    env: { ...process.env, MODEL_ROUTER_HOME: home },
    encoding: 'utf8',
  }).replaceAll(home, '~/.model-router'),
);

rmSync(home, { recursive: true, force: true });
