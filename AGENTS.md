# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Commands

```bash
npm test                          # 58 offline tests (rule, ledger, switch, parser, failure modes)
node test/switch-canary.mjs       # asserts the router ships OFF and OFF means no network
node bin/router.mjs test-samples  # the live 10-message Jev run; spends tokens, writes evidence/
node tools/replay-evidence.mjs    # replay the last evidence run into a throwaway ledger and print status
```

## Sharp edges

- **A nested `pi` must not be given a piped stdin.** `execFile` always pipes stdin, and a
  child `pi` given a pipe never starts — it sat silent until killed in every combination
  tried. Use `spawn` with `stdio: ['ignore', 'pipe', 'pipe']`. See `spawnHelper` in
  `lib/helpers.mjs`, and `helperEnv` for the `PI_*` variables a helper must not inherit.
- **Runtime state paths are functions, not constants.** `stateDir()` / `stateFile()` /
  `switchFile()` in `lib/config.mjs` read `MODEL_ROUTER_HOME` at call time. Anything that
  sets that env var must do so *before* importing the lib, and imports inside tools and
  tests are therefore dynamic. A module-level constant once caused a test tool to write its
  counters into the captain's real ledger.
- **The router ships OFF and that is load-bearing.** The switch is the existence of
  `~/.model-router/enabled`; absent means off. Never make ON the default, and never write
  state into the repository.

## Install and runtime

- The captain's Pi loads this extension as a user package installed by
  `pi install /Users/mac/firstmate/projects/model-router`. That records a **path reference,
  not a copy**, so the live extension is whatever working tree sits in the primary
  checkout: a change living only in a worktree is not live until it reaches `main` there.
- `pi install` does not link package `bin` entries and `bin/router.mjs` is not chmod +x, so
  the machine-independent shell form is `node bin/router.mjs <cmd>`. On this machine
  `model-router` also resolves, via the shim at `~/.local/bin/model-router` that execs the
  same file from the primary checkout (added after this install; the README install section
  documents it). Inside Pi the surface is `/router`; the variants are `on`, `off`, `reset`,
  bare for status.
- **`pi list` succeeding does not prove the command exists.** `router` is registered at
  load time by `pi.registerCommand`, so verify headlessly by driving `pi --mode rpc` and
  sending `{"type":"get_commands"}`: the entry must carry `"origin":"package"` and the
  installed path, not an `-e` path. RPC is the vehicle because `ctx.hasUI` is false under
  `-p`, where `notify` is silently dropped.
- Worked example, with exact commands and output: `evidence/install-verification.md`.

## Where things live

- Routing rule, as a pure function with every veto branch testable: `lib/policy.mjs`.
- Thresholds and the measurements they were calibrated from: `lib/config.mjs`.
- The size → model mapping and the stated basis for the order (including where two models
  are genuinely equivalent): `lib/sizes.mjs`.
- Why per-message switching is automatic here (`before_agent_start` is awaited before the
  agent run, so `pi.setModel()` applies to the current turn): the header comment in
  `extensions/model-router.ts`.
- Captain-facing behaviour, privacy and the honest limits of this design: `README.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
