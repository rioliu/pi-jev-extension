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

> **Unofficial.** This is an independent integration. It is not affiliated with, endorsed by, or
> supported by TypeSafe or the Jev project.

---

## Privacy: what leaves your machine

`state` is sent **verbatim** to `POST https://jevmodel.org/v1/systemone`. Whatever you put in `state`
— source code, stack traces, tickets, logs — is transmitted to that third-party endpoint.

- Do not call the tool with data your organisation forbids sending off-box.
- Point `JEVMODEL_URL` at a deployment you control if you need data locality.
- With no `JEVMODEL_API_KEY`, no request is made at all and the session model answers directly.

---

## Install

```bash
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
| `JEVMODEL_API_KEY` | yes* | — | Bearer key from the jevmodel.org Dashboard. *Without it, every call falls back to the session model. |
| `JEVMODEL_URL` / `JEV_URL` | no | `https://jevmodel.org/v1/systemone` | Endpoint override |
| `JEVMODEL_TIMEOUT_MS` | no | `30000` | Max wait on Jev before handing off |
| `JEVMODEL_FALLBACK_MODEL` | no | session model | Pin the fallback to `provider/modelId` |

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
  "model": "jev-1.13.0",
  "legend": "Read answers[key]: `.noul` = P(yes) in 0..1 ...",
  "answers": {
    "root":  { "type": "choice", "choice": "dep", "confidence": 0.94,
               "probabilities": { "dep": 0.96, "env": 0, "code": 0.04 } },
    "flaky": { "type": "noul", "noul": 0.88 },
    "sev":   { "type": "score", "score": 1.57, "confidence": 0.48,
               "legend": { "0": "low", "1": "medium", "2": "high", "3": "critical" },
               "probabilities": { "0": 0.03, "1": 0.42, "2": 0.5, "3": 0.05 } }
  }
}
```

| Field | Meaning |
|---|---|
| `answers[k].type` | mirrors the question type |
| `answers[k].noul` | P(yes) ∈ 0..1. **Has no `confidence` field** — the probability *is* the certainty |
| `answers[k].choice` | selected label; `probabilities` is the full distribution over your criteria keys |
| `answers[k].score` | position on your scale — **may be fractional** (e.g. `1.57`, i.e. between `medium` and `high`). Its own `legend` maps level index → your label |
| `answers[k].confidence` | 0..1, present for `choice` and `score`, **absent for `noul`** |
| `source` | `"jev"` or `"fallback"` — treat fallback answers as less calibrated |
| `legend` | *top-level* — this documentation note, not part of any answer |

`answers` is validated against the questions you asked: a missing answer, an unknown `choice`, a
non-numeric `score`, or a `noul` outside 0..1 fails loudly instead of reaching your model silently.

## Failure handling

| Condition | Behaviour |
|---|---|
| `401` auth / `422` invalid request | surfaced as an error (your bug) |
| `402` insufficient credits | fallback — retrying cannot help, every later call is rejected too |
| `429` rate limit / `502` upstream | fallback + circuit opens |
| timeout (`JEVMODEL_TIMEOUT_MS`) | fallback |
| network error | fallback |
| HTTP 200 with a non-JSON body | error quoting the offending body |
| malformed `questions` | error **before** any request |

Capacity failures open a circuit breaker, so while it is open no Jev request is attempted at all —
the session model serves every call — and one half-open probe after the cooldown detects recovery.

## Development

```bash
bun install          # peer deps: @earendil-works/pi-ai, pi-coding-agent
bun test             # unit tests
bun run extensions/schema-check.ts   # schema + prompt-definition integrity
bun run typecheck
```

`schema-check.ts` asserts the tool contract *and* guards the prompt the consuming model reads — it
self-tests that it would catch a string-concatenation artifact (a stray `+` once turned an entire
sentence of the tool description into `NaN`).

## License

MIT
