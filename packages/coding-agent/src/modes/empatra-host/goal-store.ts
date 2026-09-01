import { createHash } from "node:crypto";

import type { SessionEntry } from "../../session/session-entries";
import type { SessionManager } from "../../session/session-manager";
import { EmpatraHostProtocolError } from "./errors";
import type {
	EmpatraHostGoalClearCommand,
	EmpatraHostGoalSetCommand,
	EmpatraHostGoalStatus,
	EmpatraHostThreadGoal,
} from "./protocol";

const GOAL_ENTRY_TYPE = "empatra.host.thread-goal.v1";
const GOAL_ENTRY_VERSION = 1 as const;

interface PersistedGoalState {
	accumulatedActiveMs: number;
	activeSinceMs: number | null;
	createdAt: number;
	objective: string;
	status: EmpatraHostGoalStatus;
	tokenBaseline: number;
	tokenBudget: number | null;
	updatedAt: number;
}

interface PersistedGoalMutation {
	action: "clear" | "set";
	cleared?: boolean;
	fingerprint: string;
	mutationId: string;
	state: PersistedGoalState | null;
	threadId: string;
	version: typeof GOAL_ENTRY_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGoalStatus(value: unknown): value is EmpatraHostGoalStatus {
	return (
		value === "active" ||
		value === "paused" ||
		value === "blocked" ||
		value === "usageLimited" ||
		value === "budgetLimited" ||
		value === "complete"
	);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const expected = new Set(keys);
	return Object.keys(value).length === expected.size && Object.keys(value).every(key => expected.has(key));
}

function isPersistableObjective(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 65_536 || value.trim().length === 0) return false;
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 32 && character !== "\n" && character !== "\r" && character !== "\t") return false;
	}
	return true;
}

function parseGoalState(value: unknown): PersistedGoalState | null | undefined {
	if (value === null) return null;
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"accumulatedActiveMs",
			"activeSinceMs",
			"createdAt",
			"objective",
			"status",
			"tokenBaseline",
			"tokenBudget",
			"updatedAt",
		]) ||
		!isPersistableObjective(value.objective) ||
		!isGoalStatus(value.status) ||
		(value.tokenBudget !== null &&
			(!Number.isSafeInteger(value.tokenBudget) ||
				(value.tokenBudget as number) < 1 ||
				(value.tokenBudget as number) > 1_000_000_000)) ||
		!isNonNegativeSafeInteger(value.createdAt) ||
		!isNonNegativeSafeInteger(value.updatedAt) ||
		value.updatedAt < value.createdAt ||
		!isNonNegativeSafeInteger(value.accumulatedActiveMs) ||
		(value.activeSinceMs !== null && !isNonNegativeSafeInteger(value.activeSinceMs)) ||
		(value.status === "active") !== (value.activeSinceMs !== null) ||
		(value.activeSinceMs !== null &&
			(value.activeSinceMs < value.createdAt || value.activeSinceMs > value.updatedAt)) ||
		!isNonNegativeSafeInteger(value.tokenBaseline)
	) {
		return undefined;
	}
	return {
		accumulatedActiveMs: value.accumulatedActiveMs,
		activeSinceMs: value.activeSinceMs,
		createdAt: value.createdAt,
		objective: value.objective,
		status: value.status,
		tokenBaseline: value.tokenBaseline,
		tokenBudget: value.tokenBudget as number | null,
		updatedAt: value.updatedAt,
	};
}

function parseMutation(entry: SessionEntry, threadId: string): PersistedGoalMutation | undefined {
	if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE) return undefined;
	const value = entry.data;
	if (!isRecord(value) || value.threadId !== threadId) return undefined;
	const state = parseGoalState(value.state);
	const expectedKeys =
		value.action === "clear"
			? ["action", "cleared", "fingerprint", "mutationId", "state", "threadId", "version"]
			: ["action", "fingerprint", "mutationId", "state", "threadId", "version"];
	if (
		value.version !== GOAL_ENTRY_VERSION ||
		(value.action !== "set" && value.action !== "clear") ||
		!hasExactKeys(value, expectedKeys) ||
		typeof value.fingerprint !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.fingerprint) ||
		typeof value.mutationId !== "string" ||
		value.mutationId.length < 1 ||
		value.mutationId.length > 256 ||
		state === undefined ||
		(value.action === "set" && state === null) ||
		(value.action === "clear" && (state !== null || typeof value.cleared !== "boolean"))
	) {
		throw new EmpatraHostProtocolError("goal_state_corrupt", "Persisted thread goal metadata is invalid");
	}
	if (value.action === "clear") {
		if (state !== null || typeof value.cleared !== "boolean") {
			throw new EmpatraHostProtocolError("goal_state_corrupt", "Persisted thread goal metadata is invalid");
		}
		return {
			action: "clear",
			cleared: value.cleared,
			fingerprint: value.fingerprint,
			mutationId: value.mutationId,
			state: null,
			threadId,
			version: GOAL_ENTRY_VERSION,
		};
	}
	if (state === null) {
		throw new EmpatraHostProtocolError("goal_state_corrupt", "Persisted thread goal metadata is invalid");
	}
	return {
		action: "set",
		fingerprint: value.fingerprint,
		mutationId: value.mutationId,
		state,
		threadId,
		version: GOAL_ENTRY_VERSION,
	};
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function setFingerprint(command: EmpatraHostGoalSetCommand): string {
	return fingerprint({
		action: "set",
		...(command.objective === undefined ? {} : { objective: command.objective }),
		...(command.status === undefined ? {} : { status: command.status }),
		...(command.tokenBudget === undefined ? {} : { tokenBudget: command.tokenBudget }),
	});
}

function clearFingerprint(): string {
	return fingerprint({ action: "clear" });
}

function goalMutations(manager: SessionManager): PersistedGoalMutation[] {
	const threadId = manager.getSessionId();
	return manager.getBranch().flatMap(entry => {
		const mutation = parseMutation(entry, threadId);
		return mutation ? [mutation] : [];
	});
}

function currentState(manager: SessionManager): PersistedGoalState | null {
	return goalMutations(manager).at(-1)?.state ?? null;
}

function cumulativeAssistantTokens(entries: readonly SessionEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const tokens = entry.message.usage?.totalTokens;
		if (!Number.isFinite(tokens) || tokens < 0) continue;
		total = Math.min(Number.MAX_SAFE_INTEGER, total + Math.floor(tokens));
	}
	return total;
}

function projectGoal(manager: SessionManager, state: PersistedGoalState, now: number): EmpatraHostThreadGoal {
	const activeMs = state.activeSinceMs === null ? 0 : Math.max(0, now - state.activeSinceMs);
	const tokens = cumulativeAssistantTokens(manager.getBranch());
	return {
		createdAt: state.createdAt,
		objective: state.objective,
		status: state.status,
		threadId: manager.getSessionId(),
		timeUsedSeconds: Math.floor((state.accumulatedActiveMs + activeMs) / 1000),
		tokenBudget: state.tokenBudget,
		tokensUsed: Math.max(0, tokens - state.tokenBaseline),
		updatedAt: state.updatedAt,
	};
}

function replayMutation(
	mutations: readonly PersistedGoalMutation[],
	mutationId: string,
	action: PersistedGoalMutation["action"],
	expectedFingerprint: string,
): PersistedGoalMutation | undefined {
	const mutation = mutations.find(candidate => candidate.mutationId === mutationId);
	if (!mutation) return undefined;
	if (mutation.action !== action || mutation.fingerprint !== expectedFingerprint) {
		throw new EmpatraHostProtocolError("operation_conflict", "Goal mutation id is bound to different inputs");
	}
	return mutation;
}

function appendMutation(manager: SessionManager, mutation: PersistedGoalMutation): void {
	manager.appendCustomEntry(GOAL_ENTRY_TYPE, mutation);
}

export function getPersistedThreadGoal(manager: SessionManager, now = Date.now()): EmpatraHostThreadGoal | null {
	const state = currentState(manager);
	return state ? projectGoal(manager, state, now) : null;
}

export function setPersistedThreadGoal(
	manager: SessionManager,
	command: EmpatraHostGoalSetCommand,
	now = Date.now(),
): EmpatraHostThreadGoal {
	const commandFingerprint = setFingerprint(command);
	const mutations = goalMutations(manager);
	const repeated = replayMutation(mutations, command.id, "set", commandFingerprint);
	if (repeated) {
		if (!repeated.state) {
			throw new EmpatraHostProtocolError("goal_state_corrupt", "Goal set mutation has no persisted state");
		}
		return projectGoal(manager, repeated.state, now);
	}

	const previous = mutations.at(-1)?.state ?? null;
	const objective = command.objective ?? previous?.objective;
	if (!objective) throw new EmpatraHostProtocolError("goal_missing", "A new thread goal requires an objective");
	const status = command.status ?? previous?.status ?? "active";
	const elapsed =
		previous?.activeSinceMs === null || previous?.activeSinceMs === undefined
			? 0
			: Math.max(0, now - previous.activeSinceMs);
	const state: PersistedGoalState = {
		accumulatedActiveMs: (previous?.accumulatedActiveMs ?? 0) + elapsed,
		activeSinceMs: status === "active" ? now : null,
		createdAt: previous?.createdAt ?? now,
		objective,
		status,
		tokenBaseline: previous?.tokenBaseline ?? cumulativeAssistantTokens(manager.getBranch()),
		tokenBudget: command.tokenBudget === undefined ? (previous?.tokenBudget ?? null) : command.tokenBudget,
		updatedAt: now,
	};
	appendMutation(manager, {
		action: "set",
		fingerprint: commandFingerprint,
		mutationId: command.id,
		state,
		threadId: manager.getSessionId(),
		version: GOAL_ENTRY_VERSION,
	});
	return projectGoal(manager, state, now);
}

export function clearPersistedThreadGoal(
	manager: SessionManager,
	command: EmpatraHostGoalClearCommand,
): Readonly<{ cleared: boolean }> {
	const commandFingerprint = clearFingerprint();
	const mutations = goalMutations(manager);
	const repeated = replayMutation(mutations, command.id, "clear", commandFingerprint);
	if (repeated) return { cleared: repeated.cleared ?? false };
	const cleared = (mutations.at(-1)?.state ?? null) !== null;
	appendMutation(manager, {
		action: "clear",
		cleared,
		fingerprint: commandFingerprint,
		mutationId: command.id,
		state: null,
		threadId: manager.getSessionId(),
		version: GOAL_ENTRY_VERSION,
	});
	return { cleared };
}
