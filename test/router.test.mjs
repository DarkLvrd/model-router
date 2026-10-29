/**
 * The router as a whole, offline.
 *
 * The two claims that matter most to the user are asserted here:
 *
 *   1. OFF makes no network call and adds nothing. (No fetch happens at all.)
 *   2. ON never blocks on a bad Jev. Every failure mode falls back, and the
 *      fallback reason is recorded so the status output can explain itself.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'model-router-router-'));
process.env.MODEL_ROUTER_HOME = home;

const { route } = await import('../lib/router.mjs');
const ledger = await import('../lib/ledger.mjs');
const sw = await import('../lib/switch.mjs');
const { SIZE_MODEL } = await import('../lib/sizes.mjs');

after(() => rmSync(home, { recursive: true, force: true }));

const GOOD_BODY = {
  model: 'jev-1.13.0',
  answers: {
    job_size: { type: 'choice', choice: 'large', confidence: 0.9, probabilities: { large: 0.9, tiny: 0.1 } },
    size_is_clear: { type: "noul", noul: 0.8 },
    standalone_job: { type: 'noul', noul: 0.9 },
  },
  usage: { input_tokens: 500, output_tokens: 40 },
};

function countingFetch(body = GOOD_BODY) {
  const fn = async () => ({ ok: true, status: 200, json: async () => body });
  fn.calls = 0;
  return new Proxy(fn, {
    apply(target, thisArg, args) {
      target.calls += 1;
      return target.apply(thisArg, args);
    },
  });
}

test('OFF: no network call is made at all', async () => {
  sw.disable();
  ledger.resetState();
  const fetchImpl = countingFetch();
  const { decision, jev } = await route('rename foo to bar', { fetchImpl });

  assert.equal(fetchImpl.calls, 0, 'the switch being off must mean zero requests');
  assert.equal(jev, null);
  assert.equal(decision.action, 'in_place');
  assert.match(decision.reason, /off/);

  const s = ledger.readState();
  assert.equal(s.messagesSeen, 1);
  assert.equal(s.jev.calls, 0);
  assert.equal(s.jev.inferredCostUsd, 0);
});

test('ON: a sure pick routes to the mapped model and the cost is recorded', async () => {
  sw.enable();
  ledger.resetState();
  const fetchImpl = countingFetch();
  const { decision, jev } = await route('build the report', { enabled: true, fetchImpl });

  assert.equal(fetchImpl.calls, 1);
  assert.equal(jev.ok, true);
  assert.equal(decision.action, 'route');
  assert.equal(decision.size, 'large');
  assert.equal(decision.model, SIZE_MODEL.large.id);

  const s = ledger.readState();
  assert.equal(s.routed.large, 1);
  assert.equal(s.jev.calls, 1);
  assert.equal(s.jev.inputTokens, 500);
  assert.equal(Number(s.jev.inferredCostUsd.toFixed(8)), Number((500 * 0.042 / 1e6).toFixed(8)));
  sw.disable();
});

test('ON: a Jev outage falls back and records the reason', async () => {
  sw.enable();
  ledger.resetState();
  const { decision } = await route('build the report', {
    enabled: true,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });

  assert.equal(decision.action, 'in_place');
  const s = ledger.readState();
  assert.equal(s.jev.failures, 1);
  assert.equal(s.inPlace, 1);
  assert.ok(Object.keys(s.inPlaceReasons).some((r) => /jev unavailable/.test(r)));
  assert.equal(s.jev.inferredCostUsd, 0);
  sw.disable();
});

test('ON: a timeout falls back inside the stated budget', async () => {
  sw.enable();
  ledger.resetState();
  const started = Date.now();
  const { decision } = await route('build the report', {
    enabled: true,
    timeoutMs: 80,
    fetchImpl: (_url, opts) =>
      new Promise((_res, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'TimeoutError';
          reject(e);
        });
      }),
  });
  const elapsed = Date.now() - started;
  assert.equal(decision.action, 'in_place');
  assert.match(decision.reason, /timed out/);
  assert.ok(elapsed < 1000, `took ${elapsed}ms`);
  sw.disable();
});

test('ON: an empty message never reaches Jev', async () => {
  sw.enable();
  const fetchImpl = countingFetch();
  const { decision } = await route('   ', { enabled: true, fetchImpl });
  assert.equal(fetchImpl.calls, 0);
  assert.match(decision.reason, /empty message/);
  sw.disable();
});

test('ON: one message costs exactly one Jev call, never a retry', async () => {
  sw.enable();
  ledger.resetState();
  const fetchImpl = countingFetch({ answers: {}, usage: {} });
  await route('anything', { enabled: true, fetchImpl });
  assert.equal(fetchImpl.calls, 1, 'a failed answer must not be retried inside the budget');
  sw.disable();
});

test('the ledger counts a routed message even when nothing else works', async () => {
  sw.enable();
  ledger.resetState();
  await route('do it', {
    enabled: true,
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });
  const s = ledger.readState();
  assert.equal(s.messagesSeen, 1);
  assert.equal(s.jev.failures, 1);
  assert.equal(s.jev.failureReasons['HTTP 429'], 1);
  sw.disable();
});

test('counters are on disk before route() resolves, not on a later tick', async () => {
  // Regression: the ledger write used to be deferred with setImmediate, which
  // lost it whenever the process exited as soon as the turn ended — `pi -p`
  // does exactly that, and status then read zero after a real routed message.
  sw.enable();
  ledger.resetState();
  const fetchImpl = countingFetch();

  await route('build the report', { enabled: true, fetchImpl });

  // Read the file straight off disk with no caching and no await in between:
  // this is what a process exiting immediately would leave behind.
  const { readFileSync } = await import('node:fs');
  const onDisk = JSON.parse(readFileSync(ledger.statePath(), 'utf8'));
  assert.equal(onDisk.messagesSeen, 1, 'the decision was not durably recorded');
  assert.equal(onDisk.routed.large, 1);
  assert.equal(onDisk.jev.calls, 1, 'the Jev call was not durably recorded');
  assert.ok(onDisk.jev.inferredCostUsd > 0);
  sw.disable();
});

test('recording is skippable so callers can decide for themselves', async () => {
  sw.enable();
  ledger.resetState();
  const fetchImpl = countingFetch();
  await route('build the report', { enabled: true, fetchImpl, record: false });
  assert.equal(ledger.readState().messagesSeen, 0);
  sw.disable();
});
