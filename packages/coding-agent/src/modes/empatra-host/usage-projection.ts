import type { AssistantMessage } from "@oh-my-pi/pi-ai";

import type { SessionEntry } from "../../session/session-entries";
import { EmpatraHostProtocolError } from "./errors";
import type { EmpatraHostContextUsage, EmpatraHostTokenUsage } from "./protocol";

const EMPATRA_TURN_ENTRY = "empatra.host.turn.v1";
const EMPATRA_TURN_ENTRY_VERSION = 1;

const ZERO_USAGE: EmpatraHostTokenUsage = Object.freeze({
	cachedInputTokens: 0,
	inputTokens: 0,
	outputTokens: 0,
	reasoningOutputTokens: 0,
	totalTokens: 0,
});

export interface EmpatraHostUsageObservation {
	observedAtMs: number;
	tokenUsage: EmpatraHostTokenUsage;
	turnId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new EmpatraHostProtocolError("turn_state_corrupt", `Assistant usage ${field} is invalid`);
	}
	return value as number;
}

function optionalNonNegativeSafeInteger(value: unknown, field: string): number {
	return value === undefined ? 0 : requireNonNegativeSafeInteger(value, field);
}

function checkedAdd(left: number, right: number, field: string): number {
	const value = left + right;
	if (!Number.isSafeInteger(value)) {
		throw new EmpatraHostProtocolError("turn_state_corrupt", `Assistant usage ${field} overflowed`);
	}
	return value;
}

function addUsage(left: EmpatraHostTokenUsage, right: EmpatraHostTokenUsage): EmpatraHostTokenUsage {
	return {
		cachedInputTokens: checkedAdd(left.cachedInputTokens, right.cachedInputTokens, "cachedInputTokens"),
		inputTokens: checkedAdd(left.inputTokens, right.inputTokens, "inputTokens"),
		outputTokens: checkedAdd(left.outputTokens, right.outputTokens, "outputTokens"),
		reasoningOutputTokens: checkedAdd(
			left.reasoningOutputTokens,
			right.reasoningOutputTokens,
			"reasoningOutputTokens",
		),
		totalTokens: checkedAdd(left.totalTokens, right.totalTokens, "totalTokens"),
	};
}

function assistantObservedAtMs(message: AssistantMessage): number {
	return requireNonNegativeSafeInteger(message.completedAt ?? message.timestamp, "observedAtMs");
}

export function hasTrustworthyEmpatraHostAssistantUsage(message: AssistantMessage): boolean {
	return message.stopReason !== "aborted" && message.stopReason !== "error";
}

function startedTurnId(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom" || entry.customType !== EMPATRA_TURN_ENTRY || !isRecord(entry.data)) {
		return undefined;
	}
	if (
		entry.data.version === EMPATRA_TURN_ENTRY_VERSION &&
		entry.data.phase === "started" &&
		typeof entry.data.turnId === "string" &&
		entry.data.turnId.length > 0
	) {
		return entry.data.turnId;
	}
	return undefined;
}

export function normalizeEmpatraHostTokenUsage(value: unknown): EmpatraHostTokenUsage {
	if (!isRecord(value)) {
		throw new EmpatraHostProtocolError("turn_state_corrupt", "Assistant usage is invalid");
	}
	const rawInput = requireNonNegativeSafeInteger(value.input, "input");
	const cacheRead = requireNonNegativeSafeInteger(value.cacheRead, "cacheRead");
	const cacheWrite = requireNonNegativeSafeInteger(value.cacheWrite, "cacheWrite");
	const output = requireNonNegativeSafeInteger(value.output, "output");
	const reasoning =
		value.reasoningTokens === undefined ? 0 : requireNonNegativeSafeInteger(value.reasoningTokens, "reasoningTokens");
	const total = requireNonNegativeSafeInteger(value.totalTokens, "totalTokens");
	const billableInputWithRead = checkedAdd(rawInput, cacheRead, "inputTokens");
	const billableInput = checkedAdd(billableInputWithRead, cacheWrite, "inputTokens");
	const billableConversationTotal = checkedAdd(billableInput, output, "totalTokens");
	let orchestrationTotal = 0;
	if (value.orchestration !== undefined) {
		if (!isRecord(value.orchestration)) {
			throw new EmpatraHostProtocolError("turn_state_corrupt", "Assistant usage orchestration is invalid");
		}
		orchestrationTotal = checkedAdd(
			optionalNonNegativeSafeInteger(value.orchestration.input, "orchestration.input"),
			optionalNonNegativeSafeInteger(value.orchestration.cacheRead, "orchestration.cacheRead"),
			"orchestrationTokens",
		);
		orchestrationTotal = checkedAdd(
			orchestrationTotal,
			optionalNonNegativeSafeInteger(value.orchestration.output, "orchestration.output"),
			"orchestrationTokens",
		);
	}
	const billableTotal = checkedAdd(billableConversationTotal, orchestrationTotal, "totalTokens");
	const contextTotal =
		value.contextTokens === undefined
			? billableConversationTotal
			: requireNonNegativeSafeInteger(value.contextTokens, "contextTokens");
	const input = contextTotal - output;
	if (
		reasoning > output ||
		total !== billableTotal ||
		!Number.isSafeInteger(input) ||
		input < 0 ||
		cacheRead > input
	) {
		throw new EmpatraHostProtocolError("turn_state_corrupt", "Assistant usage totals are inconsistent");
	}
	return {
		cachedInputTokens: cacheRead,
		inputTokens: input,
		outputTokens: output,
		reasoningOutputTokens: reasoning,
		totalTokens: contextTotal,
	};
}

export function observeEmpatraHostAssistantUsage(
	message: AssistantMessage,
	turnId: string,
): EmpatraHostUsageObservation {
	return {
		observedAtMs: assistantObservedAtMs(message),
		tokenUsage: normalizeEmpatraHostTokenUsage(message.usage),
		turnId,
	};
}

export function projectEmpatraHostContextUsage(
	entries: readonly SessionEntry[],
	modelContextWindow: number,
	appended: readonly EmpatraHostUsageObservation[] = [],
): EmpatraHostContextUsage {
	const contextWindow = requireNonNegativeSafeInteger(modelContextWindow, "modelContextWindow");
	if (contextWindow === 0) {
		throw new EmpatraHostProtocolError("turn_state_corrupt", "Model context window is invalid");
	}
	let currentTurnId: string | null = null;
	let last: EmpatraHostTokenUsage = ZERO_USAGE;
	let total: EmpatraHostTokenUsage = ZERO_USAGE;
	let observedAtMs: number | null = null;
	let usageTurnId: string | null = null;
	for (const entry of entries) {
		currentTurnId = startedTurnId(entry) ?? currentTurnId;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (!hasTrustworthyEmpatraHostAssistantUsage(entry.message)) continue;
		last = normalizeEmpatraHostTokenUsage(entry.message.usage);
		total = addUsage(total, last);
		observedAtMs = assistantObservedAtMs(entry.message);
		usageTurnId = currentTurnId;
	}
	for (const observation of appended) {
		last = observation.tokenUsage;
		total = addUsage(total, last);
		observedAtMs = observation.observedAtMs;
		usageTurnId = observation.turnId;
	}
	return {
		modelContextWindow: contextWindow,
		observedAtMs,
		tokenUsage: { last, total },
		turnId: usageTurnId,
	};
}
