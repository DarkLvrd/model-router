# Install verification — model-router as a Pi extension

Captain's brief: install the router so `/router` exists in his Pi sessions and it stays
**OFF** until he turns it on. No code was changed; nothing needed to be.

- Installed at: 2026-09-22 (machine clock `Sep 21 23:12` local)
- Repo commit at install time: `c267ee504789dfcacf74bde59de6137eef9d1283`
- Installed from: `/Users/mac/firstmate/projects/model-router` (the primary checkout)
- Pi version: `0.85.1`, at `/Users/mac/.local/share/pi-node/node-v22.23.2-darwin-arm64/bin/pi`
- Outcome: **installed, loaded, `/router` registered, OFF, left OFF.**

## 1. Install

`pi install --help` and `pi list --help` were read before running anything. `pi install`
takes a source and adds it to settings; there is no `--dry-run`.

```
$ pi install /Users/mac/firstmate/projects/model-router
Installing /Users/mac/firstmate/projects/model-router...
Installed /Users/mac/firstmate/projects/model-router
```

The only change to `~/.pi/agent/settings.json` was one entry appended to `packages`:

```diff
     "npm:pi-mcp-adapter"
+    "../../firstmate/projects/model-router"
```

That path is relative to `~/.pi/agent/`; `pi list` resolves and reports it absolutely:

```
$ pi list
User packages:
  npm:pi-web-access
    /Users/mac/.pi/agent/npm/node_modules/pi-web-access
  npm:pi-mcp-adapter
    /Users/mac/.pi/agent/npm/node_modules/pi-mcp-adapter
  ../../firstmate/projects/model-router
    /Users/mac/firstmate/projects/model-router
```

`pi install` stores a **path reference, it does not copy**. So the extension Pi loads is
whichever working tree sits at `/Users/mac/firstmate/projects/model-router`. That is the
primary checkout, so a change living only in a disposable worktree is not live.

## 2. The extension actually loads and registers the command

A successful install is not proof the command exists: `router` is registered at extension
load time by `pi.registerCommand('router', ...)` in `extensions/model-router.ts`. That was
only visible, it was never asserted, in the earlier README note.

Verified in a **real installed `pi`**, headless, over RPC. `prompt`/`get_commands` are
documented in Pi's own `docs/rpc.md`; `get_commands` lists commands with their source path.

```
$ pi --mode rpc --no-session --offline --no-approve      # cwd /tmp, driven over stdin/stdout
>> {"id":"cmd-1","type":"get_commands"}
```

From the response, the entry for the installed package:

```json
{
  "name": "router",
  "description": "Model router: status, on, off",
  "source": "extension",
  "sourceInfo": {
    "path": "/Users/mac/firstmate/projects/model-router/extensions/model-router.ts",
    "source": "../../firstmate/projects/model-router",
    "scope": "user",
    "origin": "package",
    "baseDir": "/Users/mac/firstmate/projects/model-router"
  }
}
```

`origin: "package"` and `source: "../../firstmate/projects/model-router"` are the load-bearing
fields: the command came from the installed user package, **not** from an explicit `-e` flag.

Then the command was actually invoked in that same live session, not just listed:

```
>> {"id":"cmd-2","type":"prompt","message":"/router"}
```

It executed and emitted its real notification through the extension UI protocol:

```json
{"type":"extension_ui_request","method":"notify","notifyType":"info",
 "message":"model-router is OFF\nrouted: tiny=0 everyday=0 large=0 hardest=0\nhandled in place: 0\njev calls: 0 (0 failed), ~$0.0000 inferred\nstate: /Users/mac/.model-router/state.json\nbudget: 1800ms worst case while ON"}
```

RPC was chosen because `ctx.hasUI` is true there, so `ctx.ui.notify` is delivered; in print
mode (`-p`) `hasUI` is false and the notification would be silently dropped.

## 3. It ships OFF, and it is still OFF

| Check | Command | Result |
| --- | --- | --- |
| switch file absent | `ls -la ~/.model-router` | `No such file or directory` — the whole dir is absent, not just `enabled` |
| status says OFF | `node bin/router.mjs status` | `model-router 1.0.0 — OFF` / `messages seen: 0` |
| OFF means no network | `node test/switch-canary.mjs` | 4/4 ok, `canary passed: the router ships off and nothing leaves the machine while it is off` |
| offline suite green | `npm test` | `tests 58 / pass 58 / fail 0` |

The canary was also run against the **installed** path
(`node /Users/mac/firstmate/projects/model-router/test/switch-canary.mjs`) and passed the
same way, and `~/.model-router` was still absent afterwards. The `/router` status call in
step 2 wrote no state either: reading status does not create the state dir.

`/router on` was **not** run, and the switch file was not created by any other route. The
`on`/`off` file mechanics are covered instead by the canary's third and fourth assertions.

## 4. A documented command that does not resolve

`README.md` and `AGENTS.md` both write `model-router on` / `model-router test-samples` as a
shell command. **There is no `model-router` on `PATH` on this machine**, and `pi install`
does not link package `bin` entries — `~/.pi/agent/bin/` holds only `fd` and `rg`. So that
form fails in a shell here; `node bin/router.mjs status` is the form that works, and file
mode on `bin/router.mjs` means it needs the `node` prefix.

This is a documentation gap, not an install failure: the install is clean, the extension
loads, and the in-Pi surface works. It was reported rather than patched, per the brief.

## 5. Not verified

- The interactive TUI rendering of `/router` — no TTY session was driven. Registration and
  execution were proven over RPC, which is the same code path that runs the command.
- `/router on`, `/router off` and `/router reset` — deliberately not exercised, because
  turning the router on is out of scope for this task.
- Anything about the models' answer quality. Unchanged from the README's own limits.

## 6. Reproducing this check

```bash
pi list                                                   # expect the path entry
[ -e ~/.model-router/enabled ] && echo ON || echo OFF      # expect OFF
node bin/router.mjs status                                 # expect "— OFF"
node test/switch-canary.mjs                                # expect "canary passed"
npm test                                                   # expect 58 pass

# registration, headless:
#   pi --mode rpc --no-session --offline --no-approve
#   then write  {"id":"cmd-1","type":"get_commands"}  to stdin
#   and look for {"name":"router", ... "source":"extension"} in the response's data.commands
```
