/**
 * Jev decision tool - consult TypeSafe AI's Jev System One model.
 *
 * Jev is not a chat model: it evaluates one state against typed questions
 * (choice / score / noul) and returns structured answers to branch on.
 * Endpoint: POST https://jevmodel.org/v1/systemone
 * Auth: Bearer $JEVMODEL_API_KEY (create a key in the jevmodel.org dashboard)
 *
 * Capacity handling: a circuit breaker remembers capacity failures
 * (429/5xx/network). While open, calls skip Jev and fall back to the session
 * model (Mimo by default), which answers the same typed questions itself.
 * Fallback answers are marked with source: "fallback" and a reason.
 *
 * Env: JEVMODEL_URL (override endpoint, for tests),
 *      JEVMODEL_FALLBACK_MODEL ("provider/modelId" to pin the fallback model),
 *      JEVMODEL_TIMEOUT_MS (max ms to wait on Jev before handing off; default 30000).
 */

import { Type, validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	buildFallbackMessages,
	buildToolResult,
	CircuitBreaker,
	coerceQuestions,
	explainQuestionProblems,
	runJevDecide,
	type DecideParams,
	type FallbackResult,
	type Questions,
	type UsageLike,
} from "./lib.ts";

const JEV_URL = "https://jevmodel.org/v1/systemone";

/** Shared across calls in a session so the preflight sees prior failures. */
const circuit = new CircuitBreaker();

/**
 * Deliberately loose.
 *
 * Discriminating choice/score/noul inside the schema made errors unreadable:
 * a wrong `criteria` shape produced five union lines, four of them blaming
 * `type` with "must be equal to constant", and none saying how to fix it.
 * pi validates against this schema *before* execute() runs, so a strict union
 * meant the readable error could never be produced. The schema now checks only
 * what it must; explainQuestionProblems() validates the rest and names the
 * field plus the correction - which is what the consuming model reads on retry.
 */
const questionShape = Type.Object({
	type: Type.String({
		description:
			"Which answer you want: \"choice\" (pick one label), \"score\" (position on a 2-10 level scale), " +
			"or \"noul\" (yes/no probability in 0..1)",
	}),
	instructions: Type.String({ description: "What to decide or rate, up to 1800 chars" }),
	criteria: Type.Optional(
		Type.Any({
			description:
				"choice: object of 2-20 option keys -> descriptions. " +
				"score: array of 2-10 ordered level labels, e.g. [routine, urgent, critical]. " +
				"noul: optional map of label -> description (a map, never an array - an array is rejected by the API with 422)",
		})
	),
});

/**
 * Canonical wire shape of the `questions` argument.
 *
 * Kept as its own const because the parameter schema accepts a JSON-encoded
 * string as well (see below), and the string branch bypasses schema validation
 * of its *contents* - `execute()` re-checks against this record after coercion.
 */
const questionRecord = Type.Record(Type.String({ maxLength: 64 }), questionShape, {
	description: "1-8 questions keyed by short identifier names (letters, digits, _)",
});

/**
 * Single entry point for the `questions` argument: normalize the accepted
 * shapes (object, or JSON string with bounded repair) and then validate the
 * result against the canonical record - the union's string branch cannot
 * validate its own contents.
 */
export function normalizeQuestions(input: unknown): Questions {
	const questions = coerceQuestions(input);
	// Precise validation first: the schema is deliberately loose (see questionShape),
	// so this is where a wrong shape gets named - field by field, one cause per line.
	const problems = explainQuestionProblems(questions);
	if (problems.length > 0) {
		throw new Error(`Invalid questions:\n  - ${problems.join("\n  - ")}`);
	}
	// Backstop for whatever the schema still enforces (name length, string types).
	validateToolArguments(
		{
			name: "jev_decide",
			description: "Canonical record shape for the questions argument",
			parameters: Type.Object({ questions: questionRecord }),
		},
		{
			type: "toolCall",
			id: "normalize-questions",
			name: "jev_decide",
			arguments: { questions } as unknown as JsonObject,
		}
	);
	return questions;
}

export const jevTool = defineTool({
	name: "jev_decide",
	label: "Jev Decide",
	promptSnippet: "jev_decide - ask the Jev decision model for a typed choice/score/yes-no probability",
	promptGuidelines: [
		"Before running a destructive or hard-to-reverse command (rm, force-push, drop table, migration, git reset --hard), call jev_decide with a 'noul' question 'Is this action safe given the intended change?' and only proceed if noul < 0.3; if noul >= 0.3, show the user the probability and wait for confirmation.",
		"For failure analysis (failed test, CI build error, prod exception), call jev_decide with the failure output, recent changes, and pass/fail history as state: a 'noul' 'Is this flaky or a real bug?' (flaky >= 0.7 -> rerun once; otherwise investigate), and when the cause is unclear a 'choice' over root-cause hypotheses (env flake / real bug / brittle test / unknown) to pick the next step. Do not guess flakiness from a single error line alone - include reproduction results and history in state.",
		"When choosing between 2-4 concrete approaches and the tradeoff is genuinely close, call jev_decide with a 'choice' question listing the options and their tradeoffs; use its answer as a second opinion, but override it and explain when you have evidence it missed. An explicit user instruction always wins over Jev, and an answer you cannot read or that contradicts the facts means keep your current plan.",
		"When evaluating AI- or self-generated output (a patch, answer, or plan) against a rubric, call jev_decide with a 'score' question before presenting it as done; if score is in the bottom level, keep working instead of presenting it.",
		"When several judgments share the same context, batch them into ONE call: one `state` can carry up to 8 questions of mixed types (e.g. a risk noul + a severity score + a root-cause choice), answered together in one round trip - prefer one jev_decide call with three related questions over three sequential calls.",
		"Jev follows the option name, not just the rubric bound to it: use short descriptive choice keys (env_flake, not b) with discriminative, mutually exclusive descriptions - an ambiguous key cannot be rescued by its description, so never offer overlapping options.",
		"Do not call jev_decide for questions you can answer directly from the code or docs in context, for anything needing explanation or code generation, or when the user did not ask for a second opinion and no guideline above applies - Jev returns only choices, scores, and probabilities, never prose.",
		"jev_decide: pass `questions` as a nested JSON object mapping each short key to its question, e.g. {\"qa\": {\"type\": \"noul\", \"instructions\": \"...\"}}. Never JSON-encode it into a string - a string carries no structure guarantee, and that is where unbalanced braces and missing keys get through. Malformed values are rejected before any request is sent.",
		"Reading a jev_decide result: `answers[key].noul` = P(yes) in 0..1 with NO `confidence` field (the probability is the certainty); `answers[key].choice` = the selected label, with `probabilities` = full distribution and `confidence` 0..1; `answers[key].score` = position on the criteria scale you supplied and MAY be fractional (e.g. 1.4), so never assume an integer. `source: \"jev\"` = Jev answered, `source: \"fallback\"` = the session model answered (less calibrated). Branch on these typed values; Jev never returns prose.",
		"Gate every answer on confidence - accept when confident, escalate when unsure: act only on decisive results (choice/score `confidence` >= 0.5, or `noul` <= 0.3 / >= 0.7). An inconclusive result is no signal: treat it as undecided, decide from the evidence in context, and ask the user before irreversible actions rather than following a weak answer.",
	],
	description:
		"Ask the Jev decision model (TypeSafe System One) to evaluate a state against typed questions and return structured answers. " +
		"Use when you must make a routing/triage/quality decision, score options, estimate P(yes), apply guardrails, " +
		"analyze failures (flaky vs real bug), or want a fast second opinion before committing to an action. " +
		"Pass the decision context as 'state' (string, max 8000 chars) and 1-8 questions as a nested JSON object. Jev does not generate text - " +
		"it only returns choices, scores, and probabilities. If Jev capacity is unavailable the tool automatically " +
		"falls back to the session model; the result then has source: \"fallback\" with a fallbackReason - treat " +
		"those answers as less calibrated second opinions. Every result carries a `legend` explaining how to " +
		"read `.noul` (P(yes) 0..1, no confidence field), `.choice` (plus probabilities and confidence), and " +
		"`.score` (position on your criteria scale, may be fractional). Batch related questions into a single " +
		"call - they are answered together in one round trip.",
	parameters: Type.Object({
		state: Type.String({
			description:
				"The decision context: ticket, log excerpt, tool call, diff, options under consideration... raw text or JSON, max 8000 chars",
		}),
		questions: Type.Union(
			[
				questionRecord,
				Type.String({
					description: "JSON-encoded question map (parsed automatically)",
				}),
			],
			{
				description:
					"1-8 questions keyed by short identifier names (letters, digits, _). " +
					"Pass a JSON object, not a JSON-encoded string - a string is accepted and parsed, " +
					"but the object form is canonical.",
			}
		),
		model: Type.Optional(
			Type.String({ description: "Model alias, defaults to jev-latest" })
		),
	}),

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		// Standardize here: accept object-or-string from the schema, emit one shape.
		const questions = normalizeQuestions(params.questions);

		const decideParams: DecideParams = {
			state: params.state,
			questions,
			model: params.model,
		};

		const outcome = await runJevDecide(decideParams, {
			url: process.env.JEV_URL ?? process.env.JEVMODEL_URL ?? JEV_URL,
			apiKey: process.env.JEVMODEL_API_KEY,
			fetchImpl: fetch,
			signal: signal ?? undefined,
			circuit,
			timeoutMs: resolveTimeoutMs(),
			fallback: (p) => callFallbackModel(p, ctx, signal ?? undefined),
		});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(buildToolResult(outcome), null, 2),
				},
			],
			details: {
				source: outcome.source,
				answers: outcome.answers,
				fallbackReason: outcome.fallbackReason,
				billedInputTokens: outcome.usage?.input,
			},
			usage: outcome.usage,
		};
	},
});

/**
 * Resolve the fallback model: JEVMODEL_FALLBACK_MODEL ("provider/modelId")
 * wins, otherwise the session's current model (Mimo by default).
 */
function resolveFallbackModel(ctx: {
	model: { provider: string; id: string } | undefined;
	modelRegistry: {
		find(provider: string, modelId: string): { provider: string; id: string } | undefined;
	};
}): { provider: string; id: string } {
	const spec = process.env.JEVMODEL_FALLBACK_MODEL;
	if (spec) {
		const sep = spec.indexOf("/");
		const found =
			sep > 0 ? ctx.modelRegistry.find(spec.slice(0, sep), spec.slice(sep + 1)) : undefined;
		if (!found) {
			throw new Error(`JEVMODEL_FALLBACK_MODEL "${spec}" not found in model registry`);
		}
		return found;
	}
	if (ctx.model) return ctx.model;
	throw new Error("No fallback model: session model is unset and JEVMODEL_FALLBACK_MODEL not configured");
}

/** Ask the fallback model to answer the typed questions itself. */
async function callFallbackModel(
	params: DecideParams,
	ctx: {
		model: { provider: string; id: string } | undefined;
		modelRegistry: {
			find(provider: string, modelId: string): { provider: string; id: string } | undefined;
			streamSimple(
				model: never,
				context: unknown,
				options?: { signal?: AbortSignal; maxTokens?: number }
			): AsyncIterable<{
				type: string;
				delta?: string;
				message?: { content?: { type: string; text?: string }[]; usage?: UsageLike };
				error?: { errorMessage?: string };
			}>;
		};
	},
	signal: AbortSignal | undefined
): Promise<FallbackResult> {
	const model = resolveFallbackModel(ctx);
	const { systemPrompt, userText } = buildFallbackMessages(params.state, params.questions);

	const stream = ctx.modelRegistry.streamSimple(
		model as never,
		{
			systemPrompt,
			messages: [{ role: "user", content: userText, timestamp: Date.now() }],
		},
		{ signal, maxTokens: 2000 }
	);

	let text = "";
	let usage: UsageLike | undefined;
	for await (const event of stream) {
		if (event.type === "text_delta" && typeof event.delta === "string") {
			text += event.delta;
		} else if (event.type === "done" && event.message) {
			const blocks = event.message.content ?? [];
			const finalText = blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("");
			if (finalText.trim()) text = finalText;
			usage = event.message.usage;
		} else if (event.type === "error") {
			throw new Error(event.error?.errorMessage ?? "fallback model stream error");
		}
	}
	if (!text.trim()) throw new Error("fallback model returned no text");
	return { text, usage, model: `${model.provider}/${model.id}` };
}

/** JEVMODEL_TIMEOUT_MS overrides the default Jev deadline; invalid values fall back. */
function resolveTimeoutMs(): number | undefined {
	const raw = process.env.JEVMODEL_TIMEOUT_MS;
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(jevTool);
}
