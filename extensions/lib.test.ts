import { describe, expect, test } from "bun:test";

import {
	ANSWER_LEGEND,
	buildFallbackMessages,
	buildToolResult,
	CircuitBreaker,
	coerceQuestions,
	explainQuestionProblems,
	extractJsonObject,
	isCapacityFailure,
	normalizeAnswers,
	runJevDecide,
	toFullUsage,
	validateJevAnswers,
	type DecideParams,
	type FallbackResult,
	type HttpLike,
	type Questions,
} from "./lib.ts";

const questions: Questions = {
	pick: {
		type: "choice",
		instructions: "pick one",
		criteria: { a: "first", b: "second" },
	},
	level: { type: "score", instructions: "rate", criteria: ["low", "mid", "high"] },
	yesno: { type: "noul", instructions: "is it?" },
};

const params: DecideParams = { state: "some state", questions };

/** A complete, spec-valid answer set for `questions` - what a healthy Jev returns. */
const validJevAnswers = {
	pick: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } },
	level: { type: "score", score: 1, confidence: 0.7 },
	yesno: { type: "noul", noul: 0.5 },
};

/** payload a healthy Jev 200 returns (used by jevOk). */
function jevOk(overrides?: Partial<Record<string, unknown>>): HttpLike {
	const payload = {
		model: "jev-1.13.0",
		answers: validJevAnswers,
		usage: { input_tokens: 10, output_tokens: 5 },
		...overrides,
	};
	return async () => ({
		ok: true,
		status: 200,
		text: async () => JSON.stringify(payload),
		json: async () => payload,
	});
}

function jevHttpError(status: number, body: string): HttpLike {
	return async () => ({ ok: false, status, text: async () => body, json: async () => ({}) });
}

function jevNetworkError(message = "fetch failed"): HttpLike {
	return async () => {
		throw new TypeError(message);
	};
}

const fullFallbackText =
	'{"answers":{"pick":{"type":"choice","choice":"a"},"level":{"type":"score","score":1},"yesno":{"type":"noul","noul":0.5}}}';

function fallbackOk(text: string = fullFallbackText): (p: DecideParams) => Promise<FallbackResult> {
	return async () => ({ text, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, model: "mimo/test" });
}

function deps(overrides: Partial<Parameters<typeof runJevDecide>[1]>) {
	return {
		url: "http://jev.test",
		apiKey: "k",
		fetchImpl: jevOk(),
		circuit: new CircuitBreaker(),
		fallback: fallbackOk("{}"),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// capacity classification
// ---------------------------------------------------------------------------

describe("isCapacityFailure", () => {
	test("5xx/429/408 statuses are capacity", () => {
		for (const s of [408, 429, 500, 502, 503, 504, 529]) {
			expect(isCapacityFailure(s, "anything")).toBe(true);
		}
	});

	test("hard caller-error statuses are never capacity, even with keyword bodies", () => {
		for (const s of [400, 401, 403, 404, 422]) {
			expect(isCapacityFailure(s, "rate limit exceeded")).toBe(false);
		}
	});

	test("capacity keywords in body of otherwise unclassified status", () => {
		expect(isCapacityFailure(460, '{"error":"rate limit exceeded"}')).toBe(true);
		expect(isCapacityFailure(460, "model at capacity")).toBe(true);
		expect(isCapacityFailure(460, '{"error":"bad request shape"}')).toBe(false);
	});

	test("402 insufficient_credits is capacity by status, not by body keywords", () => {
		// Docs: 402 | insufficient_credits | "Estimated input tokens exceed your balance."
		// | Charged? No. A retry cannot help - every later call is rejected too, so
		// the session model must take over. Classification must not depend on the
		// response wording containing the word "insufficient".
		expect(isCapacityFailure(402, "")).toBe(true);
		expect(isCapacityFailure(402, "credit balance too low")).toBe(true);
		expect(
			isCapacityFailure(
				402,
				'{"error":{"type":"insufficient_credits","message":"Estimated input tokens exceed your balance."}}'
			)
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// circuit breaker preflight
// ---------------------------------------------------------------------------

describe("CircuitBreaker", () => {
	test("starts closed, opens on failure, blocks until cooldown", () => {
		let now = 1000;
		const cb = new CircuitBreaker(60_000, () => now);
		expect(cb.canAttempt()).toBe(true);
		cb.recordFailure();
		expect(cb.canAttempt()).toBe(false);
		expect(cb.isOpen).toBe(true);
		now += 59_999;
		expect(cb.canAttempt()).toBe(false);
		now += 1;
		expect(cb.canAttempt()).toBe(true); // half-open probe
	});

	test("failure during half-open reopens with fresh timer", () => {
		let now = 0;
		const cb = new CircuitBreaker(100, () => now);
		cb.recordFailure();
		now = 100;
		expect(cb.canAttempt()).toBe(true);
		cb.recordFailure();
		now = 150;
		expect(cb.canAttempt()).toBe(false);
	});

	test("success closes the circuit", () => {
		const cb = new CircuitBreaker(60_000, () => 0);
		cb.recordFailure();
		cb.recordSuccess();
		expect(cb.canAttempt()).toBe(true);
		expect(cb.isOpen).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// fallback output parsing / normalization
// ---------------------------------------------------------------------------

describe("extractJsonObject", () => {
	test("plain object", () => {
		expect(extractJsonObject('{"answers":{}}')).toEqual({ answers: {} });
	});

	test("markdown fence with prose", () => {
		const out = extractJsonObject('Sure! Here it is:\n```json\n{"answers":{"q":{"noul":0.5}}}\n```');
		expect(out).toEqual({ answers: { q: { noul: 0.5 } } });
	});

	test("prose before and nested braces", () => {
		const out = extractJsonObject('answer: {"answers":{"q":{"probabilities":{"a":0.5,"b":0.5}}}} done');
		expect(out).toEqual({ answers: { q: { probabilities: { a: 0.5, b: 0.5 } } } });
	});

	test("braces inside strings do not break scanning", () => {
		const out = extractJsonObject('{"answers":{"q":{"choice":"a"}}} trailing }');
		expect(out).toEqual({ answers: { q: { choice: "a" } } });
	});

	test("no JSON at all throws", () => {
		expect(() => extractJsonObject("I cannot decide that.")).toThrow("No JSON object");
	});
});

describe("normalizeAnswers", () => {
	const raw = {
		answers: {
			pick: { type: "choice", choice: "b", confidence: 0.8, probabilities: { a: 0.2, b: 0.8, z: 9 } },
			level: { type: "score", score: 4.2, confidence: "0.7" },
			yesno: { type: "noul", noul: 86 },
		},
	};

	test("full shape: clamps and coerces", () => {
		const out = normalizeAnswers(raw, questions);
		expect(out.pick).toEqual({
			type: "choice",
			choice: "b",
			confidence: 0.8,
			probabilities: { a: 0.2, b: 0.8 }, // z dropped (not a criteria key)
		});
		expect(out.level).toEqual({ type: "score", score: 2, confidence: 0.7 }); // clamped to levels-1
		expect(out.yesno).toEqual({ type: "noul", noul: 0.86 }); // percentage converted
	});

	test("accepts flat answers without wrapper", () => {
		const out = normalizeAnswers({ yesno: { noul: 0.3 } }, { yesno: questions.yesno });
		expect(out.yesno).toEqual({ type: "noul", noul: 0.3 });
	});

	test("optional fields omitted cleanly", () => {
		const out = normalizeAnswers(
			{ answers: { yesno: { type: "noul", noul: 1 } } },
			{ yesno: questions.yesno }
		);
		expect(out.yesno).toEqual({ type: "noul", noul: 1 });
	});

	test("invalid choice key throws", () => {
		expect(() =>
			normalizeAnswers({ answers: { pick: { type: "choice", choice: "z" } } }, { pick: questions.pick })
		).toThrow('invalid choice');
	});

	test("missing answer throws", () => {
		expect(() => normalizeAnswers({ answers: {} }, questions)).toThrow("omitted answer");
	});

	test("non-numeric score throws", () => {
		expect(() =>
			normalizeAnswers({ answers: { level: { type: "score", score: "high" } } }, { level: questions.level })
		).toThrow("non-numeric score");
	});
});

// ---------------------------------------------------------------------------
// main flow: preflight + fallback
// ---------------------------------------------------------------------------

describe("runJevDecide", () => {
	const jevAnswers = validJevAnswers;

	test("happy path returns jev source and usage", async () => {
		const circuit = new CircuitBreaker();
		const out = await runJevDecide(params, deps({ circuit, fetchImpl: jevOk() }));
		expect(out.source).toBe("jev");
		expect(out.model).toBe("jev-1.13.0");
		expect(out.answers).toEqual(jevAnswers);
		expect(out.usage).toEqual({
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(circuit.isOpen).toBe(false);
	});

	test("fallback usage missing cost is normalized to pi's full Usage shape", async () => {
		// regression: pi's footer reads usage.cost.total on every tool result
		// usage; a bare {input, output, cacheRead, cacheWrite} crashes pi with
		// "Cannot read properties of undefined (reading 'total')".
		const out = await runJevDecide(
			params,
			deps({
				fetchImpl: jevHttpError(503, "at capacity"),
				// simulate a stream usage without cost/totalTokens
				fallback: async () => ({
					text: fullFallbackText,
					usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
					model: "mimo/test",
				}),
			})
		);
		expect(out.usage).toEqual({
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});

	test("fallback without usage leaves usage undefined", async () => {
		const out = await runJevDecide(
			params,
			deps({
				fetchImpl: jevHttpError(503, "at capacity"),
				fallback: async () => ({ text: fullFallbackText, model: "mimo/test" }),
			})
		);
		expect(out.usage).toBeUndefined();
	});

	test("402 insufficient credits: hand off to the main model, never retry", async () => {
		// Budget exhausted -> retrying is pointless (every later call is rejected
		// too). Exactly one attempt, then the session model takes over and the
		// circuit stops further Jev attempts during the cooldown.
		const circuit = new CircuitBreaker();
		let jevCalls = 0;
		let fallbackCalls = 0;
		const denied = jevHttpError(
			402,
			'{"error":{"type":"insufficient_credits","message":"Estimated input tokens exceed your balance."}}'
		);
		const counting: HttpLike = (async (input: unknown, init: never) => {
			jevCalls++;
			return denied(input as never, init);
		}) as unknown as HttpLike;
		const handOff = () => {
			fallbackCalls++;
			return Promise.resolve({ text: fullFallbackText, model: "mimo/test" });
		};

		const out = await runJevDecide(
			params,
			deps({ circuit, fetchImpl: counting, fallback: handOff })
		);
		expect(jevCalls).toBe(1); // exactly one attempt - no retry
		expect(fallbackCalls).toBe(1); // main model took over
		expect(out.source).toBe("fallback");
		expect(circuit.isOpen).toBe(true);

		// While the circuit is open, preflight skips Jev entirely.
		await runJevDecide(params, deps({ circuit, fetchImpl: counting, fallback: handOff }));
		expect(jevCalls).toBe(1); // still 1 - no second attempt while open
		expect(fallbackCalls).toBe(2);
	});

	test("capacity HTTP error falls back and opens circuit", async () => {
		const circuit = new CircuitBreaker();
		let fallbackCalls = 0;
		const out = await runJevDecide(
			params,
			deps({
				circuit,
				fetchImpl: jevHttpError(503, "model at capacity"),
				fallback: async () => {
					fallbackCalls++;
					return {
						text: '{"answers":{"pick":{"type":"choice","choice":"b","confidence":0.6},"level":{"type":"score","score":1},"yesno":{"type":"noul","noul":0.4}}}',
						model: "mimo/test",
					};
				},
			})
		);
		expect(fallbackCalls).toBe(1);
		expect(out.source).toBe("fallback");
		expect(out.model).toBe("mimo/test");
		expect(out.fallbackReason).toContain("503");
		expect(out.answers.yesno).toEqual({ type: "noul", noul: 0.4 });
		expect(circuit.isOpen).toBe(true);
	});

	test("preflight: open circuit skips Jev fetch entirely", async () => {
		const circuit = new CircuitBreaker(60_000, () => 0);
		circuit.recordFailure();
		let fetchCalls = 0;
		const out = await runJevDecide(
			params,
			deps({
				circuit,
				fetchImpl: async () => {
					fetchCalls++;
					return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
				},
				fallback: fallbackOk(),
			})
		);
		expect(fetchCalls).toBe(0);
		expect(out.source).toBe("fallback");
		expect(out.fallbackReason).toContain("circuit open");
	});

	test("missing API key skips Jev and falls back", async () => {
		let fetchCalls = 0;
		const out = await runJevDecide(
			params,
			deps({
				apiKey: undefined,
				fetchImpl: async () => {
					fetchCalls++;
					return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
				},
				fallback: fallbackOk(),
			})
		);
		expect(fetchCalls).toBe(0);
		expect(out.fallbackReason).toContain("JEVMODEL_API_KEY");
	});

	test("non-capacity error throws without fallback", async () => {
		let fallbackCalls = 0;
		await expect(
			runJevDecide(
				params,
				deps({
					fetchImpl: jevHttpError(422, '{"error":"questions must be object"}'),
					fallback: async () => {
						fallbackCalls++;
						return { text: "{}", model: "mimo/test" };
					},
				})
			)
		).rejects.toThrow("Jev API 422");
		expect(fallbackCalls).toBe(0);
	});

	test("network failure falls back", async () => {
		const circuit = new CircuitBreaker();
		const out = await runJevDecide(
			params,
			deps({
				circuit,
				fetchImpl: jevNetworkError(),
				fallback: fallbackOk(),
			})
		);
		expect(out.source).toBe("fallback");
		expect(out.fallbackReason).toContain("unreachable");
		expect(circuit.isOpen).toBe(true);
	});

	test("abort is rethrown, no fallback, circuit untouched", async () => {
		const circuit = new CircuitBreaker();
		const abort = new Error("aborted");
		abort.name = "AbortError";
		let fallbackCalls = 0;
		await expect(
			runJevDecide(
				params,
				deps({
					circuit,
					fetchImpl: async () => {
						throw abort;
					},
					fallback: async () => {
						fallbackCalls++;
						return { text: "{}", model: "mimo/test" };
					},
				})
			)
		).rejects.toThrow("aborted");
		expect(fallbackCalls).toBe(0);
		expect(circuit.isOpen).toBe(false);
	});

	test("fallback failure surfaces both causes", async () => {
		await expect(
			runJevDecide(
				params,
				deps({
					fetchImpl: jevHttpError(429, "rate limited"),
					fallback: async () => {
						throw new Error("fallback model offline");
					},
				})
			)
		).rejects.toThrow(/Jev unavailable \(jev HTTP 429.*\) and fallback failed: fallback model offline/);
	});
});

describe("toFullUsage", () => {
	test("fills missing cost and totalTokens", () => {
		expect(toFullUsage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 })).toEqual({
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});

	test("preserves existing cost and totalTokens", () => {
		const full = {
			input: 2,
			output: 3,
			cacheRead: 4,
			cacheWrite: 1,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.01, total: 0.34 },
		};
		expect(toFullUsage(full)).toEqual(full);
	});
});

// ---------------------------------------------------------------------------
// fallback prompt content
// ---------------------------------------------------------------------------

describe("buildFallbackMessages", () => {
	test("contains state and questions JSON", () => {
		const { systemPrompt, userText } = buildFallbackMessages("STATE-TEXT", questions);
		expect(systemPrompt).toContain("decision engine");
		expect(userText).toContain("STATE-TEXT");
		expect(userText).toContain('"yesno"');
		expect(userText).toContain('"noul"');
	});
});

// ---------------------------------------------------------------------------
// argument coercion: weaker session models JSON-encode nested objects
// ---------------------------------------------------------------------------

describe("coerceQuestions", () => {
	const canonical: Questions = {
		qa: { type: "noul", instructions: "is this a test?" },
	};
	// Exact argument that pi rejected with `questions: must be object`, killing
	// 10 of 12 jev_decide calls in session 01a0eacc (mimo-v2.6-flash).
	const stringified = '{"qa":{"type":"noul","instructions":"is this a test?"}}';

	test("passes a canonical object through unchanged", () => {
		expect(coerceQuestions(canonical)).toEqual(canonical);
	});

	test("parses a JSON-encoded object into the canonical shape", () => {
		expect(coerceQuestions(stringified)).toEqual(canonical);
	});

	test("leaves question contents intact when parsing the real payload", () => {
		const out = coerceQuestions(stringified);
		expect(out.qa.type).toBe("noul");
		expect(out.qa.instructions).toBe("is this a test?");
	});

	test("rejects an unparseable string with an actionable message", () => {
		expect(() => coerceQuestions("not json")).toThrow(/unparseable string/);
	});

	test.each([
		["array", "[1,2]", /got array/],
		["null", "null", /got null/],
		["number", "42", /got number/],
		["string-in-string", '"hi"', /got string/],
		["raw null", null, /got null/],
		["raw number", 42, /got number/],
		["raw array", [1, 2], /got array/],
	])("rejects %s", (_label, input, expected) => {
		expect(() => coerceQuestions(input)).toThrow(expected);
	});
});

// ---------------------------------------------------------------------------
// model alias plumbing (params.model was dead code: read as params.modelAlias)
// ---------------------------------------------------------------------------

describe("model alias", () => {
	/** Captures the JSON body sent to Jev so we can assert on `model`. */
	function capturingFetch(seen: string[]): HttpLike {
		const payload = {
			model: "jev-1.13.0",
			answers: validJevAnswers,
			usage: { input_tokens: 1, output_tokens: 1 },
		};
		return (async (_input: unknown, init: { body: string }) => {
			seen.push(init.body);
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify(payload),
				json: async () => payload,
			};
		}) as unknown as HttpLike;
	}

	const sentModel = (body: string[]) => JSON.parse(body[0]).model as string;

	test("sends params.model as the request model", async () => {
		const body: string[] = [];
		await runJevDecide({ ...params, model: "my-alias" }, deps({ fetchImpl: capturingFetch(body) }));
		expect(sentModel(body)).toBe("my-alias");
	});

	test("defaults to jev-latest when no model is given", async () => {
		const body: string[] = [];
		await runJevDecide(params, deps({ fetchImpl: capturingFetch(body) }));
		expect(sentModel(body)).toBe("jev-latest");
	});

	test("uses deps.modelAlias when params.model is absent", async () => {
		const body: string[] = [];
		await runJevDecide(
			params,
			deps({ fetchImpl: capturingFetch(body), modelAlias: "alias-from-deps" })
		);
		expect(sentModel(body)).toBe("alias-from-deps");
	});

	test("params.model wins over deps.modelAlias", async () => {
		const body: string[] = [];
		await runJevDecide(
			{ ...params, model: "my-alias" },
			deps({ fetchImpl: capturingFetch(body), modelAlias: "alias-from-deps" })
		);
		expect(sentModel(body)).toBe("my-alias");
	});

	test("outcome reports the server model when the response includes one", async () => {
		const out = await runJevDecide(
			{ ...params, model: "my-alias" },
			deps({ fetchImpl: jevOk() })
		);
		expect(out.model).toBe("jev-1.13.0");
	});

	test("outcome falls back to params.model when the response omits model", async () => {
		const out = await runJevDecide(
			{ ...params, model: "my-alias" },
			deps({ fetchImpl: jevOk({ model: undefined }) })
		);
		expect(out.model).toBe("my-alias");
	});

	test("outcome falls back to jev-latest when nothing supplies a model", async () => {
		const out = await runJevDecide(params, deps({ fetchImpl: jevOk({ model: undefined }) }));
		expect(out.model).toBe("jev-latest");
	});
});

// ---------------------------------------------------------------------------
// bounded repair of malformed JSON strings
// ---------------------------------------------------------------------------

describe("coerceQuestions bounded repair", () => {
	// Real payload from session 01a0eacc line 117: one extra trailing `}`.
	const extraBrace = '{"qa": {"type": "noul", "instructions": "is this a test?"}}}';
	const expected: Questions = { qa: { type: "noul", instructions: "is this a test?" } };

	test("repairs a single unbalanced trailing brace (real session payload)", () => {
		expect(coerceQuestions(extraBrace)).toEqual(expected);
	});

	test("repairs multiple unbalanced trailing braces", () => {
		expect(coerceQuestions('{"qa":{"type":"noul","instructions":"x"}}}}}')).toEqual({
			qa: { type: "noul", instructions: "x" },
		});
	});

	test("leaves already-valid JSON untouched", () => {
		const valid = '{"qa":{"type":"noul","instructions":"x"}}';
		expect(coerceQuestions(valid)).toEqual(expected0(valid));
	});

	test("does NOT invent closers for truncated (unclosed) JSON", () => {
		// opens > closes: repair must never add characters, only trim excess.
		expect(() => coerceQuestions('{"qa":{"type":"noul"')).toThrow(/unparseable string/);
	});

	test("does NOT repair a missing property key - bounded means bounded", () => {
		// Real payload from session 01a0eacc line 83: second question has no key.
		const missingKey =
			'{"flaky": {"type": "noul", "instructions": "is this a bug?"}, {"type": "score", "instructions": "score it", "criteria": ["low", "high"]}}';
		expect(() => coerceQuestions(missingKey)).toThrow(/unparseable string/);
	});

	test("repair is bounded: it never trims into valid structure", () => {
		// excess closers far beyond any plausible serialization mistake
		expect(() => coerceQuestions('{"a":{"type":"noul","instructions":"x"}}}}}}}}}')).toThrow();
	});

	test("error message still names the problem", () => {
		try {
			coerceQuestions("not json");
			expect.unreachable("should have thrown");
		} catch (e) {
			expect((e as Error).message).toMatch(/unparseable string/);
			expect((e as Error).message).toContain("not json");
		}
	});
});

/** helper: parse then identity-compare */
function expected0(json: string): Questions {
	return JSON.parse(json) as Questions;
}

// ---------------------------------------------------------------------------
// what the consuming model reads back
// ---------------------------------------------------------------------------

describe("buildToolResult", () => {
	const jevOutcome = {
		source: "jev" as const,
		model: "jev-1.13.0",
		answers: { escalate: { type: "noul", noul: 0.76 } },
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};

	test("always carries a legend so the answer is self-describing", () => {
		const out = buildToolResult(jevOutcome);
		expect(typeof out.legend).toBe("string");
		expect(out.legend.length).toBeGreaterThan(40);
		// round-trip: the legend must survive serialization into the tool text
		expect(JSON.parse(JSON.stringify(out)).legend).toBe(out.legend);
		expect(out.legend).toBe(ANSWER_LEGEND);
	});

	test("legend explains noul has no confidence field", () => {
		expect(ANSWER_LEGEND).toMatch(/noul/);
		expect(ANSWER_LEGEND).toMatch(/P\(yes\)/);
		expect(ANSWER_LEGEND.toLowerCase()).toContain("no `confidence` field");
	});

	test("legend carries the three-tier gate so the answer is actionable on its own", () => {
		// The thresholds must ride along with every result - the consuming model
		// may see the legend without the tool prompt (e.g. replayed logs).
		expect(ANSWER_LEGEND).toContain(">= 0.9");
		expect(ANSWER_LEGEND).toContain("<= 0.1");
		expect(ANSWER_LEGEND.toLowerCase()).toContain("weak signal");
		expect(ANSWER_LEGEND.toLowerCase()).toContain("no signal");
	});

	test("legend warns that score may be fractional", () => {
		expect(ANSWER_LEGEND.toLowerCase()).toContain("fractional");
	});

	test("legend explains probabilities and the fallback source", () => {
		expect(ANSWER_LEGEND).toContain("probabilities");
		expect(ANSWER_LEGEND).toContain("fallback");
	});

	test("omits fallbackReason when the call succeeded via Jev", () => {
		expect(buildToolResult(jevOutcome)).not.toHaveProperty("fallbackReason");
	});

	test("keeps fallbackReason when the session model answered", () => {
		const out = buildToolResult({ ...jevOutcome, source: "fallback", fallbackReason: "jev HTTP 502" });
		expect(out.source).toBe("fallback");
		expect(out.fallbackReason).toBe("jev HTTP 502");
	});

	test("answers pass through untouched", () => {
		expect(buildToolResult(jevOutcome).answers).toEqual(jevOutcome.answers);
	});
});

describe("ANSWER_LEGEND covers the fields Jev actually returns", () => {
	test("explains the per-question legend that maps level index to label", () => {
		// observed live: score answers carry legend: {"0":"low","1":"medium",...}
		expect(ANSWER_LEGEND).toContain("its own `legend` maps level index");
	});

	test("disambiguates the top-level legend from a per-answer legend", () => {
		expect(ANSWER_LEGEND).toContain("THIS note, not part of any answer");
	});

	test("explains probabilities over score levels", () => {
		expect(ANSWER_LEGEND).toContain("probabilities");
		expect(ANSWER_LEGEND).toContain("levels");
	});

	test("every answer type Jev returns is covered by name", () => {
		for (const field of [".noul", ".choice", ".probabilities", ".confidence", ".score", "source"]) {
			expect(ANSWER_LEGEND).toContain(field);
		}
	});
});

// ---------------------------------------------------------------------------
// #4 non-JSON response, #5 request timeout, #6 Jev answer validation
// ---------------------------------------------------------------------------

/** A fetch that never resolves until its signal aborts. */
const hangUntilAbort = (async (_url: string, init: { signal?: AbortSignal }) =>
	new Promise((_resolve, reject) => {
		const sig = init.signal;
		if (!sig) return;
		if (sig.aborted) return reject(sig.reason ?? new Error("aborted"));
		sig.addEventListener("abort", () => reject(sig.reason ?? new Error("aborted")));
	})) as unknown as HttpLike;

describe("Jev response handling", () => {
	test("200 with a non-JSON body raises a clear error, not a parse crash", async () => {
		const html = (async () => ({
			ok: true,
			status: 200,
			text: async () => "<html><body>502 Bad Gateway</body></html>",
		})) as unknown as HttpLike;
		await expect(runJevDecide(params, deps({ fetchImpl: html }))).rejects.toThrow(
			/non-JSON body/
		);
	});

	test("the non-JSON error quotes the offending body so it is debuggable", async () => {
		const html = (async () => ({
			ok: true,
			status: 200,
			text: async () => "<html><body>502 Bad Gateway</body></html>",
		})) as unknown as HttpLike;
		await expect(runJevDecide(params, deps({ fetchImpl: html }))).rejects.toThrow(
			/502 Bad Gateway/
		);
	});

	test("a hung Jev request times out and the main model takes over", async () => {
		const circuit = new CircuitBreaker();
		let fallbackCalls = 0;
		const out = await runJevDecide(
			params,
			deps({
				circuit,
				fetchImpl: hangUntilAbort,
				timeoutMs: 30,
				fallback: async () => {
					fallbackCalls++;
					return { text: fullFallbackText, model: "mimo/test" };
				},
			})
		);
		expect(fallbackCalls).toBe(1);
		expect(out.source).toBe("fallback");
		expect(circuit.isOpen).toBe(true);
	});

	test("the timeout reason is reported to the consumer", async () => {
		const out = await runJevDecide(
			params,
			deps({
				fetchImpl: hangUntilAbort,
				timeoutMs: 30,
				fallback: async () => ({ text: fullFallbackText, model: "mimo/test" }),
			})
		);
		expect(out.fallbackReason).toMatch(/timed out after 30ms/);
	});

	test("caller abort is rethrown and does NOT trigger the fallback", async () => {
		const ac = new AbortController();
		let fallbackCalls = 0;
		const promise = runJevDecide(
			params,
			deps({
				fetchImpl: hangUntilAbort,
				signal: ac.signal,
				timeoutMs: 60_000,
				fallback: async () => {
					fallbackCalls++;
					return { text: fullFallbackText, model: "mimo/test" };
				},
			})
		);
		ac.abort();
		await expect(promise).rejects.toThrow();
		expect(fallbackCalls).toBe(0);
	});
});

describe("validateJevAnswers", () => {
	const good = {
		pick: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } },
		level: {
			type: "score",
			score: 1.5,
			confidence: 0.7,
			legend: { "0": "low", "1": "mid", "2": "high" },
			probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
		},
		yesno: { type: "noul", noul: 0.5 },
	};

	test("valid answers pass through untouched, including legend and probabilities", () => {
		expect(validateJevAnswers(good, questions)).toEqual(good);
	});

	test("every question must be answered", () => {
		const { yesno: _dropped, ...rest } = good;
		expect(() => validateJevAnswers(rest, questions)).toThrow(
			/omitted answer for question "yesno"/
		);
	});

	test("answers must be an object", () => {
		expect(() => validateJevAnswers([1, 2], questions)).toThrow(/"answers" object/);
		expect(() => validateJevAnswers(null, questions)).toThrow(/"answers" object/);
		expect(() => validateJevAnswers(undefined, questions)).toThrow(/"answers" object/);
	});

	test("answer type must match the question type", () => {
		expect(() =>
			validateJevAnswers({ ...good, pick: { ...good.pick, type: "noul" } }, questions)
		).toThrow(/type/);
	});

	test("choice must be one of the question's criteria keys", () => {
		expect(() =>
			validateJevAnswers({ ...good, pick: { ...good.pick, choice: "zzz" } }, questions)
		).toThrow(/invalid choice/);
	});

	test("score must be numeric", () => {
		expect(() =>
			validateJevAnswers({ ...good, level: { ...good.level, score: "high" } }, questions)
		).toThrow(/non-numeric score/);
	});

	test("noul must be a probability in 0..1", () => {
		expect(() =>
			validateJevAnswers({ ...good, yesno: { ...good.yesno, noul: 88 } }, questions)
		).toThrow(/0\.\.1/);
		expect(() =>
			validateJevAnswers({ ...good, yesno: { ...good.yesno, noul: -0.2 } }, questions)
		).toThrow(/0\.\.1/);
	});

	test("an invalid Jev answer blocks the request end to end", async () => {
		const bad = (async () => ({
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({ model: "jev-latest", answers: { pick: { type: "choice", choice: "nope" } } }),
		})) as unknown as HttpLike;
		await expect(runJevDecide(params, deps({ fetchImpl: bad }))).rejects.toThrow(
			/invalid choice/
		);
	});
});

// ---------------------------------------------------------------------------
// precise, single-cause validation errors (and the documented API limits)
// ---------------------------------------------------------------------------

describe("explainQuestionProblems", () => {
	const q = (over: Record<string, unknown>) => ({ q: { type: "noul", instructions: "x", ...over } });

	test("a valid question set reports no problems", () => {
		expect(explainQuestionProblems({ ok: { type: "noul", instructions: "yes/no?" } })).toEqual([]);
		expect(
			explainQuestionProblems({
				a: { type: "choice", instructions: "pick", criteria: { x: "first", y: "second" } },
				b: { type: "score", instructions: "rate", criteria: ["low", "high"] },
				c: { type: "noul", instructions: "is it?" },
			})
		).toEqual([]);
	});

	test("noul + array criteria names the field and the fix, not the union", () => {
		const problems = explainQuestionProblems(q({ criteria: ["yes", "no"] }));
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('questions["q"].criteria');
		expect(problems[0]).toContain("map");
		expect(problems[0]).toContain("422");
	});

	test("choice criteria must be an object, not an array", () => {
		const problems = explainQuestionProblems({
			q: { type: "choice", instructions: "x", criteria: ["a", "b"] },
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('questions["q"].criteria');
		expect(problems[0]).toContain("object");
	});

	test("score criteria must be an array, not a map", () => {
		const problems = explainQuestionProblems({
			q: { type: "score", instructions: "x", criteria: { a: "A" } },
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("array");
	});

	test("an unknown type lists the allowed values", () => {
		const problems = explainQuestionProblems({ q: { type: "yesno", instructions: "x" } });
		expect(problems[0]).toContain('questions["q"].type');
		expect(problems[0]).toContain("choice");
		expect(problems[0]).toContain("score");
		expect(problems[0]).toContain("noul");
	});

	test("missing instructions names the field", () => {
		expect(explainQuestionProblems({ q: { type: "noul" } })[0]).toContain("instructions");
	});

	test("documented limits are enforced with the limit in the message", () => {
		const choice = (n: number) =>
			Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, `option ${i}`]));
		expect(
			explainQuestionProblems({ q: { type: "choice", instructions: "x", criteria: choice(1) } })[0]
		).toContain("2-20");
		expect(
			explainQuestionProblems({ q: { type: "choice", instructions: "x", criteria: choice(21) } })[0]
		).toContain("2-20");
		const levels = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`);
		expect(
			explainQuestionProblems({ q: { type: "score", instructions: "x", criteria: levels(1) } })[0]
		).toContain("2-10");
		expect(
			explainQuestionProblems({ q: { type: "score", instructions: "x", criteria: levels(11) } })[0]
		).toContain("2-10");
	});

	test("at most 8 questions and identifier keys of <= 64 chars", () => {
		const nine = Object.fromEntries(
			Array.from({ length: 9 }, (_, i) => [`q${i}`, { type: "noul", instructions: "x" }])
		);
		expect(explainQuestionProblems(nine)[0]).toContain("8");

		expect(
			explainQuestionProblems({ [`k`.repeat(65)]: { type: "noul", instructions: "x" } })[0]
		).toContain("64");
	});

	test("every problem is reported at once, one per line", () => {
		const problems = explainQuestionProblems({
			a: { type: "nope" },
			b: { type: "noul", instructions: "x", criteria: ["y"] },
		});
		expect(problems).toHaveLength(2);
		expect(problems.every((p) => p.startsWith('questions['))).toBe(true);
	});

	test("a non-object question is reported, not thrown as a TypeError", () => {
		expect(explainQuestionProblems({ q: "noul" })[0]).toContain('questions["q"]');
	});
});
