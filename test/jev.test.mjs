/**
 * The Jev client's shape, parsing and failure behaviour — all offline.
 *
 * This is where "it can never slow you down or break the message" is actually
 * proven: a fetch that hangs forever, a 500, a 401, a body of HTML, a body
 * with the wrong shape, and a missing key are all asserted to come back as
 * `{ ok: false }` rather than throw or hang.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSizerRequest, inferredCostUsd, parseSizerResponse, sizeMessage } from '../lib/jev.mjs';
import { CANNOT_TELL, SIZES } from '../lib/sizes.mjs';

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

const GOOD_BODY = {
  model: 'jev-1.13.0',
  answers: {
    job_size: {
      type: 'choice',
      choice: 'large',
      confidence: 0.88,
      probabilities: { tiny: 0, everyday: 0.1, large: 0.88, hardest: 0.02, cannot_tell: 0 },
    },
    size_is_clear: { type: "noul", noul: 0.81 },
    standalone_job: { type: 'noul', noul: 0.93 },
  },
  usage: { input_tokens: 799, output_tokens: 96 },
};

test('the request carries exactly one Choice with the four sizes plus an escape hatch', () => {
  const body = buildSizerRequest('do the thing');
  const q = body.questions.job_size;
  assert.equal(q.type, 'choice');
  const options = Object.keys(q.criteria);
  for (const size of SIZES) assert.ok(options.includes(size), `missing ${size}`);
  assert.ok(options.includes(CANNOT_TELL), 'missing the cannot_tell escape hatch');
  assert.equal(options.length, SIZES.length + 1);
  assert.equal(body.model, 'jev-latest');
});

test('the request carries the two independent signals, not just the pick', () => {
  const body = buildSizerRequest('do the thing');
  assert.equal(body.questions.size_is_clear.type, 'noul');
  assert.equal(body.questions.standalone_job.type, 'noul');
  assert.equal(Object.keys(body.questions).length, 3);
});

test('the message and recent turns reach the state, with control chars stripped', () => {
  const body = buildSizerRequest('hello\u0007 there', { recentTurns: ['user: hi', 'assistant: yo'] });
  assert.equal(body.state.message, 'hello there');
  assert.deepEqual(body.state.recent_conversation, ['user: hi', 'assistant: yo']);
});

test('the stand-alone question reaches the model, not just the state', () => {
  const body = buildSizerRequest('yes do that but make it shorter');
  const instructions = body.questions.standalone_job.instructions;
  assert.match(instructions, /self-contained/);
  assert.match(instructions, /running conversation/);
  assert.ok(body.state.recent_conversation === undefined);
});

test('parses a good body into the shape the rule needs', () => {
  const v = parseSizerResponse(GOOD_BODY);
  assert.equal(v.size, 'large');
  assert.equal(v.confidence, 0.88);
  assert.equal(v.clarity, 0.81);
  assert.equal(v.standalone, 0.93);
  assert.equal(v.inputTokens, 799);
  assert.equal(v.model, 'jev-1.13.0');
});

test('parses the escape hatch without pretending it is a size', () => {
  const v = parseSizerResponse({
    answers: { job_size: { type: 'choice', choice: CANNOT_TELL, confidence: 0.5, probabilities: {} } },
    usage: {},
  });
  assert.equal(v.size, null);
  assert.equal(v.isCannotTell, true);
});

test('a choice outside the four sizes is not silently accepted as a size', () => {
  const v = parseSizerResponse({
    answers: { job_size: { type: 'choice', choice: 'gigantic', confidence: 0.99 } },
    usage: {},
  });
  assert.equal(v.size, null);
  assert.equal(v.isCannotTell, false);
  assert.equal(v.rawChoice, 'gigantic');
});

test('a body with no job_size answer is rejected', () => {
  assert.equal(parseSizerResponse({ answers: {}, usage: {} }), null);
  assert.equal(parseSizerResponse({}), null);
  assert.equal(parseSizerResponse(null), null);
});

test('missing noul answers become null, not zero, so the rule can veto', () => {
  const v = parseSizerResponse({ answers: { job_size: { choice: 'tiny', confidence: 0.9 } }, usage: {} });
  assert.equal(v.clarity, null);
  assert.equal(v.standalone, null);
});

test('cost is inferred from input tokens only, at the published rate', () => {
  // $0.042 per million input tokens.
  assert.equal(inferredCostUsd(1_000_000), 0.042);
  assert.equal(inferredCostUsd(0), 0);
  assert.equal(Number(inferredCostUsd(1000).toFixed(8)), 0.000042);
});

test('a good call resolves ok with tokens and timing', async () => {
  let seenUrl = null;
  const r = await sizeMessage('do the thing', {
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      seenUrl = url;
      return okResponse(GOOD_BODY);
    },
  });
  assert.equal(r.ok, true);
  assert.equal(seenUrl, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(r.verdict.size, 'large');
  assert.equal(r.inputTokens, 799);
  assert.ok(r.ms >= 0);
});

test('a missing key fails without any network call', async () => {
  let called = false;
  const r = await sizeMessage('hi', {
    apiKey: '',
    fetchImpl: async () => {
      called = true;
      return okResponse(GOOD_BODY);
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /API key/);
  assert.equal(called, false);
});

test('an HTTP error fails cleanly and does not leak the body', async () => {
  const r = await sizeMessage('hi', {
    apiKey: 'k',
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'secret stuff' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'HTTP 500');
  assert.equal(r.reason.includes('secret'), false);
});

test('an unparseable body fails cleanly', async () => {
  const r = await sizeMessage('hi', {
    apiKey: 'k',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unparseable/);
});

test('a body with no usable answer fails cleanly', async () => {
  const r = await sizeMessage('hi', {
    apiKey: 'k',
    fetchImpl: async () => okResponse({ answers: {}, usage: {} }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no usable job_size/);
});

test('a network throw fails cleanly instead of propagating', async () => {
  const r = await sizeMessage('hi', {
    apiKey: 'k',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /request failed/);
});

test('a hanging call is cut off by the timeout, not waited on', async () => {
  const started = Date.now();
  const r = await sizeMessage('hi', {
    apiKey: 'k',
    timeoutMs: 60,
    // Emulates a socket that never answers: only the abort signal ends it.
    fetchImpl: (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'TimeoutError';
          reject(err);
        });
      }),
  });
  const elapsed = Date.now() - started;
  assert.equal(r.ok, false);
  assert.match(r.reason, /timed out/);
  assert.ok(elapsed < 1000, `took ${elapsed}ms, expected the 60ms cap to end it`);
});
