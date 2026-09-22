import assert from 'node:assert/strict';
import test from 'node:test';

import { ACTIONS, decide } from '../lib/policy.mjs';
import { MIN_CLARITY, MIN_CONFIDENCE, MIN_STANDALONE } from '../lib/config.mjs';
import { SIZE_MODEL } from '../lib/sizes.mjs';

const goodVerdict = {
  size: 'tiny',
  rawChoice: 'tiny',
  isCannotTell: false,
  confidence: 0.94,
  clarity: 0.69,
  standalone: 0.76,
};

test('routes a sure, standalone pick to the mapped model', () => {
  const d = decide({ enabled: true, verdict: goodVerdict });
  assert.equal(d.action, ACTIONS.ROUTE);
  assert.equal(d.size, 'tiny');
  assert.equal(d.model, SIZE_MODEL.tiny.id);
});

test('router off means no route, whatever Jev said', () => {
  const d = decide({ enabled: false, verdict: goodVerdict });
  assert.equal(d.action, ACTIONS.IN_PLACE);
  assert.match(d.reason, /off/);
});

test('a failed Jev call falls back and says why', () => {
  const d = decide({ enabled: true, verdict: null, fallbackReason: 'timed out after 1500ms' });
  assert.equal(d.action, ACTIONS.IN_PLACE);
  assert.match(d.reason, /timed out after 1500ms/);
});

test('confidence below the threshold falls back', () => {
  const d = decide({
    enabled: true,
    verdict: { ...goodVerdict, confidence: MIN_CONFIDENCE - 0.01 },
  });
  assert.equal(d.action, ACTIONS.IN_PLACE);
  assert.match(d.reason, /confidence/);
});

test('confidence exactly at the threshold routes', () => {
  const d = decide({ enabled: true, verdict: { ...goodVerdict, confidence: MIN_CONFIDENCE } });
  assert.equal(d.action, ACTIONS.ROUTE);
});

test('a low clarity signal vetoes a confident pick', () => {
  const d = decide({
    enabled: true,
    verdict: { ...goodVerdict, confidence: 0.99, clarity: MIN_CLARITY - 0.01 },
  });
  assert.equal(d.action, ACTIONS.IN_PLACE);
  assert.match(d.reason, /clarity/);
});

test('a mid-conversation short reply is not a standalone job', () => {
  const d = decide({
    enabled: true,
    verdict: { ...goodVerdict, confidence: 0.99, standalone: MIN_STANDALONE - 0.01 },
  });
  assert.equal(d.action, ACTIONS.IN_PLACE);
  assert.match(d.reason, /standalone/);
});

test('cannot_tell always falls back', () => {
  const d = decide({
    enabled: true,
    verdict: { size: null, rawChoice: 'cannot_tell', isCannotTell: true, confidence: 0.5, clarity: 0.5, standalone: 0.9 },
  });
  assert.equal(d.action, ACTIONS.IN_PLACE);
  assert.match(d.reason, /could not tell/);
});

test('a choice outside the four sizes falls back', () => {
  const d = decide({
    enabled: true,
    verdict: { size: null, rawChoice: 'colossal', isCannotTell: false, confidence: 0.9, clarity: 0.9, standalone: 0.9 },
  });
  assert.equal(d.action, ACTIONS.IN_PLACE);
});

test('null confidence falls back rather than being treated as sure', () => {
  const d = decide({ enabled: true, verdict: { ...goodVerdict, confidence: null } });
  assert.equal(d.action, ACTIONS.IN_PLACE);
});

test('an image attachment will not be sent to a text-only model', () => {
  const d = decide({ enabled: true, verdict: goodVerdict, attachmentCount: 1 });
  assert.equal(SIZE_MODEL.tiny.acceptsImages, false);
  assert.equal(d.action, ACTIONS.IN_PLACE);
  assert.match(d.reason, /text only/);
});

test('an image attachment is fine when the mapped model accepts images', () => {
  const d = decide({
    enabled: true,
    verdict: { ...goodVerdict, size: 'everyday' },
    attachmentCount: 1,
  });
  assert.equal(SIZE_MODEL.everyday.acceptsImages, true);
  assert.equal(d.action, ACTIONS.ROUTE);
});

test('every non-routing branch carries a reason for the ledger', () => {
  const cases = [
    { enabled: false, verdict: goodVerdict },
    { enabled: true, verdict: null },
    { enabled: true, verdict: { ...goodVerdict, confidence: 0.1 } },
    { enabled: true, verdict: { ...goodVerdict, clarity: 0.1 } },
    { enabled: true, verdict: { ...goodVerdict, standalone: 0.1 } },
    { enabled: true, verdict: { ...goodVerdict, size: null, isCannotTell: false } },
    { enabled: true, verdict: goodVerdict, attachmentCount: 2 },
  ];
  for (const c of cases) {
    const d = decide(c);
    assert.equal(d.action, ACTIONS.IN_PLACE);
    assert.ok(d.reason && d.reason.length > 0, `reason missing for ${JSON.stringify(c)}`);
  }
});
