/**
 * Pure logic for the jev_decide tool: capacity classification, circuit-breaker
 * preflight, fallback prompt building, answer normalization, and the main
 * decide flow. No pi imports - everything external is injected so this module
 * is unit-testable standalone.
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
	model?: string;
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
	"its own `legend` maps level index -> your label and its `probabilities` gives the spread over " +
	"those levels, so 1.57 sits between 'medium' and 'high'. Do not assume an integer. (The " +
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

export interface HttpLike {
	(
		url: string,
		init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
	): PromiseLike<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export interface DeciderDeps {
	url: string;
	apiKey?: string;
	fetchImpl: HttpLike;
	signal?: AbortSignal;
	circuit: CircuitBreaker;
	fallback: (params: DecideParams) => Promise<FallbackResult>;
	modelAlias?: string;
	/** Max ms to wait on Jev before handing off. Defaults to DEFAULT_TIMEOUT_MS. */
	timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Capacity classification
// ---------------------------------------------------------------------------

/** Statuses that mean "Jev cannot serve right now" rather than "caller bug". */
// 402 insufficient_credits is capacity, not a caller bug: the budget is gone, so
// every later request is rejected too and retrying cannot help. Hand off to the
// session model instead (docs: 402, not charged).
const CAPACITY_STATUSES = new Set([402, 408, 425, 429, 500, 502, 503, 504, 529]);
/** Statuses that are the caller's fault - never fall back, surface them. */
const HARD_ERROR_STATUSES = new Set([400, 401, 403, 404, 410, 422]);
const CAPACITY_BODY_RE =
	/rate[ _-]?limit|quota|capacity|overload|too many requests|temporarily unavailable|service unavailable|insufficient/i;

/**
 * True when a non-2xx Jev response indicates insufficient capacity /
 * unavailability, i.e. the fallback path should take over.
 */
export function isCapacityFailure(status: number, body: string): boolean {
	if (CAPACITY_STATUSES.has(status)) return true;
	if (HARD_ERROR_STATUSES.has(status)) return false;
	return CAPACITY_BODY_RE.test(body);
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
 * Run one decide request. Preflight: while the circuit is open (recent capacity
 * failure) or no API key is configured, skip Jev and use the fallback directly.
 * A capacity-classified Jev failure opens the circuit and falls back mid-call.
 * Non-capacity Jev errors and aborts are surfaced without falling back.
 */
export async function runJevDecide(
	params: DecideParams,
	deps: DeciderDeps
): Promise<DecisionOutcome> {
	// Preflight: is Jev worth attempting right now?
	if (!deps.apiKey) {
		return fallbackOutcome(params, deps, "JEVMODEL_API_KEY not set");
	}
	if (!deps.circuit.canAttempt()) {
		return fallbackOutcome(params, deps, "jev capacity circuit open (recent capacity failure)");
	}

	let res: { ok: boolean; status: number; text(): Promise<string> };
	// #5: bound the wait so a hung gateway cannot stall the agent - a timeout is
	// "Jev cannot serve us", so it falls back like any other capacity failure.
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timeoutSignal = timeoutSignalOf(timeoutMs);
	const requestSignal = combineSignals(deps.signal, timeoutSignal);
	try {
		res = await deps.fetchImpl(deps.url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${deps.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: params.model ?? deps.modelAlias ?? "jev-latest",
				state: params.state,
				questions: params.questions,
			}),
			signal: requestSignal,
		});
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
		return fallbackOutcome(params, deps, `jev unreachable: ${e instanceof Error ? e.message : String(e)}`);
	}

	if (!res.ok) {
		const body = await res.text();
		if (isCapacityFailure(res.status, body)) {
			deps.circuit.recordFailure();
			return fallbackOutcome(
				params,
				deps,
				`jev HTTP ${res.status}: ${snippet(body)}`
			);
		}
		throw new Error(`Jev API ${res.status}: ${body.slice(0, 500)}`);
	}

	// #4: read the body as text and parse explicitly - a 200 carrying an HTML
	// error page must surface as a readable Jev error, not a JSON.parse crash.
	const raw = await res.text();
	let data: {
		model?: string;
		answers?: unknown;
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	try {
		data = JSON.parse(raw) as typeof data;
	} catch (e) {
		throw new Error(
			`Jev API ${res.status} returned a non-JSON body: ${snippet(raw)} (${
				e instanceof Error ? e.message : String(e)
			})`
		);
	}
	// #6: an answer the consumer cannot act on is a failure, not a surprise.
	const answers = validateJevAnswers(data.answers, params.questions);
	deps.circuit.recordSuccess();
	return {
		source: "jev",
		model: data.model ?? (params.model ?? deps.modelAlias ?? "jev-latest"),
		answers,
		usage: toFullUsage({
			input: data.usage?.input_tokens ?? 0,
			output: data.usage?.output_tokens ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
		}),
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
