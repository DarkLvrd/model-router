/**
 * The on/off switch.
 *
 * Ships OFF. The switch is a file whose existence means ON:
 *
 *   ~/.model-router/enabled
 *
 * Absent file -> OFF. That is the default on a fresh clone, after a rebase,
 * and after any error while reading it. The only way to turn the router on is
 * `model-router on`, which is a deliberate act by the captain.
 *
 * Reading is intentionally tiny and synchronous: the extension calls this at
 * the top of every message, and it must never be the reason a message waits.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { switchFile } from './config.mjs';

/** True only when the switch file exists. Any error reads as OFF. */
export function isEnabled() {
  try {
    return existsSync(switchFile());
  } catch {
    return false;
  }
}

export function enable() {
  const file = switchFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      `model-router enabled at ${new Date().toISOString()}`,
      'While this file exists, message text is sent to the Jev vendor (TypeSafe) to be sized.',
      'Remove it with: model-router off',
      '',
    ].join('\n'),
  );
  return file;
}

export function disable() {
  try {
    rmSync(switchFile(), { force: true });
  } catch {
    /* already off */
  }
  return switchFile();
}

export function switchPath() {
  return switchFile();
}
