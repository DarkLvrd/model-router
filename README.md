# model-router

[![CI](https://github.com/DarkLvrd/model-router/actions/workflows/ci.yml/badge.svg)](https://github.com/DarkLvrd/model-router/actions/workflows/ci.yml)

model-router is an extension for the [Pi](https://github.com/badlogic/pi-mono) coding agent that picks
a cheaper model for small requests. Before each message runs, an LLM classifier (TypeSafe's Jev
model) sizes the job. If the classifier is confident and the message makes sense on its own, the
session switches to the model mapped to that size. In every other case the message runs on the
default model, exactly as it would without the extension.

It ships switched off. While it is off, it makes no network calls at all, and a test checks that.

## How a message is routed

```
message ──► Jev: size? clear? standalone? ──► all checks pass ──► switch to the mapped model
                     (one request, 2.5 s cap)  └─ any check fails, timeout or error ──► default model
```

Jev is asked three questions in a single request:

| Question | Routes only when |
|---|---|
| What is the smallest size that can do this job well? (`tiny`, `everyday`, `large`, `hardest` or `cannot_tell`) | one of the four sizes, with confidence ≥ 0.60 |
| Is the request clear enough to tell what work it asks for? | score ≥ 0.30 |
| Is it a self-contained job, or a reply that only makes sense mid-conversation? | score ≥ 0.50 |

The confidence score alone was not trusted, because Jev had already been measured giving high
confidence on choices it was forced into. The two extra signals were calibrated on live probes: clear
requests scored 0.50 to 0.94 for clarity and vague ones 0.03 to 0.05, so the threshold sits between
the two groups.

A message with an image attached never goes to a text-only model. A slash command is never routed.

| Size | Example | Model |
|---|---|---|
| `tiny` | rename a variable | `deepseek-v4-flash` |
| `everyday` | a short email | `deepseek-v4-flash-vision-exp` |
| `large` | a multi-step script or a research write-up | `deepseek-flash` |
| `hardest` | strategy, or a decision that is expensive to get wrong | `deepseek-v4-pro` |

The order comes from published price and model generation. It has not been benchmarked.

## Failure handling

Every Jev call has a hard 2,500 ms timeout and no retries. A timeout, an HTTP error, a missing API
key, an unparseable reply or a failed model switch all end the same way: the hook returns without
changing anything and the turn runs on the default model. The reason is recorded so
`model-router status` can show it.

Measured latency on 30 live calls: median 489 ms, p95 1,583 ms. While the router is on, the most it
can add to a message is about 2.8 seconds. While it is off, it adds nothing.

## Results from a live run

Ten sample messages were sent through the real Jev API (`model-router test-samples`):

- 8 were routed, each to the size it was written for.
- 2 were short mid-conversation replies ("yes do that but make it shorter"). Jev answered
  `cannot_tell` and the standalone score was 0.03 and 0.05, so both stayed on the default model.
- Total classifier cost: $0.000411 for 9,797 input tokens, at TypeSafe's published rate.

The raw responses, including every probability Jev returned, are in [`evidence/`](evidence/). The
extension was also tested in a real Pi session: with the switch off, a strategy question stayed on
the default model; with it on, the same question moved to `deepseek-v4-pro`.

## Install and use

Requirements: Node.js 20+, Pi, and a TypeSafe API key in `TYPESAFE_API_KEY`.

```bash
pi install /path/to/model-router
node bin/router.mjs on        # start routing
node bin/router.mjs status    # what went where, and what Jev has cost
node bin/router.mjs off       # stop routing
```

Inside Pi the same switch is `/router on`, `/router off` and `/router`.

The switch is a file, `~/.model-router/enabled`. If it exists the router is on. Counters and the cost
ledger live next to it in `state.json`, outside the repository, so a fresh clone always starts off.

## Privacy

While the router is on, the text of each message is sent to TypeSafe (`api.typesafe.ai`) to be sized
before it reaches the model. Keep it off for private work. The API key is never printed or logged,
error response bodies are not logged because they can echo the request, and the ledger stores sizes,
counts, tokens and timings but never message text.

## Tests

```bash
npm test                 # 58 offline tests
npm run test:canary      # proves it ships off and that off means no network
```

The offline tests cover every branch that decides not to route, every failure mode of the Jev client
(timeout, HTTP 500 and 401, HTML body, wrong shape, missing key), the ledger, the switch and the
helper fallbacks. GitHub Actions runs them on every push and pull request.

## Project layout

```
extensions/model-router.ts   Pi hook: sizes each message and switches the model
lib/jev.mjs                  the classifier call: one request, three questions, hard timeout
lib/policy.mjs               the routing rule as a pure function
lib/sizes.mjs                the four sizes and the model each one maps to
lib/ledger.mjs               counters and inferred cost, written atomically
lib/switch.mjs               the on/off switch
lib/router.mjs               ties the pieces together; never throws
lib/helpers.mjs              per-size helper processes for `model-router route`
bin/router.mjs               CLI: on, off, status, sizes, route, reset, test-samples
test/                        offline tests and the off-means-offline canary
tools/                       the live sample run and an evidence replay tool
evidence/                    raw Jev answers and the generated results table
docs/DESIGN.md               the full design notes and measurements
```

## License

MIT
