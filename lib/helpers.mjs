/**
 * The helpers — one per size, each running on that size's mapped model.
 *
 * There are two ways the user's message reaches a helper, and they are
 * different things. Both are built here; the README says plainly which one
 * is automatic.
 *
 * ## 1. In-session helper (what the Pi extension uses — automatic)
 *
 * The Pi extension switches the running session onto the mapped model with
 * `pi.setModel()` before the turn starts, and injects that size's helper
 * contract into the system prompt for that turn. The helper is the Pi agent
 * itself, retargeted. This is the path that runs on every message with no
 * extra process and no extra latency beyond the Jev call.
 *
 * What the user gives up: the cheap model sees the running session's own
 * history, not a fresh context. There is no context isolation. The "end your
 * reply with the model line" instruction is a prompt, so it is requested
 * rather than guaranteed.
 *
 * ## 2. Spawned helper (used by `model-router route` and by the tests)
 *
 * A real, separate `pi` process per size:
 *
 *   pi -p --model deepseek/deepseek-v4-pro --append-system-prompt '<contract>' '<message>'
 *
 * This is genuine per-size isolation and its model line is appended in code,
 * so it is guaranteed. It costs a process start and a fresh context, which is
 * why it is not the per-message path.
 */

import { spawn } from 'node:child_process';
import { HELPER_TIMEOUT_MS } from './config.mjs';
import { SIZE_MODEL, modelRef } from './sizes.mjs';

export const MODEL_LINE_PREFIX = 'Model:';

/** A short line stating which model did the work. Always the last line. */
export function modelLine(modelId) {
  return `${MODEL_LINE_PREFIX} ${modelId}`;
}

/**
 * The per-size persona, as injected system-prompt text.
 * Kept small: it is prepended to every routed turn.
 */
export const HELPER_CONTRACTS = {
  tiny:
    'You are the tiny-job helper. The job was sized as small and is running on a small, cheap model on ' +
    'purpose. Answer directly and briefly. No preamble, no restating the question, no summary.',
  everyday:
    'You are the everyday-job helper. The job was sized as ordinary writing or light judgement and is ' +
    'running on a mid-small model on purpose. Write it properly and completely, without research or ' +
    'multi-step planning.',
  large:
    'You are the large-job helper. The job was sized as multi-step work — a build, research, or a full ' +
    'report. Plan it, work through the steps, and show the result.',
  hardest:
    'You are the hardest-job helper. The job was sized as high stakes, where a wrong call is expensive. ' +
    'Take the time to get it right, state your assumptions, and flag anything you are not sure of.',
};

/** The trailing instruction that makes the helper name its own model. */
export function helperContract(size) {
  const model = SIZE_MODEL[size];
  const base = HELPER_CONTRACTS[size] ?? '';
  return [
    base,
    `You are running on ${model.id}.`,
    `End your reply with exactly one final line, and nothing after it: "${modelLine(model.id)}"`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Ensure a helper's reply ends with the model line. Deterministic, code-side. */
export function ensureModelLine(text, modelId) {
  const body = String(text ?? '').replace(/\s+$/, '');
  const line = modelLine(modelId);
  const lastLine = body.split('\n').pop()?.trim() ?? '';
  if (lastLine === line) return `${body}\n`;

  // Drop any model line the agent already wrote so there is exactly one.
  const lines = body.split('\n').filter((l) => !l.trim().startsWith(MODEL_LINE_PREFIX));
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return [...lines, '', line].join('\n') + '\n';
}

/**
 * Environment for a spawned helper.
 *
 * Pi exports PI_SESSION_ID / PI_SESSION_FILE / PI_MODEL / PI_PROVIDER /
 * PI_REASONING_LEVEL / PI_CODING_AGENT so that shell commands run *inside* Pi
 * can see the session they belong to. A helper is not that: it is a separate
 * fresh context on a deliberately chosen model. Letting it inherit those would
 * tell it it is part of the user's session and which model the user is
 * on, which is exactly what the router is deciding. So they are stripped.
 * Everything else — including the provider API keys and the user's own
 * settings.json defaults — is passed through untouched.
 */
export function helperEnv(base = process.env) {
  const env = { ...base };
  for (const key of [
    'PI_SESSION_ID',
    'PI_SESSION_FILE',
    'PI_MODEL',
    'PI_PROVIDER',
    'PI_REASONING_LEVEL',
    'PI_CODING_AGENT',
  ]) {
    delete env[key];
  }
  return env;
}

/** The argv a helper is started with. Exported so tests can assert it. */
export function helperArgs(size, message) {
  return [
    '-p',
    '--model',
    modelRef(size),
    '--append-system-prompt',
    helperContract(size),
    '--',
    message,
  ];
}

/**
 * Run one message through a real spawned helper on its mapped model.
 *
 * Never throws. If the helper cannot be started at all, the caller gets
 * `{ ok: false, reason }` and is expected to fall back rather than fail the
 * message.
 *
 * Started with `spawn`, not `execFile`, on purpose. `execFile` always gives
 * the child a piped stdin, and a nested `pi` given a pipe on stdin never
 * starts: it sat silent until killed in every combination tried. With
 * `stdio: ['ignore', 'pipe', 'pipe']` it answers normally. That was measured,
 * not assumed.
 *
 * @param {string} size
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.piBin]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
export function spawnHelper(size, message, opts = {}) {
  const model = SIZE_MODEL[size];
  if (!model) {
    return Promise.resolve({ ok: false, reason: `no model mapped for size "${size}"` });
  }

  const piBin = opts.piBin ?? process.env.MODEL_ROUTER_PI_BIN ?? 'pi';
  const timeoutMs = opts.timeoutMs ?? HELPER_TIMEOUT_MS;
  const started = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(piBin, helperArgs(size, message), {
        cwd: opts.cwd ?? process.cwd(),
        env: opts.env ?? helperEnv(),
        // stdin MUST NOT be a pipe, or the nested pi waits forever. See above.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({ ok: false, reason: `helper could not be started: ${err?.message ?? err}`, ms: Date.now() - started });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      resolve({ ok: false, reason: `helper timed out after ${timeoutMs}ms`, ms: Date.now() - started });
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
      opts.onStderr?.(String(d));
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: `helper could not be started: ${err?.message ?? err}`, ms: Date.now() - started });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code !== 0) {
        return resolve({ ok: false, reason: `helper exited with code ${code}`, ms, stderr: stderr.slice(0, 2000) });
      }
      const text = stdout.trim();
      if (!text) return resolve({ ok: false, reason: 'helper produced no output', ms, stderr: stderr.slice(0, 2000) });
      resolve({ ok: true, size, model: model.id, text: ensureModelLine(text, model.id), ms });
    });
  });
}

/** What `status` prints so the mapping is visible at a glance. */
export function helperSummary() {
  return Object.entries(SIZE_MODEL).map(([size, m]) => ({
    size,
    model: m.id,
    ref: `${m.provider}/${m.id}`,
    acceptsImages: m.acceptsImages,
  }));
}
