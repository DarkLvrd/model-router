#!/usr/bin/env node
/**
 * model-router — command line.
 *
 *   model-router on             turn the router on
 *   model-router off            turn it off (this is where it ships)
 *   model-router status         what has been routed, and what Jev has cost
 *   model-router route "<msg>"  size one message and run it on the helper
 *   model-router sizes          show the size -> model mapping and its basis
 *   model-router test-samples   run the 10-message live test (see test/)
 *
 * Nothing here is required for the router to work: the Pi extension is the
 * automatic path. This is the switch, the meter, and a way to exercise one
 * message by hand.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, JEV_TIMEOUT_MS, LATENCY_BUDGET_MS } from '../lib/config.mjs';
import { readState, resetState, statePath } from '../lib/ledger.mjs';
import { disable, enable, isEnabled, switchPath } from '../lib/switch.mjs';
import { spawnHelper } from '../lib/helpers.mjs';
import { RANKING_BASIS, SIZE_MODEL, SIZES, SIZE_CRITERIA, CANNOT_TELL } from '../lib/sizes.mjs';
import { decide } from '../lib/policy.mjs';
import { sizeMessage } from '../lib/jev.mjs';

const [, , cmd = 'status', ...rest] = process.argv;

const PV = readPackageVersion();

switch (cmd) {
  case 'on':
    console.log(onMessage());
    break;
  case 'off':
    disable();
    console.log('model-router is OFF. Nothing is sent to TypeSafe. Every message runs on your own model.');
    break;
  case 'status':
    console.log(statusText());
    break;
  case 'reset':
    resetState();
    console.log('counters reset.');
    break;
  case 'sizes':
    console.log(sizesText());
    break;
  case 'route':
    await routeCommand(rest.join(' '));
    break;
  case 'test-samples':
    await import(new URL('../tools/run-samples.mjs', import.meta.url).href);
    break;
  case '-h':
  case '--help':
  case 'help':
    console.log(helpText());
    break;
  default:
    console.error(`unknown command: ${cmd}\n`);
    console.error(helpText());
    process.exitCode = 2;
}

// ---------------------------------------------------------------------------

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function onMessage() {
  enable();
  return [
    'model-router is ON.',
    '',
    'While it is on, the text of every message you send is sent to TypeSafe (the company',
    'that makes Jev) to be sized, before it reaches your model. Turn it off with:',
    '  model-router off',
  ].join('\n');
}

function statusText() {
  const enabled = isEnabled();
  const s = readState();
  const perSize = SIZES.map((size) => {
    const n = s.routed[size] ?? 0;
    const bar = n > 0 ? ' ' + '#'.repeat(Math.min(n, 40)) : '';
    return `  ${size.padEnd(9)} ${String(n).padStart(5)}${bar}`;
  });

  const modelRows = Object.entries(s.routedToModel).map(([m, n]) => `  ${m.padEnd(30)} ${n}`);

  const inPlaceReasons = Object.entries(s.inPlaceReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `  ${String(n).padStart(5)}  ${r}`);

  const failureReasons = Object.entries(s.jev.failureReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `  ${String(n).padStart(5)}  ${r}`);

  return [
    `model-router ${PV} — ${enabled ? 'ON' : 'OFF'}`,
    enabled
      ? '  Message text IS being sent to TypeSafe for sizing.'
      : '  Nothing is sent to TypeSafe. Every message runs on your own model.',
    '',
    `switch file:  ${switchPath()}  (exists = ON; absent = OFF)`,
    `state file:   ${statePath()}`,
    `latency:      worst case ${LATENCY_BUDGET_MS}ms added per message while ON (Jev timeout ${JEV_TIMEOUT_MS}ms); 0ms while OFF`,
    '',
    `messages seen: ${s.messagesSeen}`,
    '',
    'routed per size',
    ...perSize,
    '',
    'routed per model',
    ...(modelRows.length ? modelRows : ['  (none yet)']),
    '',
    `handled in place: ${s.inPlace}`,
    ...(inPlaceReasons.length ? inPlaceReasons : ['  (none yet)']),
    '',
    'jev',
    `  calls         ${s.jev.calls}`,
    `  failures      ${s.jev.failures}`,
    ...(failureReasons.length ? failureReasons : []),
    `  input tokens  ${s.jev.inputTokens}`,
    `  output tokens ${s.jev.outputTokens}  (free — TypeSafe bills input only)`,
    `  wall time     ${(s.jev.wallMs / 1000).toFixed(1)}s`,
    `  cost          $${s.jev.inferredCostUsd.toFixed(6)}  INFERRED from TypeSafe's published $0.042/Mtok input rate`,
    '',
    `first ${s.firstAt ?? '—'}   last ${s.lastAt ?? '—'}`,
  ].join('\n');
}

function sizesText() {
  const rows = SIZES.map((size) => {
    const m = SIZE_MODEL[size];
    return [
      `${size}`,
      `  model:  ${m.provider}/${m.id}`,
      `  images: ${m.acceptsImages ? 'accepted' : 'text only'}`,
      `  means:  ${SIZE_CRITERIA[size]}`,
    ].join('\n');
  });
  return [
    `size -> model mapping (all ${SIZES.length} sizes are in use; ${SIZES.length} models are installed)`,
    '',
    ...rows,
    '',
    `escape hatch: Jev may also answer "${CANNOT_TELL}", which always means handle it in place.`,
    '',
    `basis for the order: ${RANKING_BASIS}`,
    '',
    'tiny and everyday are the same price and generation; they differ only in whether the model',
    'accepts images. They are not two capability tiers and this project does not claim they are.',
  ].join('\n');
}

async function routeCommand(message) {
  if (!message.trim()) {
    console.error('usage: model-router route "<message>"');
    process.exitCode = 2;
    return;
  }
  const enabled = isEnabled();
  console.log(`router is ${enabled ? 'ON' : 'OFF'}`);
  if (!enabled) {
    console.log(`not routing. Turn it on with:  model-router on`);
    console.log(`(sizing requires sending this message to TypeSafe, so it is not done while OFF.)`);
    return;
  }

  const r = await sizeMessage(message);
  if (!r.ok) {
    console.log(`Jev unavailable (${r.reason}) after ${r.ms}ms -> falling back, nothing routed.`);
    return;
  }
  console.log(
    `Jev: ${r.verdict.size ?? r.verdict.rawChoice} @ confidence ${r.verdict.confidence} ` +
      `(certainty ${r.verdict.certainty}, standalone ${r.verdict.standalone}) in ${r.ms}ms ` +
      `[${r.inputTokens} in / ${r.outputTokens} out tokens]`,
  );

  const decision = decide({ enabled, verdict: r.verdict });
  if (decision.action !== 'route') {
    console.log(`-> handled in place: ${decision.reason}`);
    return;
  }

  console.log(`-> helper on ${decision.model} ...`);
  const out = await spawnHelper(decision.size, message, { cwd: process.cwd() });
  if (!out.ok) {
    console.log(`-> helper could not be started (${out.reason}); nothing was run. Ask again normally.`);
    return;
  }
  console.log(`\n${out.text.trimEnd()}\n`);
  console.log(`(${out.model}, ${(out.ms / 1000).toFixed(1)}s)`);
}

function helpText() {
  return [
    'model-router — pick the smallest model that can do the job, then use it',
    '',
    'usage:',
    '  model-router on              turn the router on (sends message text to TypeSafe)',
    '  model-router off             turn it off — this is where it ships',
    '  model-router status          messages routed per size, fallbacks, Jev cost to date',
    '  model-router sizes           the size -> model mapping and what the order is based on',
    '  model-router route "<msg>"   size one message by hand and run it on its helper',
    '  model-router reset           zero the counters',
    '  model-router test-samples    run the 10-message live test against Jev',
    '',
    `state lives in ${statePath()}`,
    `switch file ${switchPath()}`,
    `worst case ${LATENCY_BUDGET_MS}ms added per message while ON; 0ms while OFF`,
  ].join('\n');
}

