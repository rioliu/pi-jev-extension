/**
 * Pure logic for the jev_decide tool: circuit-breaker preflight, fallback
 * prompt building, answer normalization, and the main decide flow. No pi
 * imports - everything external is injected so this module is unit-testable
 * standalone. The only transport is pi's classifier API (ctx.modelRegistry
 * .classify), injected as ClassifyFn.
 */

export type QuestionType = "choice" | "score" | "noul";

export interface QuestionDef {
	type: QuestionType;
	instructions: string;
	criteria?: string[] | Record<string, string>;
}

export type Questions = Record<string, QuestionDef>;

export interface DecideParams {
	state: string;
	questions: Questions;
}

export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** Raw usage as read from a stream/event; cost fields may be missing. */
export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
	cost?: UsageCost;
}

/**
 * Full pi `Usage` shape. pi's footer does `usage.cost.total` on every tool
 * result usage without guarding, so anything returned as `usage` from the tool
 * MUST have `cost` and `totalTokens` or pi crashes with an uncaughtException.
 */
export interface FullUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: UsageCost;
}

/** Coerce any partial usage into the full shape pi requires (missing cost = 0). */
export function toFullUsage(u: UsageLike): FullUsage {
	const input = u.input ?? 0;
	const output = u.output ?? 0;
	const cacheRead = u.cacheRead ?? 0;
	const cacheWrite = u.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: u.totalTokens ?? input + output + cacheRead + cacheWrite,
		cost: {
			input: u.cost?.input ?? 0,
			output: u.cost?.output ?? 0,
			cacheRead: u.cost?.cacheRead ?? 0,
			cacheWrite: u.cost?.cacheWrite ?? 0,
			total: u.cost?.total ?? 0,
		},
	};
}

/**
 * Normalize the `questions` tool argument into the canonical Questions object.
 *
 * Callers (weaker session models) routinely JSON-encode nested objects:
 *   { "questions": "{\"qa\":{\"type\":\"noul\",...}}" }
 * pi validates tool arguments against the schema *before* `execute()` runs, so
 * the schema must accept a string too. This function is the single place that
 * maps both accepted shapes onto one canonical shape, so everything downstream
 * only ever sees a real object - that is where the format is standardized.
 *
 * It deliberately does NOT re-check question contents: for object input the
 * schema already did that, and for string input the caller re-validates against
 * the canonical record right after coercion.
 *
 * Throws a message naming what was actually received, so a malformed payload
 * fails locally with something actionable instead of reaching the Jev API.
 */
/** Limits published in the Jev API reference - enforced here so a caller gets a
 *  precise local error instead of a 422 from the server. */
const QUESTION_TYPES = ["choice", "score", "noul"] as const;
const MAX_QUESTIONS = 8;
const MAX_QUESTION_NAME = 64;
const MAX_INSTRUCTIONS = 1800;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 20;
const MIN_LEVELS = 2;
const MAX_LEVELS = 10;
const MAX_CRITERIA_SERIALIZED = 2000;

function kindOf(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "an array";
	return typeof v;
}

/**
 * Validate a normalized questions map and return one precise, single-cause
 * problem per line.
 *
 * This exists because the JSON-schema union errors are unreadable: a wrong
 * `criteria` shape produced five lines, four of which blamed `type` with
 * "must be equal to constant" and none of which said how to fix it. The
 * consuming model reads this message and retries, so it must name the field
 * and the correction.
 */
export function explainQuestionProblems(input: unknown): string[] {
	const problems: string[] = [];
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return [
			`questions must be an object mapping a short key to each question, got ${kindOf(input)}`,
		];
	}

	const entries = Object.entries(input as Record<string, unknown>);
	if (entries.length === 0) problems.push("questions must contain at least 1 question");
	if (entries.length > MAX_QUESTIONS) {
		problems.push(`questions: at most ${MAX_QUESTIONS} per request, got ${entries.length}`);
	}

	for (const [key, raw] of entries) {
		const where = `questions["${key}"]`;
		if (key.length > MAX_QUESTION_NAME) {
			problems.push(
				`question name "${key.slice(0, 12)}...": at most ${MAX_QUESTION_NAME} characters, got ${key.length}`
			);
		}
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			problems.push(`${where} must be an object, got ${kindOf(raw)}`);
			continue;
		}

		const { type, instructions, criteria } = raw as {
			type?: unknown;
			instructions?: unknown;
			criteria?: unknown;
		};

		if (typeof type !== "string" || !(QUESTION_TYPES as readonly string[]).includes(type)) {
			problems.push(
				`${where}.type must be one of ${QUESTION_TYPES.join(", ")}, got ${JSON.stringify(type ?? null)}`
			);
			continue;
		}

		if (typeof instructions !== "string" || instructions.trim() === "") {
			problems.push(`${where}.instructions must be a non-empty string`);
		} else if (instructions.length > MAX_INSTRUCTIONS) {
			problems.push(
				`${where}.instructions: at most ${MAX_INSTRUCTIONS} characters, got ${instructions.length}`
			);
		}

		if (criteria === undefined) {
			if (type === "choice") {
				problems.push(
					`${where}.criteria is required for a choice: an object of ${MIN_OPTIONS}-${MAX_OPTIONS} option keys`
				);
			} else if (type === "score") {
				problems.push(
					`${where}.criteria is required for a score: an array of ${MIN_LEVELS}-${MAX_LEVELS} ordered levels`
				);
			}
			continue;
		}

		if (type === "choice") {
			if (criteria === null || typeof criteria !== "object" || Array.isArray(criteria)) {
				problems.push(
					`${where}.criteria must be an object mapping option key -> description, got ${kindOf(criteria)}`
				);
				continue;
			}
			const n = Object.keys(criteria).length;
			if (n < MIN_OPTIONS || n > MAX_OPTIONS) {
				problems.push(`${where}.criteria: ${MIN_OPTIONS}-${MAX_OPTIONS} option keys, got ${n}`);
			}
		} else if (type === "score") {
			if (!Array.isArray(criteria)) {
				problems.push(
					`${where}.criteria must be an array of ordered level labels, got ${kindOf(criteria)}`
				);
				continue;
			}
			if (criteria.length < MIN_LEVELS || criteria.length > MAX_LEVELS) {
				problems.push(`${where}.criteria: ${MIN_LEVELS}-${MAX_LEVELS} levels, got ${criteria.length}`);
			}
		} else {
			// noul: criteria is optional, and when present it must be a MAP.
			if (Array.isArray(criteria)) {
				problems.push(
					`${where}.criteria must be a map like {"yes": "affirmative"} - the Jev API rejects an array with 422`
				);
				continue;
			}
			if (criteria === null || typeof criteria !== "object") {
				problems.push(
					`${where}.criteria must be a map of label -> description, got ${kindOf(criteria)}`
				);
				continue;
			}
		}

		const serialized = JSON.stringify(criteria);
		if (serialized !== undefined && serialized.length > MAX_CRITERIA_SERIALIZED) {
			problems.push(
				`${where}.criteria: at most ${MAX_CRITERIA_SERIALIZED} characters serialized, got ${serialized.length}`
			);
		}
	}
	return problems;
}

/**
 * Max unbalanced trailing closers we will trim. One or two is a serialization
 * slip; more is structurally different input, so reject rather than guess.
 */
const MAX_REPAIR_EXCESS = 3;

/**
 * Trim excess closers hanging off the end of a JSON string, e.g. `..."}}}`.
 * Returns null when there is nothing to trim, when the excess exceeds the cap,
 * or when the extra closers are not trailing - repair never adds characters and
 * never rewrites structure.
 */
function trimUnbalancedClosers(raw: string): string | null {
	const count = (re: RegExp) => (raw.match(re) ?? []).length;
	let excessCurly = count(/\}/g) - count(/\{/g);
	let excessSquare = count(/\]/g) - count(/\[/g);
	const total = excessCurly + excessSquare;
	if (total <= 0 || total > MAX_REPAIR_EXCESS) return null;

	let out = raw;
	while (out.length > 0 && (excessCurly > 0 || excessSquare > 0)) {
		const ch = out.charAt(out.length - 1);
		if (ch === "}" && excessCurly > 0) {
			out = out.slice(0, -1);
			excessCurly--;
		} else if (ch === "]" && excessSquare > 0) {
			out = out.slice(0, -1);
			excessSquare--;
		} else {
			return null; // excess closers are not trailing - do not guess
		}
	}
	return out;
}

export function coerceQuestions(input: unknown): Questions {
	let value = input;
	if (typeof value === "string") {
		const raw = value;
		try {
			value = JSON.parse(raw);
		} catch (first) {
			let repaired = false;
			const trimmed = trimUnbalancedClosers(raw);
			if (trimmed !== null) {
				try {
					value = JSON.parse(trimmed);
					repaired = true;
				} catch {
					// trimmed form still invalid - fall through to the error below
				}
			}
			if (!repaired) {
				const why = first instanceof Error ? first.message : String(first);
				throw new Error(
					`questions must be a JSON object, got an unparseable string: ${raw.slice(0, 200)} (${why})`
				);
			}
		}
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		const got = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
		throw new Error(`questions must be a JSON object, got ${got}`);
	}
	return value as Questions;
}

export interface FallbackResult {
	text: string;
	usage?: UsageLike;
	model: string;
}

export interface DecisionOutcome {
	source: "jev" | "fallback";
	model: string;
	answers: Record<string, unknown>;
	usage?: FullUsage;
	/** Present only when source === "fallback". */
	fallbackReason?: string;
}

/**
 * Shipped with every result so the consuming model can read a Jev answer
 * without having to infer the format from a bare `{type, value}` payload.
 * Keep it in sync with the spec: noul carries no confidence field, and score is
 * fractional.
 */
export const ANSWER_LEGEND =
	"Read answers[key]: `.noul` = P(yes) in 0..1 - there is deliberately NO `confidence` " +
	"field, the probability itself is the certainty; `.choice` = the selected label, with " +
	"`.probabilities` = the full distribution over your criteria keys and `.confidence` in 0..1; " +
	"`.score` = position on the criteria scale you supplied and MAY be fractional (e.g. 1.57); " +
	"its own `legend` maps level index -> your label and its `probabilities`, when present, gives " +
	"the spread over those levels, so 1.57 sits between 'medium' and 'high'. Do not assume an integer. " +
	"Gate: act only on a DECISIVE answer - choice/score `confidence` >= 0.9, or `noul` <= 0.1 or >= 0.9. " +
	"A WEAK SIGNAL (choice/score 0.5-0.9, `noul` 0.1-0.3 or 0.7-0.9) corroborates the evidence but must " +
	"never carry an irreversible action alone; NO SIGNAL (choice/score < 0.5, `noul` 0.3-0.7) is ignored " +
	"and you decide from the evidence in context. (The " +
	"top-level `legend` in this result is THIS note, not part of any answer.) " +
	"`source: \"jev\"` = answered by Jev, `source: \"fallback\"` = " +
	"answered by the session model, treat those as less calibrated. Branch on these typed " +
	"values - Jev never returns prose.";

export interface ToolResultPayload {
	source: "jev" | "fallback";
	model: string;
	/** Present only when source === "fallback". */
	fallbackReason?: string;
	legend: string;
	answers: Record<string, unknown>;
}

/** Shape the tool hands back to the consuming model. */
export function buildToolResult(outcome: DecisionOutcome): ToolResultPayload {
	return {
		source: outcome.source,
		model: outcome.model,
		...(outcome.fallbackReason ? { fallbackReason: outcome.fallbackReason } : {}),
		legend: ANSWER_LEGEND,
		answers: outcome.answers,
	};
}

export interface DeciderDeps {
	/** The transport: pi's builtin classifier API (ctx.modelRegistry.classify). */
	classify?: ClassifyFn;
	/**
	 * Stated reason no transport can run at all (e.g. no credentialed classifier
	 * model). Preempts everything, so the session model answers with this reason.
	 */
	preflightReason?: string;
	signal?: AbortSignal;
	circuit: CircuitBreaker;
	fallback: (params: DecideParams) => Promise<FallbackResult>;
	/** Max ms to wait on Jev before handing off. Defaults to DEFAULT_TIMEOUT_MS. */
	timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// pi classifier transport (ctx.modelRegistry.classify)
// ---------------------------------------------------------------------------

/**
 * Normalized result of one call through pi's classifier API.
 *
 * pi's classify() never rejects: provider, auth, and capacity failures arrive
 * as `ok: false` with a reason, which runJevDecide routes through the same
 * circuit-breaker + session-model fallback as an HTTP capacity failure.
 * `answers` are the raw classifier answer records - mapped onto the jev_decide
 * contract by fromClassifierAnswers() once the questions are known.
 */
export type ClassifyOutcome =
	| { ok: true; model: string; answers: Record<string, unknown>; usage?: UsageLike }
	| { ok: false; reason: string };

/** One classifier call; receives the same combined signal a fetch would. */
export type ClassifyFn = (params: DecideParams, signal: AbortSignal) => Promise<ClassifyOutcome>;

/** Structural twin of pi's ClassifierQuestion - lib.ts stays pi-import-free. */
export type ClassifierQuestionShape =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] }
	| { type: "bool"; instructions: string; criteria: { true: string; false: string } };

/**
 * noul.criteria is a free-form label map; pi's bool question needs fixed
 * {true, false} branch labels. Recognize true/yes and false/no keys (the shape
 * verified against the live API: {"yes": "affirmative", "no": "negative"}),
 * otherwise label the branches plainly - the probability direction (P(yes))
 * never depends on the labels.
 */
function toBoolCriteria(criteria: string[] | Record<string, string> | undefined): {
	true: string;
	false: string;
} {
	if (criteria !== undefined && !Array.isArray(criteria)) {
		const keys = Object.keys(criteria);
		const t = keys.find((k) => /^(true|yes)$/i.test(k));
		const f = keys.find((k) => /^(false|no)$/i.test(k));
		if (t !== undefined && f !== undefined) {
			return { true: criteria[t], false: criteria[f] };
		}
	}
	return { true: "yes", false: "no" };
}

/**
 * Convert validated jev_decide questions into pi's classifier question shapes:
 * the only structural change is noul -> bool (pi's wire-level name for the same
 * yes/no question). Callers must run explainQuestionProblems() first, which
 * guarantees choice carries a criteria map and score a criteria array.
 */
export function toClassifierQuestions(
	questions: Questions
): Record<string, ClassifierQuestionShape> {
	const out: Record<string, ClassifierQuestionShape> = {};
	for (const [key, q] of Object.entries(questions)) {
		if (q.type === "choice") {
			out[key] = {
				type: "choice",
				instructions: q.instructions,
				criteria: (q.criteria ?? {}) as Record<string, string>,
			};
		} else if (q.type === "score") {
			out[key] = {
				type: "score",
				instructions: q.instructions,
				criteria: (q.criteria ?? []) as string[],
			};
		} else {
			out[key] = {
				type: "bool",
				instructions: q.instructions,
				criteria: toBoolCriteria(q.criteria),
			};
		}
	}
	return out;
}

/**
 * pi's classify() takes JSON state; the tool takes raw text. A JSON object is
 * passed through untouched (a caller who structured the decision context keeps
 * that structure); anything else is wrapped under `text` so no information is
 * lost - the classifier must never see less than the direct endpoint saw.
 */
export function toClassifierState(state: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(state);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// not JSON - wrap below
	}
	return { text: state };
}

/**
 * Map classifier answers onto the jev_decide contract:
 * - bool -> noul: P(yes) is the probability, type renamed to the tool's name;
 * - score: keeps pi's {score, confidence} and regains its level legend, which
 *   pi's answer parser drops - the labels are reconstructed from the question's
 *   own criteria (never fabricated: they are exactly what the caller supplied).
 *   A level distribution cannot be reconstructed and is only present when the
 *   direct endpoint reports it.
 * - choice passes through with probabilities and confidence.
 * Keys missing from the response are omitted so validateJevAnswers() reports
 * the omission by question key.
 */
export function fromClassifierAnswers(
	raw: Record<string, unknown>,
	questions: Questions
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, q] of Object.entries(questions)) {
		const a = raw[key];
		if (typeof a !== "object" || a === null || Array.isArray(a)) continue;
		const obj = a as Record<string, unknown>;
		if (q.type === "noul" && obj.type === "bool") {
			const { type: _type, probability, ...rest } = obj;
			out[key] = { ...rest, type: "noul", noul: probability };
		} else if (q.type === "score" && obj.type === "score") {
			const legend: Record<string, string> = {};
			if (Array.isArray(q.criteria)) {
				q.criteria.forEach((label, i) => {
					legend[String(i)] = label;
				});
			}
			out[key] = { ...obj, legend: (obj.legend as unknown) ?? legend };
		} else {
			// choice passes through; a type mismatch is passed through too, so
			// validateJevAnswers() can name it with the question key.
			out[key] = obj;
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Circuit breaker (the preflight check)
// ---------------------------------------------------------------------------

/**
 * Remembers capacity failures so subsequent calls skip Jev entirely during the
 * cooldown window and go straight to the fallback. After the cooldown one
 * attempt is allowed through (half-open); success closes, failure reopens.
 */
export class CircuitBreaker {
	private openedAt: number | undefined;

	constructor(
		private readonly cooldownMs: number = 60_000,
		private readonly now: () => number = Date.now
	) {}

	/** Preflight: true when a Jev attempt is worth making. */
	canAttempt(): boolean {
		if (this.openedAt === undefined) return true;
		if (this.now() - this.openedAt >= this.cooldownMs) {
			this.openedAt = undefined; // half-open: let one attempt through
			return true;
		}
		return false;
	}

	recordFailure(): void {
		this.openedAt = this.now();
	}

	recordSuccess(): void {
		this.openedAt = undefined;
	}

	get isOpen(): boolean {
		if (this.openedAt === undefined) return false;
		return this.now() - this.openedAt < this.cooldownMs;
	}
}

// ---------------------------------------------------------------------------
// Fallback prompt
// ---------------------------------------------------------------------------

const FALLBACK_SYSTEM_PROMPT = `You are a decision engine answering typed questions. Respond with ONLY a JSON object - no prose, no markdown fences.

Output shape: {"answers": {"<questionKey>": <answer>}}

Answer shapes by question type:
- choice: {"type":"choice","choice":"<exactly one of the criteria keys>","confidence":<0..1>,"probabilities":{"<key>":<0..1>, ...}}
- score: {"type":"score","score":<number from 0 to criteria.length-1>,"confidence":<0..1>}
- noul: {"type":"noul","noul":<probability that the answer is yes, 0..1>}

Rules:
- Include every question key exactly once, echoing its "type".
- Judge ONLY from the STATE provided; do not bring outside knowledge about its subject.
- probabilities for a choice should sum to approximately 1.
- Be calibrated: confidence reflects how well the state supports a decisive answer.`;

export function buildFallbackMessages(
	state: string,
	questions: Questions
): { systemPrompt: string; userText: string } {
	const userText = [
		"STATE:",
		state,
		"",
		"QUESTIONS:",
		JSON.stringify(questions, null, 2),
	].join("\n");
	return { systemPrompt: FALLBACK_SYSTEM_PROMPT, userText };
}

// ---------------------------------------------------------------------------
// Parsing / normalization
// ---------------------------------------------------------------------------

/** Extract the first balanced JSON object from model output (fences/prose tolerated). */
export function extractJsonObject(text: string): Record<string, unknown> {
	let t = text.trim();
	const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) t = fence[1].trim();

	const start = t.indexOf("{");
	if (start === -1) throw new Error(`No JSON object in fallback output: ${snippet(text)}`);

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < t.length; i++) {
		const ch = t[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				const parsed = JSON.parse(t.slice(start, i + 1));
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					throw new Error(`Fallback output is not a JSON object: ${snippet(text)}`);
				}
				return parsed as Record<string, unknown>;
			}
		}
	}
	throw new Error(`Unbalanced JSON in fallback output: ${snippet(text)}`);
}

function toNumber(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v === "string") {
		const n = parseFloat(v);
		return Number.isFinite(n) ? n : NaN;
	}
	return NaN;
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

function snippet(text: string): string {
	return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/**
 * Normalize raw fallback JSON into the same answer shape Jev returns.
 * Lenient on optional fields (confidence, probabilities), strict on the core
 * value of each question type. Throws when any question is unanswered.
 */
export function normalizeAnswers(
	parsed: Record<string, unknown>,
	questions: Questions
): Record<string, unknown> {
	const container = (parsed.answers ?? parsed) as unknown;
	if (typeof container !== "object" || container === null || Array.isArray(container)) {
		throw new Error(`Fallback output has no "answers" object: ${snippet(JSON.stringify(parsed))}`);
	}
	const raw = container as Record<string, unknown>;
	const answers: Record<string, unknown> = {};

	for (const [key, q] of Object.entries(questions)) {
		const a = raw[key];
		if (typeof a !== "object" || a === null) {
			throw new Error(`Fallback omitted answer for question "${key}"`);
		}
		const obj = a as Record<string, unknown>;
		const confidence = toNumber(obj.confidence);
		const withConf = Number.isFinite(confidence)
			? { confidence: clamp(confidence, 0, 1) }
			: {};

		if (q.type === "choice") {
			const criteria = (q.criteria ?? {}) as Record<string, string>;
			const choice = obj.choice;
			if (typeof choice !== "string" || !(choice in criteria)) {
				throw new Error(
					`Fallback answer for "${key}" has invalid choice ${JSON.stringify(choice)}`
				);
			}
			const answer: Record<string, unknown> = { type: "choice", choice, ...withConf };
			if (typeof obj.probabilities === "object" && obj.probabilities !== null) {
				const probs: Record<string, number> = {};
				for (const [opt, v] of Object.entries(obj.probabilities as Record<string, unknown>)) {
					const n = toNumber(v);
					if (Number.isFinite(n) && opt in criteria) probs[opt] = clamp(n, 0, 1);
				}
				if (Object.keys(probs).length > 0) answer.probabilities = probs;
			}
			answers[key] = answer;
		} else if (q.type === "score") {
			const levels = Array.isArray(q.criteria) ? q.criteria.length : 0;
			const score = toNumber(obj.score);
			if (!Number.isFinite(score)) {
				throw new Error(`Fallback answer for "${key}" has non-numeric score`);
			}
			const max = levels > 0 ? levels - 1 : Number.MAX_SAFE_INTEGER;
			answers[key] = { type: "score", score: clamp(score, 0, max), ...withConf };
		} else {
			// noul
			let noul = toNumber(obj.noul ?? obj.probability);
			if (!Number.isFinite(noul)) {
				throw new Error(`Fallback answer for "${key}" has non-numeric noul`);
			}
			if (noul > 1 && noul <= 100) noul = noul / 100; // tolerate percentages
			answers[key] = { type: "noul", noul: clamp(noul, 0, 1) };
		}
	}
	return answers;
}

/** How long to wait on Jev before deciding it cannot serve us right now. */
export const DEFAULT_TIMEOUT_MS = 30_000;

function timeoutSignalOf(ms: number): AbortSignal {
	const make = (AbortSignal as unknown as { timeout?: (n: number) => AbortSignal }).timeout;
	return typeof make === "function" ? make(ms) : new AbortController().signal;
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
	const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
	return typeof any === "function" ? any(a ? [a, b] : [b]) : (a ?? b);
}

/**
 * Validate the `answers` Jev returned against the questions that were asked,
 * so a malformed or incomplete answer fails loudly here instead of reaching the
 * consuming model. Extra fields Jev adds (legend, probabilities, confidence)
 * are preserved untouched.
 */
export function validateJevAnswers(
	raw: unknown,
	questions: Questions
): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(
			`Jev response has no "answers" object: ${snippet(JSON.stringify(raw ?? null))}`
		);
	}
	const answers = raw as Record<string, unknown>;

	for (const [key, q] of Object.entries(questions)) {
		const a = answers[key];
		if (typeof a !== "object" || a === null || Array.isArray(a)) {
			throw new Error(`Jev omitted answer for question "${key}"`);
		}
		const obj = a as Record<string, unknown>;
		if (obj.type !== q.type) {
			throw new Error(
				`Jev answer for "${key}" has type ${JSON.stringify(obj.type)}, expected ${q.type}`
			);
		}

		if (q.type === "choice") {
			const criteria = (q.criteria ?? {}) as Record<string, string>;
			if (typeof obj.choice !== "string" || !(obj.choice in criteria)) {
				throw new Error(
					`Jev answer for "${key}" has invalid choice ${JSON.stringify(obj.choice)}`
				);
			}
		} else if (q.type === "score") {
			if (!Number.isFinite(toNumber(obj.score))) {
				throw new Error(`Jev answer for "${key}" has non-numeric score`);
			}
		} else {
			const noul = toNumber(obj.noul);
			if (!Number.isFinite(noul) || noul < 0 || noul > 1) {
				throw new Error(
					`Jev answer for "${key}" has noul outside 0..1: ${JSON.stringify(obj.noul)}`
				);
			}
		}
	}
	return answers;
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

function isAbortError(e: unknown): boolean {
	return e instanceof Error && e.name === "AbortError";
}

/**
 * Run one decide request over pi's classifier transport. Preflight: a stated
 * preflight reason (no credentialed classifier) or an open circuit skips the
 * classifier entirely and the session model answers. A classifier failure opens
 * the circuit and falls back mid-call; aborts are surfaced without falling back.
 */
export async function runJevDecide(
	params: DecideParams,
	deps: DeciderDeps
): Promise<DecisionOutcome> {
	if (deps.preflightReason) {
		return fallbackOutcome(params, deps, deps.preflightReason);
	}
	if (!deps.classify) {
		// Transport resolution (index.ts) always provides one or the other; this
		// guards a wiring bug, not a runtime condition.
		throw new Error("runJevDecide: no classifier transport configured");
	}
	if (!deps.circuit.canAttempt()) {
		return fallbackOutcome(params, deps, "jev capacity circuit open (recent capacity failure)");
	}

	// #5: bound the wait so a hung classifier cannot stall the agent - a timeout
	// is "Jev cannot serve us", so it falls back like any other capacity failure.
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timeoutSignal = timeoutSignalOf(timeoutMs);
	const requestSignal = combineSignals(deps.signal, timeoutSignal);

	return runViaClassify(params, deps, requestSignal, timeoutSignal, timeoutMs);
}

/**
 * One decide request over pi's classifier transport. Signal dispatch: caller
 * abort propagates, our deadline fires a timeout fallback, and any provider-side
 * failure opens the circuit and hands the same questions to the session model.
 * questions to the session model.
 */
async function runViaClassify(
	params: DecideParams,
	deps: DeciderDeps,
	requestSignal: AbortSignal,
	timeoutSignal: AbortSignal,
	timeoutMs: number
): Promise<DecisionOutcome> {
	const classify = deps.classify!;
	let res: ClassifyOutcome;
	try {
		res = await classify(params, requestSignal);
	} catch (e) {
		// The caller cancelled (pi is shutting down / the user aborted): propagate.
		if (deps.signal?.aborted) throw e;
		// Our deadline fired: Jev was too slow - hand off to the session model.
		if (timeoutSignal.aborted) {
			deps.circuit.recordFailure();
			return fallbackOutcome(params, deps, `jev timed out after ${timeoutMs}ms`);
		}
		if (isAbortError(e)) throw e;
		deps.circuit.recordFailure();
		return fallbackOutcome(
			params,
			deps,
			`classify failed: ${e instanceof Error ? e.message : String(e)}`
		);
	}
	if (!res.ok) {
		// pi's classify() never rejects: auth, capacity, and upstream failures all
		// arrive here as a reason. Caller bugs cannot - malformed questions were
		// rejected before the call, malformed answers are rejected below.
		deps.circuit.recordFailure();
		return fallbackOutcome(params, deps, res.reason);
	}	// #6: an answer the consumer cannot act on is a failure, not a surprise.
	const answers = validateJevAnswers(
		fromClassifierAnswers(res.answers, params.questions),
		params.questions
	);
	deps.circuit.recordSuccess();
	return {
		source: "jev",
		model: res.model,
		answers,
		usage: res.usage ? toFullUsage(res.usage) : undefined,
	};
}

async function fallbackOutcome(
	params: DecideParams,
	deps: DeciderDeps,
	reason: string
): Promise<DecisionOutcome> {
	let result: FallbackResult;
	try {
		result = await deps.fallback(params);
	} catch (e) {
		throw new Error(
			`Jev unavailable (${reason}) and fallback failed: ${e instanceof Error ? e.message : String(e)}`
		);
	}
	const parsed = extractJsonObject(result.text);
	const answers = normalizeAnswers(parsed, params.questions);
	return {
		source: "fallback",
		model: result.model,
		answers,
		// normalize: pi's own stream usage normally has cost, but never trust it
		usage: result.usage ? toFullUsage(result.usage) : undefined,
		fallbackReason: reason,
	};
}
