import { describe, expect, test } from "bun:test";

import {
	ANSWER_LEGEND,
	buildFallbackMessages,
	buildToolResult,
	CircuitBreaker,
	coerceQuestions,
	explainQuestionProblems,
	extractJsonObject,
	fromClassifierAnswers,
	normalizeAnswers,
	runJevDecide,
	toClassifierQuestions,
	toClassifierState,
	toFullUsage,
	validateJevAnswers,
	type ClassifyFn,
	type ClassifyOutcome,
	type DecideParams,
	type FallbackResult,
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
const fullFallbackText =
	'{"answers":{"pick":{"type":"choice","choice":"a"},"level":{"type":"score","score":1},"yesno":{"type":"noul","noul":0.5}}}';

function fallbackOk(text: string = fullFallbackText): (p: DecideParams) => Promise<FallbackResult> {
	return async () => ({ text, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, model: "mimo/test" });
}

function deps(overrides: Partial<Parameters<typeof runJevDecide>[1]>) {
	return {
		circuit: new CircuitBreaker(),
		fallback: fallbackOk(),
		classify: classifySuccess,
		...overrides,
	};
}

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
	test("happy path: default deps answer via Jev with full usage", async () => {
		const circuit = new CircuitBreaker();
		const out = await runJevDecide(params, deps({ circuit }));
		expect(out.source).toBe("jev");
		expect(out.model).toBe("typesafe/jev-latest");
		expect(out.answers).toEqual({
			pick: piAnswers.pick,
			level: {
				type: "score",
				score: 1,
				confidence: 0.7,
				legend: { 0: "low", 1: "mid", 2: "high" },
			},
			yesno: { type: "noul", noul: 0.5 },
		});
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
				classify: classifyDown,
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
				classify: classifyDown,
				fallback: async () => ({ text: fullFallbackText, model: "mimo/test" }),
			})
		);
		expect(out.usage).toBeUndefined();
	});

	test("preflight: open circuit skips the classifier entirely", async () => {
		const circuit = new CircuitBreaker(60_000, () => 0);
		circuit.recordFailure();
		let classifyCalls = 0;
		const out = await runJevDecide(
			params,
			deps({
				circuit,
				classify: async () => {
					classifyCalls++;
					return { ok: true, model: "typesafe/jev-latest", answers: piAnswers };
				},
			})
		);
		expect(classifyCalls).toBe(0);
		expect(out.source).toBe("fallback");
		expect(out.fallbackReason).toContain("circuit open");
	});

	test("fallback failure surfaces both causes", async () => {
		await expect(
			runJevDecide(
				params,
				deps({
					classify: classifyDown,
					fallback: async () => {
						throw new Error("fallback model offline");
					},
				})
			)
		).rejects.toThrow(/Jev unavailable \(classify down.*\) and fallback failed: fallback model offline/);
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

// ---------------------------------------------------------------------------
// pi classifier transport: pure mapping helpers
// ---------------------------------------------------------------------------

/** What pi's classifier answer parser returns for `questions` (noul arrives as bool). */
const piAnswers = {
	pick: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } },
	level: { type: "score", score: 1, confidence: 0.7 },
	yesno: { type: "bool", probability: 0.5 },
};

describe("toClassifierQuestions", () => {
	test("choice and score pass through unchanged", () => {
		const out = toClassifierQuestions({ pick: questions.pick, level: questions.level });
		expect(out.pick).toEqual({
			type: "choice",
			instructions: "pick one",
			criteria: { a: "first", b: "second" },
		});
		expect(out.level).toEqual({
			type: "score",
			instructions: "rate",
			criteria: ["low", "mid", "high"],
		});
	});

	test("noul becomes bool, recognizing yes/no labels", () => {
		const out = toClassifierQuestions({
			q: { type: "noul", instructions: "is it?", criteria: { yes: "affirmative", no: "negative" } },
		});
		expect(out.q).toEqual({
			type: "bool",
			instructions: "is it?",
			criteria: { true: "affirmative", false: "negative" },
		});
	});

	test("noul without recognizable labels gets plain branch labels", () => {
		const bare = toClassifierQuestions({ q: { type: "noul", instructions: "is it?" } });
		expect((bare.q as { criteria: unknown }).criteria).toEqual({ true: "yes", false: "no" });
		const odd = toClassifierQuestions({
			q: { type: "noul", instructions: "x", criteria: { maybe: "idk", whatever: "?" } },
		});
		expect((odd.q as { criteria: unknown }).criteria).toEqual({ true: "yes", false: "no" });
	});
});

describe("toClassifierState", () => {
	test("a JSON object passes through untouched", () => {
		expect(toClassifierState('{"a":1}')).toEqual({ a: 1 });
	});

	test("plain text is wrapped, never lost", () => {
		expect(toClassifierState("just words")).toEqual({ text: "just words" });
	});

	test("JSON that is not an object is wrapped too", () => {
		expect(toClassifierState("[1,2]")).toEqual({ text: "[1,2]" });
		expect(toClassifierState('"str"')).toEqual({ text: '"str"' });
	});
});

describe("fromClassifierAnswers", () => {
	test("bool becomes noul carrying the probability", () => {
		const out = fromClassifierAnswers(piAnswers, questions);
		expect(out.yesno).toEqual({ type: "noul", noul: 0.5 });
	});

	test("score regains its legend from the question's own criteria", () => {
		const out = fromClassifierAnswers(piAnswers, questions);
		expect(out.level).toEqual({
			type: "score",
			score: 1,
			confidence: 0.7,
			legend: { 0: "low", 1: "mid", 2: "high" },
		});
	});

	test("choice passes through with distribution and confidence", () => {
		const out = fromClassifierAnswers(piAnswers, questions);
		expect(out.pick).toEqual(piAnswers.pick);
	});

	test("a missing answer is omitted so validate names the key", () => {
		const out = fromClassifierAnswers({ yesno: piAnswers.yesno }, questions);
		expect(out.pick).toBeUndefined();
		expect(() => validateJevAnswers(out, questions)).toThrow('omitted answer for question "pick"');
	});
});

// ---------------------------------------------------------------------------
// pi classifier transport: runJevDecide flow
// ---------------------------------------------------------------------------

const classifySuccess: ClassifyFn = async () => ({
	ok: true,
	model: "typesafe/jev-latest",
	answers: piAnswers,
	usage: {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});

/** A classifier that cannot serve right now (auth, capacity, upstream). */
const classifyDown: ClassifyFn = async () => ({ ok: false, reason: "classify down" });

/** Rejects like a signal-aborted classify call (pi never resolves after abort). */
function abortRejecting(signal: AbortSignal): Promise<ClassifyOutcome> {
	return new Promise<ClassifyOutcome>((_, reject) => {
		const abort = () => {
			const e = new Error("aborted");
			e.name = "AbortError";
			reject(e);
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

describe("runJevDecide via classify transport", () => {
	test("success: answers mapped onto the jev_decide contract, pi model label, usage", async () => {
		const circuit = new CircuitBreaker();
		const out = await runJevDecide(params, deps({ circuit, classify: classifySuccess }));
		expect(out.source).toBe("jev");
		expect(out.model).toBe("typesafe/jev-latest");
		expect(out.answers.yesno).toEqual({ type: "noul", noul: 0.5 });
		expect(out.answers.level).toEqual({
			type: "score",
			score: 1,
			confidence: 0.7,
			legend: { 0: "low", 1: "mid", 2: "high" },
		});
		expect(out.usage?.totalTokens).toBe(15);
		expect(circuit.isOpen).toBe(false);
	});

	test("success without usage leaves usage undefined", async () => {
		const out = await runJevDecide(
			params,
			deps({
				classify: async () => ({ ok: true, model: "typesafe/jev-latest", answers: piAnswers }),
			})
		);
		expect(out.source).toBe("jev");
		expect(out.usage).toBeUndefined();
	});

	test("provider failure falls back, opens the circuit, and the next call skips classify", async () => {
		const circuit = new CircuitBreaker();
		let classifyCalls = 0;
		let fallbackCalls = 0;
		const failing = async (): Promise<ClassifyOutcome> => {
			classifyCalls++;
			return {
				ok: false,
				reason: "classify typesafe/jev-latest: No API key for provider: typesafe",
			};
		};
		const handOff = () => {
			fallbackCalls++;
			return Promise.resolve({ text: fullFallbackText, model: "mimo/test" });
		};

		const out = await runJevDecide(params, deps({ circuit, classify: failing, fallback: handOff }));
		expect(out.source).toBe("fallback");
		expect(out.fallbackReason).toContain("No API key");
		expect(classifyCalls).toBe(1);
		expect(circuit.isOpen).toBe(true);

		await runJevDecide(params, deps({ circuit, classify: failing, fallback: handOff }));
		expect(classifyCalls).toBe(1); // circuit preflight - no second attempt while open
		expect(fallbackCalls).toBe(2);
	});

	test("a stated preflight reason skips the classifier entirely", async () => {
		let classifyCalls = 0;
		const out = await runJevDecide(
			params,
			deps({
				fallback: fallbackOk(),
				preflightReason: "no credentialed classifier model (set TYPESAFE_API_KEY)",
				classify: async () => {
					classifyCalls++;
					return { ok: true, model: "x/y", answers: piAnswers };
				},
			})
		);
		expect(out.source).toBe("fallback");
		expect(out.fallbackReason).toBe("no credentialed classifier model (set TYPESAFE_API_KEY)");
		expect(classifyCalls).toBe(0);
	});

	test("a hung classifier times out and hands off", async () => {
		const circuit = new CircuitBreaker();
		const out = await runJevDecide(
			params,
			deps({ circuit, timeoutMs: 5, classify: (_p, signal) => abortRejecting(signal) })
		);
		expect(out.source).toBe("fallback");
		expect(out.fallbackReason).toContain("timed out after 5ms");
		expect(circuit.isOpen).toBe(true); // a timeout is a capacity failure
	});

	test("caller abort propagates instead of falling back", async () => {
		const ac = new AbortController();
		ac.abort();
		const circuit = new CircuitBreaker();
		let fallbackCalls = 0;
		await expect(
			runJevDecide(
				params,
				deps({
					signal: ac.signal,
					circuit,
					classify: (_p, signal) => abortRejecting(signal),
					fallback: async () => {
						fallbackCalls++;
						return { text: fullFallbackText, model: "mimo/test" };
					},
				})
			)
		).rejects.toThrow("aborted");
		expect(fallbackCalls).toBe(0); // cancellation is not a Jev failure
		expect(circuit.isOpen).toBe(false);
	});

	test("an unexpected classify throw falls back with the error", async () => {
		const out = await runJevDecide(
			params,
			deps({
				fallback: fallbackOk(),
				classify: async () => {
					throw new TypeError("registry exploded");
				},
			})
		);
		expect(out.source).toBe("fallback");
		expect(out.fallbackReason).toContain("classify failed: registry exploded");
	});

	test("an answer outside the asked criteria fails loudly, never silently", async () => {
		// pi's parser only checks the answer is a string - a choice not in criteria
		// must still surface as an error, not reach the consuming model.
		await expect(
			runJevDecide(
				params,
				deps({
					classify: async () => ({
						ok: true,
						model: "typesafe/jev-latest",
						answers: { ...piAnswers, pick: { type: "choice", choice: "zzz" } },
					}),
				})
			)
		).rejects.toThrow("invalid choice");
	});
});
