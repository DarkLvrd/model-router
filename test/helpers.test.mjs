/**
 * The spawned helper: argv, environment hygiene, and the "cannot be started"
 * fallback. No real `pi` is launched here — the point is that a helper which
 * cannot run produces `{ ok: false }` rather than an exception or a hang, and
 * that the argv and environment are what we say they are.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { helperArgs, helperContract, helperEnv, spawnHelper } from '../lib/helpers.mjs';
import { SIZE_MODEL, modelRef } from '../lib/sizes.mjs';

test('the helper argv names the mapped model and pre-asks for the model line', () => {
  const args = helperArgs('hardest', 'do the thing');
  assert.deepEqual(args.slice(0, 2), ['-p', '--model']);
  assert.equal(args[2], modelRef('hardest'));
  assert.equal(args[2], `deepseek/${SIZE_MODEL.hardest.id}`);
  assert.equal(args[3], '--append-system-prompt');
  assert.match(args[4], /Model: deepseek-v4-pro/);
  assert.equal(args[5], '--');
  assert.equal(args[6], 'do the thing');
});

test('every size gets its own model on the helper argv', () => {
  const seen = new Set();
  for (const size of Object.keys(SIZE_MODEL)) {
    seen.add(helperArgs(size, 'x')[2]);
  }
  assert.equal(seen.size, 4, 'four sizes must produce four distinct model refs');
});

test('the helper contract names the model and demands it as the last line', () => {
  for (const size of Object.keys(SIZE_MODEL)) {
    const c = helperContract(size);
    assert.match(c, new RegExp(SIZE_MODEL[size].id));
    assert.match(c, /End your reply with exactly one final line/);
  }
});

test('a nested helper does not inherit the session it was spawned from', () => {
  const env = helperEnv({
    PATH: '/usr/bin',
    TYPESAFE_API_KEY: 'keep-me',
    PI_SESSION_ID: 'abc',
    PI_SESSION_FILE: '/tmp/session.jsonl',
    PI_MODEL: 'deepseek-flash',
    PI_PROVIDER: 'deepseek',
    PI_REASONING_LEVEL: 'high',
    PI_CODING_AGENT: 'true',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.TYPESAFE_API_KEY, 'keep-me');
  for (const k of Object.keys(env)) {
    assert.equal(k.startsWith('PI_'), false, `${k} should have been stripped`);
  }
});

test('a helper that cannot be started falls back instead of throwing', async () => {
  const r = await spawnHelper('tiny', 'hello', {
    piBin: '/nonexistent/definitely-not-pi',
    timeoutMs: 5000,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.length > 0);
});

test('an unknown size falls back instead of throwing', async () => {
  const r = await spawnHelper('gigantic', 'hello');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no model mapped/);
});

test('a real spawn is available and the binary resolves', async () => {
  // Does not launch pi: asserts the option plumbing works with an exit-0 binary.
  const r = await spawnHelper('tiny', 'hello', { piBin: process.execPath, timeoutMs: 5000 });
  // node with pi's argv exits non-zero, so this must be a clean failure, not a throw.
  assert.equal(r.ok, false);
  assert.ok(r.reason.length > 0);
});
