#!/usr/bin/env node
/**
 * Canary: prove the router ships OFF and stays OFF unless the user turns it
 * on, and that while it is off nothing is sent to TypeSafe.
 *
 *   node test/switch-canary.mjs
 *
 * This runs against a throwaway MODEL_ROUTER_HOME, so it never touches the
 * user's real switch. It fails loudly if a fresh install would arrive with
 * the router on, which would mean message text being sent to a third party
 * without the user asking.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'model-router-canary-'));
process.env.MODEL_ROUTER_HOME = home;

const { isEnabled, enable, disable, switchPath } = await import('../lib/switch.mjs');
const { route } = await import('../lib/router.mjs');
const { readState, resetState } = await import('../lib/ledger.mjs');

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

console.log('model-router switch canary');
console.log(`  throwaway state dir: ${home}`);
console.log('');

await check('a fresh install has no switch file', () => {
  assert.equal(isEnabled(), false, `unexpected switch file at ${switchPath()}`);
});

await check('a fresh install routes nothing and spends nothing', async () => {
  resetState();
  const r = await route('rename foo to bar', { enabled: false });
  assert.equal(r.decision.action, 'in_place');
  const s = readState();
  assert.equal(s.jev.calls, 0, 'Jev was called while the router was off');
  assert.equal(s.jev.inferredCostUsd, 0);
  assert.equal(s.messagesSeen, 1);
});

await check('OFF makes no network call even when a fetch is provided', async () => {
  let calls = 0;
  const r = await route('anything at all', {
    enabled: false,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(calls, 0, 'the router reached the network while off');
  assert.equal(r.jev, null);
});

await check('turning it on is explicit, and turning it off leaves no file', () => {
  enable();
  assert.equal(isEnabled(), true);
  disable();
  assert.equal(isEnabled(), false);
});

rmSync(home, { recursive: true, force: true });

console.log('');
if (failed) {
  console.log(`canary FAILED: ${failed} check(s)`);
  process.exit(1);
}
console.log('canary passed: the router ships off and nothing leaves the machine while it is off');
