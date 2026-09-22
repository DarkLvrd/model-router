/**
 * The live test: run the 8 sample messages plus the 2 short replies through
 * the real Jev sizer, apply the real routing rule, and write out the table
 * the captain asked for plus the raw answers as evidence.
 *
 *   node bin/router.mjs test-samples
 *   node test/run-samples.mjs
 *
 * This DOES send the sample message text to TypeSafe. It is the one place in
 * this project that talks to Jev while the switch is off, and it says so
 * before it starts. The samples are written for this repo, not the captain's
 * own traffic.
 *
 * Output goes to evidence/. Nothing about the captain's real usage is touched:
 * the ledger is not written to, because these are not the captain's messages.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, JEV_TIMEOUT_MS, LATENCY_BUDGET_MS } from '../lib/config.mjs';
import { inferredCostUsd, sizeMessage } from '../lib/jev.mjs';
import { decide } from '../lib/policy.mjs';
import { SAMPLES } from './samples.mjs';

const evidenceDir = join(REPO_ROOT, 'evidence');
mkdirSync(evidenceDir, { recursive: true });

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');

console.log('model-router live sample test');
console.log(`  samples: ${SAMPLES.length} (8 sized messages + 2 short replies)`);
console.log('  this sends the sample text below to TypeSafe (api.typesafe.ai) to be sized.');
console.log(`  timeout per call: ${JEV_TIMEOUT_MS}ms — a timeout falls back, it does not retry`);
console.log('');

// TypeSafe's first calls from a fresh process are cold and measured at ~2.0s,
// which is over the per-message budget on purpose. Measurement showed TWO cold
// calls (~2007ms and ~2093ms) and then everything warm at 410-797ms, so the
// warm-up does two. The Pi extension pays the same cost once at load instead of
// on the captain's first two messages. The warm-up's tokens are in the totals.
const warmupCalls = [];
for (let i = 0; i < 2; i++) {
  warmupCalls.push(await sizeMessage('warm up the connection', { timeoutMs: 10_000 }));
}
const warmup = {
  ok: warmupCalls.every((c) => c.ok),
  ms: warmupCalls.reduce((a, c) => a + c.ms, 0),
  inputTokens: warmupCalls.reduce((a, c) => a + (c.inputTokens ?? 0), 0),
  outputTokens: warmupCalls.reduce((a, c) => a + (c.outputTokens ?? 0), 0),
  reason: warmupCalls.find((c) => !c.ok)?.reason ?? null,
};
console.log(
  `  warm-up: 2 calls, ${warmup.ok ? `ok in ${warmup.ms}ms total` : `one failed (${warmup.reason})`} —\n` +
    '    this is the cold-start cost the extension pays once at load, not per message\n',
);

const rows = [];

for (const sample of SAMPLES) {
  const jev = await sizeMessage(sample.message, {
    recentTurns: sample.recentTurns,
    timeoutMs: JEV_TIMEOUT_MS,
  });

  const decision = decide({
    enabled: true,
    verdict: jev.ok ? jev.verdict : null,
    fallbackReason: jev.ok ? null : jev.reason,
  });

  const size = jev.ok ? (jev.verdict.size ?? jev.verdict.rawChoice) : '—';
  const confidence = jev.ok && jev.verdict.confidence !== null ? jev.verdict.confidence.toFixed(2) : '—';
  const clarity = jev.ok && jev.verdict.clarity !== null ? jev.verdict.clarity.toFixed(2) : '—';
  const standalone = jev.ok && jev.verdict.standalone !== null ? jev.verdict.standalone.toFixed(2) : '—';
  const routed = decision.action === 'route' ? 'routed' : 'fell back';

  rows.push({
    id: sample.id,
    band: sample.band,
    expect: sample.expect,
    message: sample.message,
    size,
    confidence,
    clarity,
    standalone,
    model: decision.action === 'route' ? decision.model : '—',
    outcome: routed,
    reason: decision.reason,
    ms: jev.ms,
    inputTokens: jev.inputTokens,
    outputTokens: jev.outputTokens,
    costUsd: inferredCostUsd(jev.inputTokens),
    raw: jev.ok ? jev.verdict : { error: jev.reason },
  });

  const verdictSummary = jev.ok
    ? `${size} @ ${confidence} (clarity ${clarity}, standalone ${standalone})`
    : `ERROR: ${jev.reason}`;
  console.log(
    `  ${String(sample.id).padStart(2)}. ${sample.band.padEnd(11)} -> ${verdictSummary.padEnd(46)} ${routed.padEnd(10)} ${decision.model ?? ''}`,
  );
}

const totals = rows.reduce(
  (acc, r) => {
    acc.inputTokens += r.inputTokens;
    acc.outputTokens += r.outputTokens;
    acc.wallMs += r.ms;
    acc.costUsd += r.costUsd;
    if (r.outcome === 'routed') acc.routed += 1;
    else acc.fellBack += 1;
    return acc;
  },
  { inputTokens: 0, outputTokens: 0, wallMs: 0, costUsd: 0, routed: 0, fellBack: 0 },
);

// The warm-up calls are real Jev calls and part of the measured cost of the
// test, so their tokens and wall time join the totals.
const sampleWallMs = totals.wallMs;
totals.inputTokens += warmup.inputTokens;
totals.outputTokens += warmup.outputTokens;
totals.costUsd += inferredCostUsd(warmup.inputTokens);
totals.wallMs += warmup.ms;
totals.sampleWallMs = sampleWallMs;

const correct = rows.filter((r) => {
  if (r.expect === 'in_place') return r.outcome === 'fell back';
  return r.size === r.expect;
}).length;

console.log('');
console.log(`  routed: ${totals.routed}   fell back: ${totals.fellBack}`);
console.log(`  matched the expected band: ${correct}/${rows.length}`);
console.log(`  tokens: ${totals.inputTokens} in / ${totals.outputTokens} out (output is free)`);
console.log(
  `  wall time: ${(totals.wallMs / 1000).toFixed(1)}s including the two warm-up calls ` +
    `(${(totals.sampleWallMs / 1000).toFixed(1)}s for the ${rows.length} samples, ` +
    `${(totals.sampleWallMs / rows.length).toFixed(0)}ms per sample)`,
);
console.log(`  TOTAL MEASURED JEV COST OF THIS TEST: $${totals.costUsd.toFixed(6)} (INFERRED from $0.042/Mtok input)`);
console.log('');

const raw = {
  ranAt: startedAt.toISOString(),
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  jevModelRequested: 'jev-latest',
  jevModelReported: rows.find((r) => r.raw?.model)?.raw?.model ?? null,
  timeoutMsPerCall: JEV_TIMEOUT_MS,
  latencyBudgetMs: LATENCY_BUDGET_MS,
  warmup: {
    calls: warmupCalls.length,
    ok: warmup.ok,
    ms: warmup.ms,
    inputTokens: warmup.inputTokens,
    outputTokens: warmup.outputTokens,
    reason: warmup.reason,
  },
  routingRule:
    'route only when size is one of the four (not cannot_tell), confidence >= 0.6, ' +
    'clarity >= 0.3, standalone >= 0.5, and the mapped model accepts anything attached',
  totals,
  samples: rows,
};
const rawPath = join(evidenceDir, `raw-jev-${stamp}.json`);
writeFileSync(rawPath, `${JSON.stringify(raw, null, 2)}\n`);

const table = [
  '# Live sample test',
  '',
  `Ran ${startedAt.toISOString()} against \`https://api.typesafe.ai/v1/systemone\` with \`jev-latest\` ` +
    `(reported as \`${raw.jevModelReported}\`).`,
  '',
  `${SAMPLES.length} messages: 8 covering tiny through hardest, plus 2 short replies that only make sense inside the conversation. ` +
    'The two short replies were sent with the preceding conversation turns, which is what the "is this a standalone job?" question judges.',
  '',
  `A two-call warm-up ran first (${warmup.ok ? `ok in ${warmup.ms}ms total` : `failed: ${warmup.reason}`}) because TypeSafe's first two calls from a fresh ` +
    'process are cold (~2.0s each, measured) and the Pi extension pays that once at load rather than on the captain\'s first messages. Those tokens are included in the totals below.',
  '',
  '| # | band | message | Jev size | confidence | clear? | standalone? | mapped model | outcome |',
  '| - | ---- | ------- | -------- | ---------- | -------- | ----------- | ------------ | ------- |',
  ...rows.map(
    (r) =>
      `| ${r.id} | ${r.band} | ${escapeCell(r.message)} | ${r.size} | ${r.confidence} | ${r.clarity} | ${r.standalone} | ${r.model} | ${r.outcome}${r.outcome === 'fell back' ? ` — ${escapeCell(r.reason)}` : ''} |`,
  ),
  '',
  '`clear?` is the second, independent "is this request clear enough to act on?" signal — not the pick\'s own',
  'confidence, which this fleet has already measured as unreliable on a forced choice.',
  '`standalone?` is the third question, which is what catches the two short replies.',
  '',
  '## Totals',
  '',
  `- routed: **${totals.routed}**, fell back: **${totals.fellBack}**`,
  `- Jev tokens: **${totals.inputTokens} in / ${totals.outputTokens} out** (TypeSafe bills input only; output is free)`,
  `- wall time: **${(totals.wallMs / 1000).toFixed(1)}s** including the two warm-up calls — ` +
    `**${(totals.sampleWallMs / 1000).toFixed(1)}s for the ${rows.length} samples, ${(totals.sampleWallMs / rows.length).toFixed(0)}ms per sample**`,
  `- **total measured Jev cost of this test: $${totals.costUsd.toFixed(6)}** — INFERRED from TypeSafe's published $0.042 per million input tokens, not reported by the API`,
  '',
  `Raw answers: \`${rawPath.slice(REPO_ROOT.length + 1)}\``,
  '',
].join('\n');

const tablePath = join(evidenceDir, `samples-${stamp}.md`);
writeFileSync(tablePath, table);

console.log(`wrote ${rawPath.slice(REPO_ROOT.length + 1)}`);
console.log(`wrote ${tablePath.slice(REPO_ROOT.length + 1)}`);

function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
