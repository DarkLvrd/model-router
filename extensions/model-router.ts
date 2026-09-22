/**
 * model-router — a Pi extension that sizes each message with Jev and switches
 * the session onto the smallest model that can do the job.
 *
 * ## How the captain's messages reach this
 *
 * Pi emits `before_agent_start` after the captain submits a prompt and
 * BEFORE it starts the agent turn. Pi awaits the hook, so anything done here
 * — including `pi.setModel()` — applies to the message being sent right now.
 * Verified in the installed Pi source: `dist/core/agent-session.js` awaits
 * `emitBeforeAgentStart(...)` and only then calls `_runAgentPrompt(messages)`.
 *
 * That makes this genuinely automatic and genuinely per-message. It is not a
 * discipline anyone has to remember.
 *
 * ## Never slow the captain down
 *
 *   - switch OFF  -> this returns immediately and makes no network call
 *   - switch ON   -> one Jev call, hard-capped at JEV_TIMEOUT_MS (default
 *                    2500ms, measured warm 382-770ms), then:
 *                      - routed: setModel + helper contract, turn proceeds
 *                      - anything else: return undefined, turn proceeds
 *                        exactly as it would with no router installed
 *   - the ledger write is a sub-millisecond local file write inside the stated
 *     budget, done before the hook returns so a counter can never be lost to
 *     Pi exiting as soon as the turn ends
 *
 * Nothing in this file can fail the turn: every path is wrapped, and the
 * failure path is "return undefined".
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Resolve lib/ next to this extension, or via MODEL_ROUTER_DIR. */
async function loadLib() {
  const root = process.env.MODEL_ROUTER_DIR ?? join(HERE, '..');
  const lib = (name) => import(pathToFileURL(join(root, 'lib', name)).href);
  const [router, helpers, sw, ledger, config] = await Promise.all([
    lib('router.mjs'),
    lib('helpers.mjs'),
    lib('switch.mjs'),
    lib('ledger.mjs'),
    lib('config.mjs'),
  ]);
  return { router, helpers, sw, ledger, config };
}

export default async function modelRouterExtension(pi) {
  let lib;
  try {
    lib = await loadLib();
  } catch (err) {
    // Without the library the router cannot run. Say so once, then get out of
    // the way completely.
    pi.on('before_agent_start', async () => undefined);
    pi.registerCommand?.('router', {
      description: 'Model router status (extension failed to load)',
      handler: async (_args, ctx) => {
        ctx.ui.notify(`model-router: failed to load lib: ${err?.message ?? err}`, 'error');
      },
    });
    return;
  }

  const { router, helpers, sw, ledger, config } = lib;

  // Warm the Jev connection once, only when the switch is ON, so the
  // captain's first messages are not the ones that pay the cold-start cost.
  // Measured: the first TWO calls from a fresh process take ~2s each, then
  // everything is warm at 410-797ms. Fire and forget — a failure here is
  // irrelevant, and nothing waits on it.
  if (sw.isEnabled()) {
    import(pathToFileURL(join(HERE, '..', 'lib', 'jev.mjs')).href)
      .then(async ({ sizeMessage }) => {
        await sizeMessage('warmup', { timeoutMs: 10_000 }).catch(() => {});
        await sizeMessage('warmup', { timeoutMs: 10_000 }).catch(() => {});
      })
      .catch(() => {});
  }

  pi.on('before_agent_start', async (event, ctx) => {
    let enabled = false;
    try {
      enabled = sw.isEnabled();
    } catch {
      return undefined;
    }
    if (!enabled) return undefined;

    const prompt = event?.prompt;
    if (typeof prompt !== 'string' || prompt.trim() === '') return undefined;
    // Never route a slash command; the captain is driving, not asking.
    if (prompt.trimStart().startsWith('/')) return undefined;

    try {
      const { decision } = await router.route(prompt, {
        enabled: true,
        attachmentCount: Array.isArray(event?.images) ? event.images.length : 0,
        recentTurns: recentTurnsFrom(ctx),
      });

      if (decision.action !== 'route' || !decision.size) return undefined;

      const model = findModel(ctx, decision);
      if (!model) return undefined;

      const switched = await pi.setModel(model);
      if (!switched) return undefined;

      return {
        systemPrompt: `${event.systemPrompt}\n\n${helpers.helperContract(decision.size)}`,
      };
    } catch {
      // Anything at all goes wrong: carry on as if the router was not there.
      return undefined;
    }
  });

  pi.registerCommand?.('router', {
    description: 'Model router: status, on, off',
    handler: async (args, ctx) => {
      const cmd = String(args ?? '').trim().toLowerCase();
      try {
        if (cmd === 'on') {
          sw.enable();
          ctx.ui.notify('model-router ON — messages are sized by Jev and routed. Message text is sent to TypeSafe while this is on.', 'warning');
          return;
        }
        if (cmd === 'off') {
          sw.disable();
          ctx.ui.notify('model-router OFF — every message runs on your own model. Nothing is sent to TypeSafe.', 'info');
          return;
        }
        if (cmd === 'reset') {
          ledger.resetState();
          ctx.ui.notify('model-router counters reset.', 'info');
          return;
        }
        ctx.ui.notify(formatStatus(sw, ledger, config), 'info');
      } catch (err) {
        ctx.ui.notify(`model-router: ${err?.message ?? err}`, 'error');
      }
    },
  });
}

/**
 * Look the mapped model up in the registry.
 *
 * `pi.setModel` wants a Model object, not an id (verified: the API type is
 * `setModel(model: Model<any>): Promise<boolean>`). If the lookup fails for
 * any reason this returns null and the caller falls back — always safe.
 */
function findModel(ctx, decision) {
  const registry = ctx?.modelRegistry;
  if (!registry || typeof registry.find !== 'function') return null;
  const id = String(decision.model ?? '').replace(/^deepseek\//, '');
  for (const [provider, modelId] of [
    ['deepseek', id],
    ['deepseek', String(decision.model ?? '')],
  ]) {
    try {
      const found = registry.find(provider, modelId);
      if (found) return found;
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

/**
 * Last few turns, trimmed hard, for the "is this standalone?" judgment.
 * Best-effort only: if the entry shape is not what we expect we send no
 * context and Jev simply has less to go on.
 */
function recentTurnsFrom(ctx) {
  try {
    const entries = ctx?.sessionManager?.getEntries?.();
    if (!Array.isArray(entries)) return [];
    const out = [];
    for (const entry of entries.slice(-12)) {
      const m = entry?.message ?? (entry?.type === 'message' ? entry : null);
      if (!m?.role) continue;
      const content = m.content;
      const text = Array.isArray(content)
        ? content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ')
        : typeof content === 'string'
          ? content
          : '';
      if (text) out.push(`${m.role}: ${String(text).slice(0, 400)}`);
    }
    return out.slice(-6);
  } catch {
    return [];
  }
}

function formatStatus(sw, ledger, config) {
  const enabled = sw.isEnabled();
  const s = ledger.readState();
  const perSize = Object.entries(s.routed)
    .map(([size, n]) => `${size}=${n}`)
    .join(' ');
  return [
    `model-router is ${enabled ? 'ON' : 'OFF'}`,
    `routed: ${perSize}`,
    `handled in place: ${s.inPlace}`,
    `jev calls: ${s.jev.calls} (${s.jev.failures} failed), ~$${s.jev.inferredCostUsd.toFixed(4)} inferred`,
    `state: ${ledger.statePath()}`,
    `budget: ${config.LATENCY_BUDGET_MS}ms worst case while ON`,
  ].join('\n');
}
