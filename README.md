# pi-jev-extension

[![License: MIT](https://img.shields.io/github/license/rioliu/pi-jev-extension)](LICENSE)
[![CI](https://github.com/rioliu/pi-jev-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/rioliu/pi-jev-extension/actions/workflows/ci.yml)
[![Pi extension](https://img.shields.io/badge/Pi-extension-6c5ce7)](https://github.com/earendil-works/pi)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-000000)](https://bun.sh)

> **Typed decisions, not prose.** One tool call → a value your code can branch on.

**Project page:** [rioliu.github.io/pi-jev-extension](https://rioliu.github.io/pi-jev-extension/)

A [Pi](https://github.com/earendil-works/pi) extension that adds a **`jev_decide`** tool: ask
[TypeSafe](https://typesafe.ai)'s **Jev System One** model a typed question and get back a value your
code can branch on — a `choice`, a `score`, or a `noul` (yes/no probability). Jev never returns prose.

If Jev is unavailable, rate-limited, out of credit, too slow, or unreachable, the tool **silently hands
the same question to your session model** instead, and marks the result `source: "fallback"`.

The request goes through **Pi's builtin classifier API**
(`ctx.modelRegistry.classify`) with your Pi credentials (`TYPESAFE_API_KEY`), so usage
counts toward the session cost in the footer and `/session`.

> **Unofficial.** This is an independent integration. It is not affiliated with, endorsed by, or
> supported by TypeSafe or the Jev project.

---

## Privacy: what leaves your machine

`state` is sent **verbatim** to the endpoint behind the configured classifier credential —
TypeSafe's System One endpoint with `TYPESAFE_API_KEY`, or whichever Jev-capable provider you
configured in Pi. Whatever you put in `state` — source code, stack traces, tickets, logs — is
transmitted to that third-party endpoint.

- Do not call the tool with data your organisation forbids sending off-box to that endpoint.
- With no classifier credential, no request is made at all: the session model answers directly.

---

## Install

```bash
pi install npm:pi-jev-extension                       # from npm (gallery package)
pi install git:github.com/rioliu/pi-jev-extension   # as a Pi package
pi install ./pi-jev-extension                          # from a local checkout
```

Or symlink it straight into your user extensions directory:

```bash
ln -s "$PWD/extensions" ~/.pi/agent/extensions/jev
```

Pi loads TypeScript directly (no build step).

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `TYPESAFE_API_KEY` | yes* | — | Pi's TypeSafe credential (or configure another Jev-capable provider, e.g. via OpenRouter). *Without any classifier credential the tool falls back to the session model with a stated reason. |
| `JEVMODEL_TIMEOUT_MS` | no | `30000` | Max wait on Jev before handing off |
| `JEVMODEL_FALLBACK_MODEL` | no | session model | Pin the fallback to `provider/modelId` |

Model selection: the first credentialed classifier in Pi's registry, preferring
`typesafe/jev-latest`. The tool's optional `model` argument overrides it as `provider/id`
(a bare id is taken from `typesafe`, e.g. `jev-latest` or `openrouter/typesafe/jev-1.13`).

## Asking a question

`questions` **must be a nested JSON object** keyed by a short identifier (letters, digits, `_`, ≤ 64 chars),
1–8 entries:

```jsonc
{
  "state": "CI build 52 failed with an XML schema error after a dependency bump...",
  "questions": {
    "root":  { "type": "choice", "instructions": "Most likely cause?",
               "criteria": { "dep": "dependency bump", "env": "environment flake", "code": "real defect" } },
    "flaky": { "type": "noul",  "instructions": "Is this a real bug rather than an environment flake?" },
    "sev":   { "type": "score", "instructions": "Severity",
               "criteria": ["low", "medium", "high", "critical"] }
  }
}
```

| Type | `criteria` | Returns |
|---|---|---|
| `choice` | object, 2–20 option keys → descriptions | selected label + distribution |
| `score` | array, 2–10 ordered levels | fractional position on that scale |
| `noul` | optional labels | P(yes) in 0..1 |

A JSON-*encoded* string is accepted and parsed (with bounded repair for an unbalanced trailing brace),
but the object form is canonical — a string carries no structure guarantee, and that is where malformed
values get through. Anything unrecoverable is rejected **before** a request is sent.

### What the tool prompt teaches the model

The `promptGuidelines` injected into the session aim for use that is both *reasonable* and *efficient*,
following usage patterns from the Jev ecosystem study ([arXiv:2609.30216](https://arxiv.org/abs/2609.30216)):

- **Batch related questions** — one `state` carries up to 8 questions of mixed types; the prompt prefers
  one call with three related questions over three sequential calls (one round trip, one shared state).
- **Gate on confidence in three tiers** — *decisive* (`choice`/`score` `confidence` ≥ 0.9, `noul` ≤ 0.1 or
  ≥ 0.9) → act on it; *weak middle* (`confidence` 0.5–0.9, `noul` 0.1–0.3 or 0.7–0.9) → corroboration
  only: it may reinforce what the evidence in context already shows, but never carries an irreversible
  action alone (show the user), and when it matters, decompose the state into narrower yes/no questions
  and re-ask; *no signal* (`confidence` < 0.5, `noul` 0.3–0.7) → ignore it, decide from the evidence, and
  ask the user before irreversible actions ("accept when confident, escalate when unsure"). The cutoffs
  sit at the measured accuracy cliffs, not at round numbers: [Aman Kumar's 16K-call study](https://amankumar.ai/blogs/jev-measured)
  reports 90–100% accuracy at ≥ 0.9 confidence and a 6–83% band through the middle;
  [arXiv:2609.24574](https://arxiv.org/abs/2609.24574) puts median accuracy at 0.815 above 0.9 and
  shows high-confidence failures can still occur task-by-task.
- **Descriptive option keys** — decisions follow the option *name*, not just the rubric bound to it:
  short, discriminative, mutually exclusive keys and descriptions.
- **Deterministic policy stays in charge** — an explicit user instruction always wins over Jev, and Jev
  remains a second opinion the model overrides when evidence contradicts it.
- **Don't call when the answer is in context** — trivially answerable questions, explanations, and
  anything needing prose never reach Jev.

## Reading the result

Every result carries a `legend` field restating this, so it stays with the data:

```jsonc
{
  "source": "jev",
  "model": "typesafe/jev-latest",
  "legend": "Read answers[key]: `.noul` = P(yes) in 0..1 ...",
  "answers": {
    "root":  { "type": "choice", "choice": "dep", "confidence": 0.94,
               "probabilities": { "dep": 0.96, "env": 0, "code": 0.04 } },
    "flaky": { "type": "noul", "noul": 0.88 },
    "sev":   { "type": "score", "score": 1.57, "confidence": 0.48,
               "legend": { "0": "low", "1": "medium", "2": "high", "3": "critical" },
               // score `probabilities` are not carried by Pi's classifier API;
               // the legend is always present
               "probabilities": { "0": 0.03, "1": 0.42, "2": 0.5, "3": 0.05 } }
  }
}
```

| Field | Meaning |
|---|---|
| `answers[k].type` | mirrors the question type |
| `answers[k].noul` | P(yes) ∈ 0..1. **Has no `confidence` field** — the probability *is* the certainty |
| `answers[k].choice` | selected label; `probabilities` is the full distribution over your criteria keys |
| `answers[k].score` | position on your scale — **may be fractional** (e.g. `1.57`, i.e. between `medium` and `high`). Its own `legend` maps level index → your label (always present, reconstructed from your criteria) |
| `answers[k].confidence` | 0..1, present for `choice` and `score`, **absent for `noul`** |
| `source` | `"jev"` or `"fallback"` — treat fallback answers as less calibrated |
| `legend` | *top-level* — this documentation note, not part of any answer |

`answers` is validated against the questions you asked: a missing answer, an unknown `choice`, a
non-numeric `score`, or a `noul` outside 0..1 fails loudly instead of reaching your model silently.

## Versus Pi's builtin classifier API

Pi ≥ 1.0 exposes the same Jev System One model in two more places: `models.classify()` inside
`codemode` scripts (off by default) and `ctx.modelRegistry.classify()` for extensions. This
extension **uses the latter as its transport** and still earns its place as a tool:

- **First-class tool, no codemode required** — `jev_decide` is in every session without enabling
  script mode, with a strict schema and per-field validation errors the model can act on.
- **Usage policy in the prompt** — the `promptGuidelines` teach batching, three-tier confidence
  gating, and when *not* to call. The builtin API ships no policy; a script model would have to
  invent one.
- **Automatic session-model fallback + circuit breaker** — builtin `classify()` returns
  `stopReason: "error"` and stops; this tool degrades to the session model and remembers capacity
  failures.
- **Answer validation** — responses are checked against the questions asked before the model sees
  them; the builtin leaves that to the caller.

If you only need raw classification inside a script, use `models.classify()` directly — it is
cheaper than routing through a tool.

## Failure handling

| Condition | Behaviour |
|---|---|
| Classifier provider error (auth, invalid request, quota, upstream) | fallback + circuit opens — Pi reports these as one `errorMessage`; malformed questions are still rejected before the call, and malformed answers still fail loudly after it |
| timeout (`JEVMODEL_TIMEOUT_MS`) | fallback + circuit opens |
| no classifier credentials | fallback with a stated preflight reason |
| malformed `questions` | error **before** any request |
| malformed answers from the model | error, never silently passed to the consuming model |

Capacity failures open a circuit breaker, so while it is open no Jev request is attempted at all —
the session model serves every call — and one half-open probe after the cooldown detects recovery.

## Development

```bash
bun install          # peer deps: @earendil-works/pi-ai, pi-coding-agent
bun test             # unit tests
bun run extensions/schema-check.ts   # schema + prompt-definition integrity
bun run typecheck
```

Typecheck pins `@earendil-works/pi-ai` and `pi-coding-agent` at 1.0.2 as devDependencies - the
classifier types (`ClassifierModel`, `ctx.modelRegistry.classify`) do not exist in older releases.
At runtime the extension uses the host Pi's own packages; on a Pi older than 1.0 the tool
reports a preflight reason and the session model answers.

`schema-check.ts` asserts the tool contract *and* guards the prompt the consuming model reads — it
self-tests that it would catch a string-concatenation artifact (a stray `+` once turned an entire
sentence of the tool description into `NaN`).

## License

MIT
