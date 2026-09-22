/**
 * The counters and the cost ledger.
 *
 * Persisted to ~/.model-router/state.json so the status survives a restart of
 * Pi, a reboot, and a fresh clone of this repo.
 *
 * Records, per size: how many messages went there. Plus: how many messages
 * fell back and why, how many Jev calls were made, how many of them failed,
 * the tokens they used, the wall time they cost, and the dollar figure
 * INFERRED from TypeSafe's published rate.
 *
 * Writes are atomic (write a temp file, then rename) and best-effort: a
 * ledger that cannot be written must never break a message. Every mutation
 * swallows its own errors and returns what it has.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inferredCostUsd } from './jev.mjs';
import { SIZES } from './sizes.mjs';
import { stateFile } from './config.mjs';

export const EMPTY_STATE = Object.freeze({
  version: 1,
  messagesSeen: 0,
  routed: { tiny: 0, everyday: 0, large: 0, hardest: 0 },
  routedToModel: {},
  inPlace: 0,
  inPlaceReasons: {},
  jev: {
    calls: 0,
    failures: 0,
    failureReasons: {},
    inputTokens: 0,
    outputTokens: 0,
    wallMs: 0,
    /** INFERRED from TypeSafe's published $0.042 / Mtok input rate. Output is free. */
    inferredCostUsd: 0,
  },
  firstAt: null,
  lastAt: null,
});

export function statePath() {
  return stateFile();
}

export function emptyState() {
  return JSON.parse(JSON.stringify(EMPTY_STATE));
}

/** Read the ledger. A missing or corrupt file reads as a fresh ledger. */
export function readState() {
  try {
    const raw = readFileSync(stateFile(), 'utf8');
    const parsed = JSON.parse(raw);
    // Shallow-merge onto a fresh state so a file written by an older version
    // still loads instead of throwing away the counters.
    return mergeDeep(emptyState(), parsed);
  } catch {
    return emptyState();
  }
}

export function writeState(state) {
  try {
    const file = stateFile();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.state.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Read, mutate, write, return the new copy. Best-effort. */
export function update(fn) {
  const state = readState();
  const next = fn(state) ?? state;
  writeState(next);
  return next;
}

/** Record a Jev call outcome (success or failure). */
export function recordJevCall(result) {
  return update((s) => {
    const now = new Date().toISOString();
    s.firstAt ??= now;
    s.lastAt = now;
    s.jev.calls += 1;
    s.jev.wallMs += Math.max(0, result.ms ?? 0);
    if (result.ok) {
      s.jev.inputTokens += result.inputTokens ?? 0;
      s.jev.outputTokens += result.outputTokens ?? 0;
      // Derived from the running token total rather than accumulated per call.
      // Adding already-rounded per-call costs drifts (it made the replayed test
      // total read $0.000410 against the harness's $0.000411), and the published
      // rate is linear in input tokens, so deriving it here is exact.
      s.jev.inferredCostUsd = inferredCostUsd(s.jev.inputTokens);
    } else {
      s.jev.failures += 1;
      const reason = String(result.reason ?? 'unknown');
      s.jev.failureReasons[reason] = (s.jev.failureReasons[reason] ?? 0) + 1;
    }
    return s;
  });
}

/** Record what the router decided for one message. */
export function recordDecision(decision) {
  return update((s) => {
    const now = new Date().toISOString();
    s.firstAt ??= now;
    s.lastAt = now;
    s.messagesSeen += 1;

    if (decision.action === 'route' && SIZES.includes(decision.size)) {
      s.routed[decision.size] += 1;
      const key = decision.model ?? decision.size;
      s.routedToModel[key] = (s.routedToModel[key] ?? 0) + 1;
    } else {
      s.inPlace += 1;
      const reason = String(decision.reason ?? 'unknown');
      s.inPlaceReasons[reason] = (s.inPlaceReasons[reason] ?? 0) + 1;
    }
    return s;
  });
}

export function resetState() {
  const fresh = emptyState();
  writeState(fresh);
  return fresh;
}

function mergeDeep(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      mergeDeep(base[k], v);
    } else if (v !== undefined) {
      base[k] = v;
    }
  }
  return base;
}
