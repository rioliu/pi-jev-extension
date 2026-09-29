/**
 * Schema + normalization check for the jev_decide parameter contract.
 *
 * Why a script and not a `bun test` file: the pi packages
 * (@earendil-works/pi-ai, pi-coding-agent) resolve from the bun global install
 * cache under `bun run`, but `bun test` does not consult that cache, so any test
 * importing them fails with "Cannot find module". Unit tests for the pure
 * normalizer live in lib.test.ts; this script covers the parts that need pi's
 * real validator.
 *
 * Run:  bun run schema-check.ts     (exits non-zero on failure)
 *
 * The invariant it defends: a malformed `questions` argument must never reach
 * the Jev API - either pi's schema rejects it, or coerceQuestions() throws.
 */

import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";

import { coerceQuestions, ANSWER_LEGEND, type Questions } from "./lib.ts";
import { jevTool, normalizeQuestions } from "./index.ts";

let failures = 0;
const ok = (msg: string) => console.log(`ok  : ${msg}`);
const fail = (msg: string) => {
	failures++;
	console.error(`FAIL: ${msg}`);
};
const assert = (cond: boolean, msg: string) => (cond ? ok(msg) : fail(msg));

const acceptsSchema = async (questions: unknown): Promise<boolean> => {
	try {
		await validateToolArguments(jevTool, {
			type: "toolCall",
			id: "schema-check",
			name: "jev_decide",
			arguments: { state: "test payload", questions: questions as never },
		} as ToolCall);
		return true;
	} catch {
		return false;
	}
};

/** True only when BOTH the schema and the normalizer let the value through. */
const reachesJev = async (questions: unknown): Promise<boolean> => {
	if (!(await acceptsSchema(questions))) return false;
	try {
		normalizeQuestions(questions); // coerce + validate, exactly as execute() does
		return true;
	} catch {
		return false;
	}
};

// Exact argument pi rejected with `questions: must be object`, which failed
// 10 of 12 jev_decide calls in session 01a0eacc (model mimo-v2.6-flash).
const STRINGIFIED = '{"qa":{"type":"noul","instructions":"is this a test?"}}';
const CANONICAL: Questions = { qa: { type: "noul", instructions: "is this a test?" } };

// Real payloads recovered from session 01a0eacc.
const EXTRA_BRACE = '{"qa": {"type": "noul", "instructions": "is this a test?"}}}';
const MISSING_KEY =
	'{"flaky": {"type": "noul", "instructions": "is this a bug?"}, {"type": "score", "instructions": "score it", "criteria": ["low", "high"]}}';

const main = async () => {
	// --- accepted forms ---
	assert(await acceptsSchema(CANONICAL), "schema accepts the canonical object form");
	assert(await acceptsSchema(STRINGIFIED), "schema accepts a JSON-encoded string (regression)");
	assert(
		JSON.stringify(coerceQuestions(STRINGIFIED)) === JSON.stringify(CANONICAL),
		"string input normalizes to the canonical object"
	);

	// --- bounded repair, from the real failed payloads ---
	assert(
		JSON.stringify(normalizeQuestions(EXTRA_BRACE)) === JSON.stringify(CANONICAL),
		"recovers the real payload with an extra trailing brace"
	);
	assert(!(await reachesJev(MISSING_KEY)), "missing-key payload still blocked (bounded repair)");

	// --- rejected forms ---
	assert(!(await acceptsSchema([1, 2])), "schema rejects an array");

	// noul.criteria is a MAP. Verified against the live API: an array returns 422,
	// a dict returns 200. The schema is deliberately loose so pi passes the payload
	// through; the combined barrier (schema + explainQuestionProblems) is what must
	// hold - and 422 is a surfaced error, not a fallback.
	assert(
		await reachesJev({
			q: { type: "noul", instructions: "x", criteria: { yes: "affirmative", no: "negative" } },
		}),
		"noul with a criteria MAP reaches Jev"
	);
	assert(
		!(await reachesJev({ q: { type: "noul", instructions: "x", criteria: ["yes", "no"] } })),
		"noul with a criteria ARRAY is rejected before any request (the API would 422)"
	);

	// The message the consuming model reads must name the field and the fix.
	try {
		normalizeQuestions({ q: { type: "noul", instructions: "x", criteria: ["yes", "no"] } });
		assert(false, "noul + array should have thrown a readable error");
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		assert(
			message.includes('questions["q"].criteria') && message.includes("422"),
			`error names the field and the cause (got: ${message.split("\n").slice(0, 2).join(" | ")})`
		);
		assert(
			!message.includes("must be equal to constant"),
			"error no longer contains the union red herring"
		);
	}
	// Note: pi's validator normalizes `null` in a way that lets it past the schema,
	// so the schema alone is not the barrier for null - coerceQuestions() is.
	// The `bad` list below asserts the combined invariant, which is what matters.

	// --- the invariant: nothing malformed passes both barriers ---
	const bad: Array<[string, unknown]> = [
		["array", [1, 2]],
		["null", null],
		["number", 42],
		["unparseable string", "not json"],
		["string-in-string", '"hi"'],
		["bare string", "hello"],
	];
	for (const [label, value] of bad) {
		assert(!(await reachesJev(value)), `blocked before Jev: ${label}`);
	}

	// --- tool definition integrity (guards the prompt the consuming model sees) ---
	const desc = jevTool.description;

	/** One clause per `+` segment - if a segment collapses, a clause goes missing. */
	const REQUIRED_DESC_CLAUSES = [
		"Ask the Jev decision model",
		"Pass the decision context as 'state'",
		"it only returns choices, scores, and probabilities",
		"If Jev capacity is unavailable the tool automatically falls back",
		"less calibrated second opinions",
	];

	const concatProblems = (d: string): string[] => {
		const problems: string[] = [];
		if (d.includes("NaN")) problems.push("contains NaN (stray unary + in concatenation)");
		if (d.includes("[object Object]")) problems.push("contains [object Object]");
		for (const clause of REQUIRED_DESC_CLAUSES) {
			if (!d.includes(clause)) problems.push(`missing clause: "${clause}"`);
		}
		return problems;
	};

	assert(
		concatProblems(desc).length === 0,
		`description intact (problems: ${JSON.stringify(concatProblems(desc))})`
	);
	assert(desc.includes("nested JSON object"), "description states the questions shape");
	assert(desc.includes("1-8 questions"), "description states the question limit");
	assert(desc.includes("max 8000 chars"), "description states the state limit");

	// Self-test: prove this guard would have caught the real regression, where a
	// duplicated `+` silently turned an entire segment into NaN.
	const BUGGY_DESC = desc.replace(
		"it only returns choices, scores, and probabilities. If Jev capacity is unavailable the tool automatically ",
		"NaN"
	);
	assert(
		BUGGY_DESC !== desc && concatProblems(BUGGY_DESC).length > 0,
		"guard self-test: the real NaN regression WOULD be caught"
	);

	const guidelines = (jevTool.promptGuidelines ?? []) as string[];
	assert(guidelines.length >= 7, `promptGuidelines present (${guidelines.length})`);
	assert(
		guidelines.some((g) => g.includes("Never JSON-encode it into a string")),
		"guideline warns against JSON-encoding questions"
	);
	// The consuming model must be able to READ the answer, not just ask it.
	assert(
		guidelines.some((g) => g.includes("MAY be fractional")),
		"guideline explains that score may be fractional"
	);
	assert(
		guidelines.some((g) => g.includes("NO `confidence` field")),
		"guideline explains noul has no confidence field"
	);
	assert(desc.includes("`legend`"), "description mentions the result legend");
	assert(ANSWER_LEGEND.includes("P(yes)"), "ANSWER_LEGEND documents noul semantics");
	assert(ANSWER_LEGEND.includes("fractional"), "ANSWER_LEGEND documents fractional score");
	assert(
		guidelines.every((g) => !g.includes("NaN") && !g.includes("[object Object]")),
		"no string-concat artifacts in promptGuidelines"
	);

	console.log(
		failures === 0
			? "\nschema-check: PASS"
			: `\nschema-check: ${failures} FAILURE(S)`
	);
	process.exit(failures === 0 ? 0 : 1);
};

await main();
