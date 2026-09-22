# model-router

Jev sizes up each message you send, and small jobs go to a smaller, cheaper model
instead of the biggest one.

**It ships OFF.** Nothing leaves your machine until you turn it on.

```
model-router on      # turn it on
model-router off     # turn it off
model-router status  # what went where, and what Jev has cost so far
```

---

## The short version

1. You send a message.
2. Jev gets one question: *what is the smallest size that can do this job well?*
   It picks from four sizes, and it can also answer "cannot tell".
3. Jev's pick at 60% confidence or better, on a message that is a genuine
   standalone job, is handed to the helper for that size, which runs on that
   size's model.
4. Anything else — Jev unsure, Jev slow, Jev down, no API key, a short reply that
   only makes sense mid-conversation — is handled in place, exactly like today.
   You cannot tell the difference from the outside.

## How your messages actually reach the router

**It is automatic. It is not a discipline anyone has to remember.**

This is a Pi extension. Pi fires a `before_agent_start` hook after you submit a
prompt and *before* it starts the turn, and Pi waits for that hook to finish. The
router uses that hook to size your message and switch the session's model. Because
Pi waits, the switch applies to the message you just sent — not the next one.

Verified against the installed Pi source rather than assumed:
`dist/core/agent-session.js` awaits `emitBeforeAgentStart(...)` and only then calls
`_runAgentPrompt(messages)`. `pi.setModel(model)` is the documented extension API
for changing the model, and `before_agent_start` is the documented hook that can
modify the turn.

### Which mechanism was chosen, and what you give up

Switching models per message is genuinely possible here, so nothing had to be
ruled out for being unsupported. `before_agent_start` + `pi.setModel()` was chosen
over spawning a helper process for every message because:

- **it is automatic** — no wrapping command, no discipline, no wrapper script;
- **it is fast** — no process start and no fresh context per message.

What you give up by choosing it:

- **No context isolation.** The cheap model still sees your running conversation,
  not a clean slate. A "tiny" job in a long session still sends the session's
  history to that model. That is a real cost, and it is not offset anywhere.
- **The model line is requested, not guaranteed.** The size helper is told, in
  its system prompt, to end with `Model: <id>`. A model can ignore that. (The
  spawned-helper path below appends the line in code, so there it *is*
  guaranteed.)
- **The switch is sticky within a turn only.** Pi records the model change in the
  session, so the next message is sized again from scratch. If you want the real
  default back, `model-router off` and Pi's own `/model`.

There is also a second, genuine helper path — a real separate `pi` process per
size:

```
model-router route "Summarise this paragraph."
```

Each helper is started as `pi -p --model <the mapped model> --append-system-prompt
'<that size's contract>' -- "<your message>"`, and its reply has the model line
appended in code. This is used by `model-router route` and by the tests. It is not
the per-message path, because a process start per message is exactly the slowdown
you asked to avoid.

**If a helper cannot be started, nothing fails.** The router reports that the
helper could not be started and tells you to ask normally; your message is never
lost and no error is raised on your behalf.

## The four sizes and the models they run on

`model-router sizes` prints this. Everything here was read off this machine.

| Size | Means | Model | Images | input $/Mtok |
| ---- | ----- | ----- | ------ | ------------ |
| `tiny` | a lookup, a rename, a one-line answer | `deepseek-v4-flash` | text only | 0.14 |
| `everyday` | a normal email, post or short document | `deepseek-v4-flash-vision-exp` | text + image | 0.14 |
| `large` | a multi-step build, research, a full report | `deepseek-flash` (V4.1 Flash) | text + image | 0.30 |
| `hardest` | strategy, or anything where a wrong call is expensive | `deepseek-v4-pro` | text only | 1.32 |

### What the order is based on

All four models have the **same** context window (1M) and the **same** max output
(384K), so neither separates them. The order comes from published per-million-token
price — the only quantitative difference Pi exposes — plus the model generation in
the name. Prices were read from Pi's bundled catalogue and from the fetched store
at `~/.pi/agent/models-store.json`.

**Capability is inferred from price and generation. It is not benchmarked.** This
project has not measured one of these models against another.

### Where two models look equivalent, and it is said rather than papered over

`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are **the same price, the
same generation and the same context**. They are not two capability tiers. The
only difference Pi records is that the vision model accepts images. So `tiny` and
`everyday` are effectively one tier for text work; `everyday` gets the vision model
because everyday messages are the ones that turn up with a screenshot attached.

If you would rather have three sizes, delete the `everyday` entry from
`lib/sizes.mjs` and its criteria from `SIZE_CRITERIA` — the rest follows.

### One price discrepancy, stated rather than hidden

`deepseek-v4-pro` is `0.435 / 0.87` per Mtok in Pi's bundled catalogue and
`1.32 / 3.96` in the fetched store. The store is what Pi merges last, so the store
figure is quoted above. **The ranking is the same either way** — pro is the most
expensive model in both.

### Images are never sent to a model that cannot take them

If a message has an image attached and the mapped model is text-only, the router
does **not** switch. It falls back. A cheap answer you cannot use is worse than a
dearer answer that works.

## The routing rule, exactly

A message routes **only** when every one of these holds:

| Check | Threshold | Why |
| ----- | --------- | --- |
| Jev picked one of the four sizes | not `cannot_tell` | the escape hatch always means "handle it yourself" |
| Jev's `confidence` in the pick | ≥ 0.60 | your rule |
| the independent `clarity` signal | ≥ 0.30 | see below |
| the independent `standalone` signal | ≥ 0.50 | catches short mid-conversation replies |
| the mapped model accepts anything attached | — | prevents a switch that would break the message |

Otherwise: handled in place, and the reason is recorded so `status` can explain it.

### Why two extra signals instead of trusting `confidence`

This fleet has already measured Jev never abstaining and reporting high
`confidence` on a choice it was forced into. So the pick's own `confidence` is
treated as a hint, not as authority. Two more questions go in the **same** request
(so this is still one round trip, not three):

- **`size_is_clear`** — "is this request clear enough to tell what work it's
  asking for?" This is the "is this certain?" style check.
- **`standalone_job`** — "is this a self-contained job, or a reply that only makes
  sense mid-conversation?"

Both were calibrated by measurement, not taste. Nine live probes for `clarity`:

| | clarity scores |
| - | - |
| clear requests (4) | 0.50, 0.52, 0.57, 0.94 |
| vague requests (4) | 0.03, 0.04, 0.04, 0.05 |

Nothing landed between the two clusters, so the threshold sits at 0.30. A stricter
wording of the same question ("could you start this right now?") scored 0.15–0.27
even on clear requests and was thrown away for vetoing everything. All four vague
probes also came back `cannot_tell` on their own — the escape hatch working.

## Never slower, never blocked

Every Jev call runs under a **hard timeout of 1500ms**. No retries — a retry could
not fit in the budget.

| Situation | Added delay |
| --------- | ----------- |
| router OFF | **0ms.** No file read beyond one `existsSync`, no network, no Jev. |
| router ON, Jev answers | measured **410–722ms** warm (p50 ≈ 540ms) |
| router ON, Jev slow or broken | capped at **1500ms**, then today's behaviour |

**Stated budget: up to 1800ms added per message while ON, and 0ms while OFF.**

Anything at all goes wrong — timeout, HTTP error, 429, missing key, unparseable
body, wrong shape, no mapped model, model lookup fails, `setModel` returns false —
and the hook returns without changing anything. Your turn then runs exactly as it
would with no router installed. The ledger write is a sub-millisecond local file
write that happens before the hook returns — deferred to a later tick it could be
lost when Pi exits as soon as a turn ends, and a status that silently under-counts
is worse than a millisecond.

**About the cold start, honestly.** TypeSafe's first **two** calls from a fresh
process are cold at ~2.0s each (measured: 2007ms, 2093ms), which is *over* the
per-message budget on purpose — a cold call falls back rather than holding your
turn. So that the captain's first messages don't pay it, the extension runs two
throwaway warm-up calls once when it loads while the switch is ON. Those warm-up
calls are real Jev calls and cost real (tiny) money. They are fire-and-forget:
nothing waits on them, and if they fail nothing happens.

Because they are fire-and-forget, the **first message of a session can still lose
the race** and fall back if the connection is not warm yet. That happened in one
of the verification runs — the ledger shows it as `timed out after 1500ms`. It is
the safe direction: the message was answered by the default model with no switch,
not delayed, and the next message routed normally. It is stated here rather than
smoothed over.

## The switch

The switch is a file. **Its existence means ON.**

```
~/.model-router/enabled
```

Absent means OFF. That is the state on a fresh clone, after a rebase, after a
merge, and after any error reading it. Deleting the file is the same as running
`model-router off` — there is no other way to turn it on.

State lives outside the repository on purpose:

```
~/.model-router/enabled     the switch (absent = OFF)
~/.model-router/state.json  the counters and the cost ledger
```

Override the location with `MODEL_ROUTER_HOME`. Nothing in the repo is written at
runtime, so a stale switch can never ride along with a merge.

You can also flip it from inside Pi: `/router on`, `/router off`, and `/router` for
status, shown as a Pi notification. `/router reset` zeroes the counters. The `on`
and `off` forms were exercised in a real Pi session — the switch file appears and
disappears as expected.

## Status

`model-router status` prints this. The numbers below are the 10-message test run
further down, shown so you can see the shape of the output.

```
$ model-router status
model-router 1.0.0 — OFF
  Nothing is sent to TypeSafe. Every message runs on your own model.

switch file:  ~/.model-router/enabled  (exists = ON; absent = OFF)
state file:   ~/.model-router/state.json
latency:      worst case 1800ms added per message while ON (Jev timeout 1500ms); 0ms while OFF

messages seen: 10

routed per size
  tiny          2 ##
  everyday      2 ##
  large         2 ##
  hardest       2 ##

routed per model
  deepseek-v4-flash              2
  deepseek-v4-flash-vision-exp   2
  deepseek-flash                 2
  deepseek-v4-pro                2

handled in place: 2
      2  jev could not tell (chose "cannot_tell")

jev
  calls         12
  failures      0
  input tokens  9797
  output tokens 1136  (free — TypeSafe bills input only)
  wall time     8.5s
  cost          $0.000411  INFERRED from TypeSafe's published $0.042/Mtok input rate

first 2026-09-22T05:59:41.349Z   last 2026-09-22T05:59:41.357Z
```

Counters persist in `state.json`. Cost is **inferred**, never reported: the API
returns tokens only. TypeSafe publishes Jev 1.13 at **$42 per billion input
tokens ($0.042/Mtok)** and bills input only — output tokens are free. Every dollar
figure this project prints is that rate applied to measured input tokens.

## Privacy

**While the router is ON, the text of your messages is sent to TypeSafe — the
company that makes Jev — to be sized, before it reaches your model.** The request
goes to `https://api.typesafe.ai/v1/systemone`.

**A correction to the brief.** The design brief said messages pass *through
OpenRouter* to the Jev vendor. They do not. There is no OpenRouter in this path:
the Jev call goes **directly to TypeSafe**, and the model calls after it go
directly to DeepSeek's API. Nothing in this project is configured to use
OpenRouter. Verified by reading the endpoint in `lib/config.mjs` and the base URL
(`https://api.deepseek.com`) in Pi's own model catalogues. The privacy advice you
asked for stands unchanged, and is stronger: your message text reaches a third
party directly, so **keep it OFF for private work.**

- Ships OFF, and the switch is the only thing that turns it on.
- OFF means **zero** network calls — asserted by test, not by hope
  (`test/switch-canary.mjs` and `test/router.test.mjs` assert no fetch happens).
- The API key is read from `TYPESAFE_API_KEY`, never printed, never logged, never
  written to the ledger, and never committed. HTTP error bodies are deliberately
  not read into logs, because they can echo request content.
- No message content is stored. The ledger records sizes, counts, tokens and
  timings — never your text.
- A spawned helper gets a scrubbed environment: `PI_SESSION_ID`, `PI_SESSION_FILE`,
  `PI_MODEL`, `PI_PROVIDER`, `PI_REASONING_LEVEL` and `PI_CODING_AGENT` are
  removed, so a helper does not believe it is part of your session. API keys and
  your own settings are passed through.

## The test: 10 messages, run for real

Run it yourself: `model-router test-samples`. It sends the sample text to TypeSafe,
and it says so before it starts.

**8 routed, 2 fell back. 10/10 landed in the band they were written for.**

| # | band | message | Jev size | confidence | clear? | standalone? | mapped model | outcome |
| - | ---- | ------- | -------- | ---------- | -------- | ----------- | ------------ | ------- |
| 1 | tiny | rename the variable `foo` to `bar` in index.js | tiny | 0.95 | 0.83 | 0.78 | deepseek-v4-flash | routed |
| 2 | tiny | what port does the dev server listen on? | tiny | 0.70 | 0.35 | 0.57 | deepseek-v4-flash | routed |
| 3 | everyday | Write a short email to the team letting them know the Friday demo moved to Monday. | everyday | 0.94 | 0.96 | 0.96 | deepseek-v4-flash-vision-exp | routed |
| 4 | everyday | Draft a 200-word LinkedIn post about the new pricing page we shipped this week. | everyday | 0.98 | 0.58 | 0.67 | deepseek-v4-flash-vision-exp | routed |
| 5 | large | Build a script that reads our monthly CSV exports, dedupes customers by email address, and writes a summary report with totals per month. | large | 0.73 | 0.77 | 0.92 | deepseek-flash | routed |
| 6 | large | Research the three cheapest ways to host a small Postgres database for a side project and write up a recommendation with the trade-offs. | large | 0.99 | 0.93 | 0.96 | deepseek-flash | routed |
| 7 | hardest | Map out a three-year strategy for entering the EU market with a 2M dollar budget. A wrong call here is expensive. | hardest | 0.99 | 0.68 | 0.92 | deepseek-v4-pro | routed |
| 8 | hardest | Decide whether we should drop our biggest client to free up the team. Give me the call and the reasoning you would defend to the board. | hardest | 0.96 | 0.53 | 0.63 | deepseek-v4-pro | routed |
| 9 | short reply | yes do that but make it shorter | cannot_tell | 0.43 | 0.31 | 0.03 | — | fell back — jev could not tell (chose "cannot_tell") |
| 10 | short reply | ok, and what about the second one? | cannot_tell | 0.80 | 0.16 | 0.05 | — | fell back — jev could not tell (chose "cannot_tell") |

**Total measured Jev cost of the test: $0.000411** (9797 input tokens, including the two
warm-up calls; 1136 output tokens, which are free). Inferred from the published rate.
Wall time was 8.5s including the warm-up, or 532ms per sample.

Raw answers, including the full probability distributions Jev returned, are in
`evidence/raw-jev-*.json`. The generated table is in `evidence/samples-*.md`.

Row 1 is a good example of the whole design working: Jev sized it `tiny` at 0.95,
the clarity and standalone signals agreed (0.83 and 0.78), and the message went to
the cheapest model.

Rows 9 and 10 are the point of the exercise. Both are well-formed messages that Jev
*could* have sized, and both were refused. Two independent checks agreed: Jev itself
returned the `cannot_tell` escape hatch, and the standalone signal came back at 0.03
and 0.05 — essentially certain that neither sentence means anything on its own. The
recorded reason is the escape hatch, which is the check that ran first.

The run above was made with the extension's two warm-up calls first, matching how
the router runs in practice. An earlier run without the warm-up lost one sample to
the 1500ms cap — that is the fallback behaving correctly, but it would have
understated the router, so the warm-up is part of the harness.

## Verified in a real Pi session, not just in tests

Both of these were run against a real `pi` session with the extension loaded
(`pi -e ./extensions/model-router.ts`), not simulated:

| What was run | Model reported by Pi | Ledger |
| ------------ | -------------------- | ------ |
| switch OFF, a `hardest` strategy message | `deepseek-flash` (your default, unchanged) | no Jev call at all |
| switch ON, the same message | **`deepseek-v4-pro`** | `hardest` → 1, 813 input tokens, $0.000034 |
| switch ON, an `everyday` email | **`deepseek-v4-flash-vision-exp`** | `everyday` → 1 |
| then, continuing that session: *"yes do that but make it shorter"* | unchanged — no switch | handled in place: *jev could not tell* |
| the same `everyday` email through `pi install` (no `-e` flag) | **switched**, baseline unchanged | `everyday` → 1 |

The ON run's reply ended with `Model: deepseek-v4-pro` as instructed.

The `pi install` row is worth reading carefully, because the first attempt at it
was a false positive: a throwaway config directory with no `settings.json` defaults
to `deepseek-v4-pro`, so seeing that model proved nothing. Re-run against a real
baseline, the model moved off the default and onto the mapped one, which is the
actual evidence.

## Install

```
pi install /path/to/model-router       # or:  pi -e /path/to/model-router/extensions/model-router.ts
```

Then, whenever you want it:

```
model-router on
```

## Tests

```
npm test              # 58 offline tests: the rule, the ledger, the switch, the parser, failure modes
npm run test:canary   # proves it ships OFF and OFF means no network
model-router test-samples   # the live 10-message run above (spends Jev tokens)
```

The offline suite covers every branch that decides *not* to route, every failure
mode of the Jev client (timeout, 500, 401, HTML body, wrong shape, missing key),
and the helper fallbacks. None of it needs a network.

## What was verified, and what was inferred

**Verified on this machine**
- Only `pi` is installed. `claude`, `codex`, `grok`, `kimi` and `cursor` do not
  exist. `pi --list-models` shows exactly four deepseek models.
- Per-message switching works: `before_agent_start` is awaited before the turn,
  `pi.setModel()` switches the session, and both were exercised in a real session.
- One real spawned helper ran on `deepseek-v4-flash` in 2.4s and ended with the
  model line.
- Jev answers over the documented HTTP API; `jev-latest` reports as `jev-1.13.0`.
- Latency, token counts and every number in the table above were measured.

**Inferred, and labelled as such everywhere it appears**
- Model capability ranking (from price and generation, not benchmarks).
- Dollar cost (from TypeSafe's published rate; the API returns tokens only).

**Not claimed**
- No automation beyond the hook described above.
- No capability that was not exercised.
- Nothing about these models' answer quality relative to each other.

## Layout

```
lib/config.mjs     endpoints, the 1500ms budget, thresholds, state paths
lib/sizes.mjs      the four sizes, the model mapping, and the basis for the order
lib/jev.mjs        the sizer: one request, three questions, hard timeout, no retries
lib/policy.mjs     the routing rule as a pure function — every veto is testable
lib/ledger.mjs     persisted counters and inferred cost, atomic, never fatal
lib/switch.mjs     the on/off switch; absent file means OFF
lib/router.mjs     orchestration; never throws, never blocks
lib/helpers.mjs    per-size contracts and the real spawned-helper path
extensions/model-router.ts   the Pi hook: sizes each message and switches the model
bin/router.mjs     on | off | status | sizes | route | reset | test-samples
tools/run-samples.mjs        the live 10-message test
evidence/                    the raw Jev answers and the generated table
```
