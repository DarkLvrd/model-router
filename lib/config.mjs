/**
 * Shared configuration for the model router.
 *
 * Everything the router reads at runtime lives here so the CLI, the Pi
 * extension and the sample harness cannot drift apart.
 *
 * Runtime state (the on/off switch, the counters, the cost ledger) is kept
 * OUTSIDE the repository on purpose:
 *
 *   - the switch must survive a fresh clone, a rebase and a merge, and
 *   - a repo that ships with a stale "ON" switch would silently start
 *     shipping the captain's message text to a third party.
 *
 * Default location is ~/.model-router. Override with MODEL_ROUTER_HOME.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Runtime state paths.
 *
 * These are functions, not constants, on purpose. A module-level constant is
 * resolved the moment the module is first imported, so anything that sets
 * MODEL_ROUTER_HOME after a static import would silently read and write the
 * default location instead — which is how a test tool once wrote its counters
 * into the captain's real ledger. Reading the environment at call time makes
 * that class of mistake impossible.
 */
export function stateDir() {
  return process.env.MODEL_ROUTER_HOME
    ? resolve(process.env.MODEL_ROUTER_HOME)
    : join(homedir(), '.model-router');
}

export function stateFile() {
  return join(stateDir(), 'state.json');
}

export function switchFile() {
  return join(stateDir(), 'enabled');
}

/** TypeSafe System One HTTP endpoint (documented at https://docs.typesafe.ai/api). */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

/**
 * TypeSafe publishes Jev 1.13 pricing as $42 per billion input tokens
 * ($0.042 per million). Output tokens are free.
 * Source: https://docs.typesafe.ai/models — "Price (per Btok / per Mtok) | $42 / $0.042".
 * Any dollar figure this project prints is INFERRED from that published rate.
 */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/**
 * Hard latency budget for the routing decision.
 *
 * The router runs inside Pi's `before_agent_start` hook, which Pi awaits
 * before it starts the turn. That makes per-message switching possible, and
 * it also means every millisecond here is a millisecond the captain waits.
 *
 * The Jev call is therefore raced against a hard timeout. On timeout — or on
 * any error, missing key, unparseable body or non-2xx status — the router
 * gives up and the turn runs exactly as it would with no router installed.
 *
 * There are deliberately NO retries: a retry would blow the budget.
 *
 * Worst case added latency = JEV_TIMEOUT_MS + a few ms of local bookkeeping.
 *
 * The default is set from measurement, not guesswork. Thirty live calls on
 * 2026-09-22 from a single node process (connection warm after the first two
 * calls, 10000ms client timeout) on one short standalone message gave:
 *
 *   min 382ms, median 489ms, p95 1583ms, max 4013ms
 *
 * The first two calls of a fresh process were cold (1583ms and 4013ms) and
 * the steady band was 382-770ms; that 1583ms cold call is the p95. Every warm
 * call already passed under the previous 1500ms cap; what actually failed were
 * the slower and cold calls above it — earlier fresh-process probes of 1371ms
 * and 1414ms, and the 1583ms cold call above. 2500ms clears p95 by ~917ms and
 * rescues everything up to 2500ms, including that 1583ms cold call, while the
 * 4013ms cold call still falls back rather than holding the turn. The real
 * cost of the raise: the worst-case added wait per message rises from 1800ms
 * to 2800ms, and is only paid when a call runs slow.
 *
 * The Pi extension also warms the connection with two throwaway calls when
 * it loads, so the captain's first message is not the one paying the
 * cold-start cost.
 */
export const JEV_TIMEOUT_MS = Number(process.env.MODEL_ROUTER_TIMEOUT_MS ?? 2500);

/** Stated worst-case added latency, used in the status output and the README. */
export const LATENCY_BUDGET_MS = JEV_TIMEOUT_MS + 300;

/**
 * Routing thresholds. A pick only routes when Jev is at least this sure of
 * the size, AND the separate "is this clear enough to act on?" signal agrees,
 * AND the message is a standalone job rather than a conversational follow-up.
 *
 * MIN_CONFIDENCE is the captain's 60%, as specified.
 *
 * MIN_CLARITY is the second signal the brief asks for, instead of trusting the
 * pick's own `confidence` alone. It was calibrated by measurement, not taste —
 * nine live probes on 2026-09-21 gave:
 *
 *   clear requests      clarity 0.50, 0.52, 0.57, 0.94   -> 4/4 must pass
 *   vague requests      clarity 0.03, 0.04, 0.04, 0.05   -> 4/4 must fail
 *   ("do the thing we talked about", "make it better somehow", "thoughts?",
 *    "fix the issue")
 *
 * 0.30 sits in the empty gap between those two clusters. A stricter wording of
 * this question ("could you start this right now?") scored 0.15-0.27 even on
 * clear requests and was rejected for vetoing everything.
 */
export const MIN_CONFIDENCE = 0.6;
export const MIN_CLARITY = 0.3;
export const MIN_STANDALONE = 0.5;

/** Where a spawned helper writes nothing back and reads nothing else. */
export const HELPER_TIMEOUT_MS = Number(process.env.MODEL_ROUTER_HELPER_TIMEOUT_MS ?? 300_000);
