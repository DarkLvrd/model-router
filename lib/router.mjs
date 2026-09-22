/**
 * The router: size one message, decide where it goes, remember what happened.
 *
 * This is the single entry point both the Pi extension and the CLI call.
 * It is written to be safe to call on every message:
 *
 *   - it returns quickly and always resolves,
 *   - it never throws,
 *   - it records to the ledger before resolving, so a counter can never be
 *     lost to the process exiting right after a turn (`record: false` skips it),
 *   - when the switch is OFF it makes no network call at all.
 */

import { LATENCY_BUDGET_MS } from './config.mjs';
import { recordDecision, recordJevCall } from './ledger.mjs';
import { decide } from './policy.mjs';
import { sizeMessage } from './jev.mjs';
import { isEnabled } from './switch.mjs';

/**
 * Size and route one message.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]        override the switch (used by tests)
 * @param {number} [opts.attachmentCount]
 * @param {string[]} [opts.recentTurns]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.record]         write to the ledger (default true)
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{decision: object, jev: object|null, ms: number}>}
 */
export async function route(text, opts = {}) {
  const started = Date.now();
  const enabled = opts.enabled ?? isEnabled();

  // Off, or nothing to size: today's behaviour, zero network, zero delay.
  if (!enabled) {
    const decision = decide({ enabled: false, verdict: null });
    if (opts.record !== false) recordDecision(decision);
    return { decision, jev: null, ms: Date.now() - started };
  }

  if (typeof text !== 'string' || text.trim() === '') {
    const decision = decide({ enabled: true, verdict: null, fallbackReason: 'empty message' });
    if (opts.record !== false) recordDecision(decision);
    return { decision, jev: null, ms: Date.now() - started };
  }

  const jev = await sizeMessage(text, {
    timeoutMs: opts.timeoutMs,
    recentTurns: opts.recentTurns,
    fetchImpl: opts.fetchImpl,
  });

  const decision = decide({
    enabled: true,
    verdict: jev.ok ? jev.verdict : null,
    attachmentCount: opts.attachmentCount ?? 0,
    fallbackReason: jev.ok ? null : jev.reason,
  });

  // Recorded before resolving, not scheduled for later.
  //
  // This used to be deferred with setImmediate to keep disk work out of the
  // turn's path. That lost counters outright whenever Pi exited as soon as the
  // turn finished (print mode did exactly that), so `status` could read zero
  // after messages that really were routed. The write is a sub-millisecond
  // local write of a ~1KB file, well inside the latency budget's allowance for
  // local bookkeeping, and a status that silently under-counts is worse. Every
  // write is best-effort and swallows its own errors, so it still cannot fail
  // a turn.
  if (opts.record !== false) {
    recordJevCall(jev);
    recordDecision(decision);
  }

  return { decision, jev, ms: Date.now() - started };
}

export { LATENCY_BUDGET_MS };
