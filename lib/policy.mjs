/**
 * The routing rule, as a pure function.
 *
 * The captain's rule, restated:
 *
 *   Route to the matching helper when ALL of these hold:
 *     - the switch is ON
 *     - Jev picked one of the four sizes (not `cannot_tell`)
 *     - Jev's confidence in that pick is >= 60%
 *     - the independent clarity signal agrees (>= 0.3)
 *     - the message is a standalone job, not a mid-conversation reply (>= 0.5)
 *     - the mapped model can accept anything attached to the message
 *
 *   Otherwise firstmate handles the message in place, exactly as it does
 *   today: no model switch, no extra call, no visible difference.
 *
 * Pure on purpose. Every branch that decides "do not route" is testable
 * without a network call, and every such branch carries a `reason` that the
 * status ledger records, so the fallback count is always explainable.
 */

import { MIN_CLARITY, MIN_CONFIDENCE, MIN_STANDALONE } from './config.mjs';
import { SIZE_MODEL } from './sizes.mjs';

export const ACTIONS = {
  ROUTE: 'route',
  IN_PLACE: 'in_place',
};

/**
 * @param {object} input
 * @param {boolean} input.enabled            is the router switched on?
 * @param {object|null} input.verdict        parsed Jev verdict, or null if the call failed
 * @param {number} [input.attachmentCount]   number of attached images
 * @param {string} [input.fallbackReason]    why the Jev call failed, when verdict is null
 * @returns {{action: string, size: string|null, model: string|null, reason: string}}
 */
export function decide({ enabled, verdict, attachmentCount = 0, fallbackReason = null }) {
  if (!enabled) {
    return inPlace('router is off');
  }

  if (!verdict) {
    return inPlace(fallbackReason ? `jev unavailable: ${fallbackReason}` : 'jev unavailable');
  }

  if (verdict.isCannotTell || !verdict.size) {
    return inPlace(`jev could not tell (chose "${verdict.rawChoice}")`);
  }

  if (verdict.confidence === null || verdict.confidence < MIN_CONFIDENCE) {
    return inPlace(
      `confidence ${fmt(verdict.confidence)} below ${MIN_CONFIDENCE}`,
    );
  }

  if (verdict.clarity === null || verdict.clarity < MIN_CLARITY) {
    return inPlace(
      `request too unclear (clarity ${fmt(verdict.clarity)} below ${MIN_CLARITY})`,
    );
  }

  if (verdict.standalone === null || verdict.standalone < MIN_STANDALONE) {
    return inPlace(
      `not a standalone job (standalone ${fmt(verdict.standalone)})`,
    );
  }

  const model = SIZE_MODEL[verdict.size];
  if (!model) {
    return inPlace(`no model mapped for size "${verdict.size}"`);
  }

  if (attachmentCount > 0 && !model.acceptsImages) {
    // Switching would break the message. Send it nowhere and let today's
    // model handle it; a wrong-but-cheap answer the captain cannot use is
    // worse than a slightly dearer answer that works.
    return inPlace(
      `${attachmentCount} image attachment(s) but ${model.id} accepts text only`,
    );
  }

  return {
    action: ACTIONS.ROUTE,
    size: verdict.size,
    model: model.id,
    reason: `jev picked ${verdict.size} at confidence ${fmt(verdict.confidence)}`,
  };
}

function inPlace(reason) {
  return { action: ACTIONS.IN_PLACE, size: null, model: null, reason };
}

function fmt(v) {
  return typeof v === 'number' ? v.toFixed(2) : 'n/a';
}
