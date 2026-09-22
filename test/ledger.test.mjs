/**
 * The ledger, the switch, and the model line — offline.
 *
 * Every test here points MODEL_ROUTER_HOME at a temp directory, so the real
 * ~/.model-router switch and counters are never touched by the suite.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'model-router-test-'));
process.env.MODEL_ROUTER_HOME = home;

const ledger = await import('../lib/ledger.mjs');
const sw = await import('../lib/switch.mjs');
const helpers = await import('../lib/helpers.mjs');
const { SIZE_MODEL } = await import('../lib/sizes.mjs');

after(() => rmSync(home, { recursive: true, force: true }));

test('the router ships OFF', () => {
  assert.equal(sw.isEnabled(), false);
});

test('enable and disable flip the switch', () => {
  sw.enable();
  assert.equal(sw.isEnabled(), true);
  sw.disable();
  assert.equal(sw.isEnabled(), false);
});

test('a freshly read ledger is all zeros', () => {
  ledger.resetState();
  const s = ledger.readState();
  assert.equal(s.messagesSeen, 0);
  assert.equal(s.routed.tiny, 0);
  assert.equal(s.jev.calls, 0);
  assert.equal(s.jev.inferredCostUsd, 0);
});

test('recording decisions counts per size and per model', () => {
  ledger.resetState();
  ledger.recordDecision({ action: 'route', size: 'tiny', model: SIZE_MODEL.tiny.id, reason: 'ok' });
  ledger.recordDecision({ action: 'route', size: 'tiny', model: SIZE_MODEL.tiny.id, reason: 'ok' });
  ledger.recordDecision({ action: 'route', size: 'hardest', model: SIZE_MODEL.hardest.id, reason: 'ok' });

  const s = ledger.readState();
  assert.equal(s.messagesSeen, 3);
  assert.equal(s.routed.tiny, 2);
  assert.equal(s.routed.hardest, 1);
  assert.equal(s.routedToModel[SIZE_MODEL.tiny.id], 2);
});

test('recording an in-place decision counts the reason, not a size', () => {
  ledger.resetState();
  ledger.recordDecision({ action: 'in_place', size: null, model: null, reason: 'confidence 0.40 below 0.6' });
  const s = ledger.readState();
  assert.equal(s.inPlace, 1);
  assert.equal(s.routed.tiny, 0);
  assert.equal(s.inPlaceReasons['confidence 0.40 below 0.6'], 1);
});

test('a failed Jev call is counted with its reason and adds no cost', () => {
  ledger.resetState();
  ledger.recordJevCall({ ok: false, reason: 'timed out after 1500ms', ms: 1500 });
  const s = ledger.readState();
  assert.equal(s.jev.calls, 1);
  assert.equal(s.jev.failures, 1);
  assert.equal(s.jev.failureReasons['timed out after 1500ms'], 1);
  assert.equal(s.jev.inferredCostUsd, 0);
  assert.equal(s.jev.wallMs, 1500);
});

test('a successful call adds inferred cost from input tokens only', () => {
  ledger.resetState();
  ledger.recordJevCall({ ok: true, ms: 700, inputTokens: 1_000_000, outputTokens: 96 });
  const s = ledger.readState();
  assert.equal(s.jev.inferredCostUsd, 0.042);
  assert.equal(s.jev.inputTokens, 1_000_000);
  assert.equal(s.jev.outputTokens, 96);
});

test('a corrupt ledger reads as empty instead of throwing', () => {
  writeFileSync(ledger.statePath(), '{ this is not json');
  const s = ledger.readState();
  assert.equal(s.messagesSeen, 0);
});

test('a ledger written by an older version still loads its counters', () => {
  writeFileSync(ledger.statePath(), JSON.stringify({ version: 1, messagesSeen: 7 }));
  const s = ledger.readState();
  assert.equal(s.messagesSeen, 7);
  assert.equal(s.routed.tiny, 0);
  assert.equal(typeof s.jev.inferredCostUsd, 'number');
});

test('every size has a contract and a model line, and there is exactly one', () => {
  for (const size of ['tiny', 'everyday', 'large', 'hardest']) {
    const contract = helpers.helperContract(size);
    assert.match(contract, new RegExp(`Model: ${SIZE_MODEL[size].id}`), `contract for ${size}`);
    assert.ok(helpers.HELPER_CONTRACTS[size].length > 20);
  }
});

test('the model line is appended when missing, and not duplicated when present', () => {
  const withLine = helpers.ensureModelLine('here is the answer', 'deepseek-v4-flash');
  assert.match(withLine, /^here is the answer\n\nModel: deepseek-v4-flash\n$/);
  assert.equal((withLine.match(/Model:/g) ?? []).length, 1);

  const already = helpers.ensureModelLine('answer\n\nModel: deepseek-v4-flash', 'deepseek-v4-flash');
  assert.equal((already.match(/Model:/g) ?? []).length, 1);

  const wrong = helpers.ensureModelLine('answer\n\nModel: some-other-model', 'deepseek-v4-flash');
  assert.equal((wrong.match(/Model:/g) ?? []).length, 1);
  assert.match(wrong, /Model: deepseek-v4-flash/);

  assert.match(helpers.ensureModelLine('', 'deepseek-flash'), /Model: deepseek-flash/);
});

test('helperSummary reports the mapping without repeating itself', () => {
  const rows = helpers.helperSummary();
  assert.equal(rows.length, 4);
  const ids = rows.map((r) => r.model);
  assert.equal(new Set(ids).size, 4, 'each size maps to a distinct model id');
  for (const r of rows) assert.equal(r.ref, `deepseek/${r.model}`);
});
