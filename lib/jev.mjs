/**
 * The Jev sizer.
 *
 * One HTTP call, one question set, three independent judgments that run in
 * parallel inside TypeSafe:
 *
 *   1. `job_size`      — Choice over the captain's four sizes + `cannot_tell`.
 *   2. `size_is_clear` — Noul: is the request clear enough to act on, or is it
 *                        vague and would take guessing?
 *   3. `standalone_job` — Noul: is this a self-contained job, or a follow-up
 *                        reply that only means something mid-conversation?
 *
 * Why three questions and not one. This fleet has already measured Jev on
 * forced choices: it never abstains and it reports high `confidence` on a
 * choice it was forced into. So the pick's own `confidence` is treated as a
 * hint, not as authority. The routing rule needs an independent signal to
 * agree before a message is allowed to change models, and it needs the
 * standalone signal to catch "yes do that but make it shorter" — which is a
 * real message, a well-formed Choice, and not a job.
 *
 * Both extra signals are measured, not assumed. On nine live probes the
 * clarity question scored 0.50-0.94 on clear requests and 0.03-0.05 on vague
 * ones, with nothing in between; the four vague ones all came back
 * `cannot_tell` as well, which is the escape hatch doing its job.
 *
 * All three questions share one request, so this costs one round trip, not
 * three: TypeSafe evaluates questions against the same `state` in parallel.
 *
 * Nothing from Jev is ever treated as final.
 */

import {
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  JEV_USD_PER_INPUT_TOKEN,
} from './config.mjs';
import { CANNOT_TELL, SIZE_CRITERIA, SIZES } from './sizes.mjs';

/** Strip control characters that would corrupt a JSON body. */
function mask(text) {
  return String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/**
 * Build the request body. Exported so unit tests can assert the shape
 * without spending tokens or hitting the network.
 *
 * @param {string} text  the captain's message
 * @param {object} [opts]
 * @param {string[]} [opts.recentTurns]  recent conversation turns, newest last
 * @param {string} [opts.model]
 */
export function buildSizerRequest(text, opts = {}) {
  const recent = (opts.recentTurns ?? []).map(mask).filter(Boolean).slice(-6);

  const state = {
    task:
      'Pick the smallest model that can do this job well. The captain wants small jobs handled by ' +
      'smaller, cheaper models and only genuinely hard jobs sent to the biggest one. Judge the job, ' +
      'not how long the message is.',
    message: mask(text),
  };
  if (recent.length) {
    state.recent_conversation = recent;
  }

  return {
    model: opts.model ?? JEV_MODEL,
    state,
    questions: {
      job_size: {
        type: 'choice',
        instructions:
          'Size up `message` on its own. Which of the sizes in the criteria is the smallest one that ' +
          'can still do this job well? Judge the work the message asks for, not its length or its tone. ' +
          'Answer `cannot_tell` when `message` genuinely does not contain enough to choose between the sizes.',
        criteria: SIZE_CRITERIA,
      },
      size_is_clear: {
        type: 'noul',
        instructions:
          'Is the request in `message` clear enough to tell what work it is asking for? Answer no if it ' +
          'is vague, ambiguous, refers to something not present, or you would be guessing at what is ' +
          'being asked.',
        criteria: {
          true: 'The work being asked for is identifiable from the message itself.',
          false: 'Vague, ambiguous, refers to something absent, or would take guessing what is meant.',
        },
      },
      standalone_job: {
        type: 'noul',
        instructions:
          'Is `message` a self-contained piece of work that makes sense and can be completed on its own? ' +
          'A short reply that only means something as part of the running conversation — an answer like ' +
          '"yes do that but make it shorter", a correction, or a follow-up to something just said — is not ' +
          'a self-contained job.',
        criteria: {
          true: 'Readable and actionable on its own, without the previous turns.',
          false: 'Only makes sense as part of the running conversation, or depends on what was just said.',
        },
      },
    },
  };
}

/**
 * Parse an answer body into the small shape the router needs.
 * Returns null when the body does not carry a usable verdict, so the caller
 * falls back rather than acting on a guess.
 */
export function parseSizerResponse(body) {
  const size = body?.answers?.job_size;
  if (!size || typeof size.choice !== 'string') return null;

  const choice = size.choice;

  return {
    size: SIZES.includes(choice) ? choice : null,
    rawChoice: choice,
    isCannotTell: choice === CANNOT_TELL,
    confidence: typeof size.confidence === 'number' ? size.confidence : null,
    probabilities: size.probabilities ?? null,
    clarity: numOrNull(body?.answers?.size_is_clear?.noul),
    standalone: numOrNull(body?.answers?.standalone_job?.noul),
    model: typeof body?.model === 'string' ? body.model : null,
    inputTokens: body?.usage?.input_tokens ?? 0,
    outputTokens: body?.usage?.output_tokens ?? 0,
  };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Inferred dollar cost of a Jev call. Output tokens are free; the label is deliberate. */
export function inferredCostUsd(inputTokens) {
  return (Number(inputTokens) || 0) * JEV_USD_PER_INPUT_TOKEN;
}

/**
 * Ask Jev to size one message.
 *
 * Never throws. Never retries. Always resolves — on failure the caller gets
 * `{ ok: false, reason }` and the turn proceeds untouched.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.apiKey]       defaults to process.env.TYPESAFE_API_KEY
 * @param {number} [opts.timeoutMs]
 * @param {string[]} [opts.recentTurns]
 * @param {typeof fetch} [opts.fetchImpl]  injectable for tests
 * @returns {Promise<{ok: true, verdict: object, ms: number, inputTokens: number, outputTokens: number, jevModel: string|null}
 *                 | {ok: false, reason: string, ms: number, inputTokens: number, outputTokens: number}>}
 */
export async function sizeMessage(text, opts = {}) {
  const started = Date.now();
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  const timeoutMs = opts.timeoutMs ?? JEV_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  if (!apiKey) {
    return fail('no API key (TYPESAFE_API_KEY is not set)', started);
  }
  if (typeof doFetch !== 'function') {
    return fail('no fetch implementation available', started);
  }

  const body = buildSizerRequest(text, { recentTurns: opts.recentTurns, model: opts.model });

  let res;
  try {
    res = await doFetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Hard ceiling. No retry: a retry cannot fit inside the budget.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err?.name ?? '';
    const reason =
      name === 'TimeoutError' || name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : `request failed: ${err?.message ?? String(err)}`;
    return fail(reason, started);
  }

  if (!res.ok) {
    // Deliberately do not log the response body: it can echo request content.
    return fail(`HTTP ${res.status}`, started);
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    return fail(`unparseable response: ${err?.message ?? String(err)}`, started);
  }

  const verdict = parseSizerResponse(json);
  const inputTokens = verdict?.inputTokens ?? 0;
  const outputTokens = verdict?.outputTokens ?? 0;

  if (!verdict) {
    return { ok: false, reason: 'response had no usable job_size answer', ms: Date.now() - started, inputTokens, outputTokens };
  }

  return {
    ok: true,
    verdict,
    ms: Date.now() - started,
    inputTokens,
    outputTokens,
    jevModel: verdict.model,
  };
}

function fail(reason, started) {
  return { ok: false, reason, ms: Date.now() - started, inputTokens: 0, outputTokens: 0 };
}
