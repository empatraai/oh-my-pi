import { randomUUID } from "node:crypto";

import { EmpatraHostProtocolError } from "./errors";

/**
 * Reserved for a main-owned subagent controller.
 *
 * OMP already has an internal task/subagent runtime, but the Empatra host
 * deliberately does not expose that runtime as an ambient RPC surface. This
 * capability is therefore kept out of `EMPATRA_HOST_CAPABILITIES` until a
 * controller wires an executor, persistence, and approval policy end to end.
 */
export const EMPATRA_HOST_SUBAGENT_CAPABILITY = "subagents.lifecycle.v1" as const;
/** Launch-time opt-in accepted only from the sanitized Electron environment. */
export const EMPATRA_HOST_SUBAGENT_RPC_OPT_IN_ENV = "EMPATRA_OMP_SUBAGENT_RPC" as const;
export const EMPATRA_HOST_SUBAGENT_RPC_OPT_IN_VALUE = "v1" as const;

export const EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN = 16;
export const EMPATRA_HOST_MAX_SUBAGENT_ASSIGNMENT_BYTES = 64 * 1024;
export const EMPATRA_HOST_MAX_SUBAGENT_MESSAGE_BYTES = 64 * 1024;
export const EMPATRA_HOST_MAX_SUBAGENT_RESULT_BYTES = 512 * 1024;
export const EMPATRA_HOST_MAX_SUBAGENT_PROGRESS_BYTES = 16 * 1024;
export const EMPATRA_HOST_MAX_SUBAGENT_AGENT_NAME_BYTES = 128;
export const EMPATRA_HOST_MAX_SUBAGENT_DESCRIPTION_BYTES = 4 * 1024;
export const EMPATRA_HOST_MAX_SUBAGENT_SNAPSHOTS = 256;

export type EmpatraHostSubagentLifecycleStatus = "aborted" | "completed" | "failed" | "running";

export interface EmpatraHostSubagentScope {
	generation: number;
	parentThreadId: string;
	parentTurnId: string;
}

interface EmpatraHostSubagentCommandBase extends EmpatraHostSubagentScope {
	id: string;
}

/**
 * Main-to-host request. The child inherits the parent's workspace and host
 * tools; paths, environment, executable names, and extension loading are not
 * part of this contract. `agentName`/`modelId` are selectors only and must be
 * resolved against the main-injected catalog by the eventual executor.
 */
export interface EmpatraHostSubagentSpawnCommand extends EmpatraHostSubagentCommandBase {
	agentName?: string;
	assignment: string;
	modelId?: string;
	type: "subagent_spawn";
}

export interface EmpatraHostSubagentSteerCommand extends EmpatraHostSubagentCommandBase {
	childId: string;
	message: string;
	type: "subagent_steer";
}

export interface EmpatraHostSubagentInterruptCommand extends EmpatraHostSubagentCommandBase {
	childId: string;
	type: "subagent_interrupt";
}

export interface EmpatraHostSubagentCloseCommand extends EmpatraHostSubagentCommandBase {
	childId: string;
	type: "subagent_close";
}

export interface EmpatraHostSubagentListCommand extends EmpatraHostSubagentCommandBase {
	type: "subagent_list";
}

export type EmpatraHostSubagentCommand =
	| EmpatraHostSubagentCloseCommand
	| EmpatraHostSubagentInterruptCommand
	| EmpatraHostSubagentListCommand
	| EmpatraHostSubagentSpawnCommand
	| EmpatraHostSubagentSteerCommand;

export interface EmpatraHostSubagentSnapshot extends EmpatraHostSubagentScope {
	agentName: string;
	childId: string;
	description?: string;
	index: number;
	status: EmpatraHostSubagentLifecycleStatus;
	updatedAtMs: number;
}

export interface EmpatraHostSubagentSpawnResult {
	childId: string;
	index: number;
	status: "running";
}

export interface EmpatraHostSubagentListResult {
	subagents: readonly EmpatraHostSubagentSnapshot[];
}

export type EmpatraHostSubagentCommandResult = EmpatraHostSubagentSpawnResult | EmpatraHostSubagentListResult;

export interface EmpatraHostSubagentResponse {
	data?: EmpatraHostSubagentCommandResult;
	error?: Readonly<{ code: string; message: string }>;
	id: string;
	success: boolean;
	type: "subagent_response";
}

/**
 * Explicit bootstrap request from the Electron main process. The sidecar
 * never enables subagent RPC merely because the implementation is present;
 * both the launch-time opt-in and this typed initialize field are required.
 */
export interface EmpatraHostSubagentRpcBootstrap {
	capability: typeof EMPATRA_HOST_SUBAGENT_CAPABILITY;
}

/** Sidecar-to-main request; authority-bearing process fields are excluded. */
export interface EmpatraHostSubagentRequestBase {
	event: "subagent_request";
	generation: number;
	requestId: string;
	sequence: number;
	threadId: string;
	turnId: string;
	type: "host_event";
}
export interface EmpatraHostSubagentSpawnRequestEvent extends EmpatraHostSubagentRequestBase {
	agentName?: string;
	assignment: string;
	modelId?: string;
	operation: "spawn";
}
export interface EmpatraHostSubagentSteerRequestEvent extends EmpatraHostSubagentRequestBase {
	childId: string;
	message: string;
	operation: "steer";
}
export interface EmpatraHostSubagentChildRequestEvent extends EmpatraHostSubagentRequestBase {
	childId: string;
	operation: "interrupt" | "close";
}
export interface EmpatraHostSubagentListRequestEvent extends EmpatraHostSubagentRequestBase {
	operation: "list";
}
export type EmpatraHostSubagentRequestEvent =
	| EmpatraHostSubagentChildRequestEvent
	| EmpatraHostSubagentListRequestEvent
	| EmpatraHostSubagentSpawnRequestEvent
	| EmpatraHostSubagentSteerRequestEvent;
export type EmpatraHostSubagentResponseCommand = EmpatraHostSubagentResponse;

export interface EmpatraHostSubagentLifecycleEvent {
	agentName: string;
	childId: string;
	event: "subagent_lifecycle";
	generation: number;
	index: number;
	sequence: number;
	status: EmpatraHostSubagentLifecycleStatus;
	threadId: string;
	turnId: string;
	type: "host_event";
}

export interface EmpatraHostSubagentProgressEvent {
	childId: string;
	event: "subagent_progress";
	generation: number;
	progress: string;
	sequence: number;
	status: "running";
	threadId: string;
	turnId: string;
	type: "host_event";
}

export interface EmpatraHostSubagentResultEvent {
	childId: string;
	event: "subagent_result";
	generation: number;
	output: string;
	outputTruncated: boolean;
	sequence: number;
	status: Exclude<EmpatraHostSubagentLifecycleStatus, "running">;
	threadId: string;
	turnId: string;
	type: "host_event";
}

export type EmpatraHostSubagentEvent =
	| EmpatraHostSubagentLifecycleEvent
	| EmpatraHostSubagentProgressEvent
	| EmpatraHostSubagentResultEvent;

const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every(key => allowed.has(key));
}

function boundedString(value: unknown, field: string, maxBytes: number, allowEmpty = false): string {
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.length === 0) ||
		textEncoder.encode(value).byteLength > maxBytes
	) {
		throw new EmpatraHostProtocolError("subagent_request_invalid", `${field} is invalid`);
	}
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 32 && character !== "\n" && character !== "\r" && character !== "\t") {
			throw new EmpatraHostProtocolError("subagent_request_invalid", `${field} is invalid`);
		}
	}
	return value;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
		throw new EmpatraHostProtocolError("subagent_request_invalid", `${field} is invalid`);
	}
	return value as number;
}

function scope(value: Record<string, unknown>): EmpatraHostSubagentScope {
	return {
		generation: boundedInteger(value.generation, "generation", 1, Number.MAX_SAFE_INTEGER),
		parentThreadId: boundedString(value.parentThreadId, "parentThreadId", 256),
		parentTurnId: boundedString(value.parentTurnId, "parentTurnId", 256),
	};
}

function eventScope(value: Record<string, unknown>): Pick<EmpatraHostSubagentLifecycleEvent, "generation" | "threadId" | "turnId"> {
	return {
		generation: boundedInteger(value.generation, "generation", 1, Number.MAX_SAFE_INTEGER),
		threadId: boundedString(value.threadId, "threadId", 256),
		turnId: boundedString(value.turnId, "turnId", 256),
	};
}

function requestBase(value: Record<string, unknown>): EmpatraHostSubagentRequestBase {
	if (value.event !== "subagent_request" || value.type !== "host_event") {
		throw new EmpatraHostProtocolError("subagent_request_invalid", "subagent request is invalid");
	}
	return {
		...eventScope(value),
		event: "subagent_request",
		requestId: identifier(value.requestId, "requestId"),
		sequence: boundedInteger(value.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER),
		type: "host_event",
	};
}

function identifier(value: unknown, field: string): string {
	return boundedString(value, field, 256);
}

function agentName(value: unknown): string {
	const name = boundedString(value, "agentName", EMPATRA_HOST_MAX_SUBAGENT_AGENT_NAME_BYTES);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
		throw new EmpatraHostProtocolError("subagent_request_invalid", "agentName is invalid");
	}
	return name;
}

function optionalAgentName(value: unknown): string | undefined {
	return value === undefined ? undefined : agentName(value);
}

function optionalModelId(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	const modelId = boundedString(value, "modelId", 256);
	if (/\s/u.test(modelId)) throw new EmpatraHostProtocolError("subagent_request_invalid", "modelId is invalid");
	return modelId;
}

function parseCommandBase(value: Record<string, unknown>, keys: readonly string[]): EmpatraHostSubagentScope & { id: string } {
	if (!hasOnlyKeys(value, keys)) {
		throw new EmpatraHostProtocolError("subagent_request_invalid", "subagent command contains unknown fields");
	}
	return { ...scope(value), id: identifier(value.id, "id") };
}

/** Parse the closed main-owned subagent command family. */
export function parseEmpatraHostSubagentCommand(value: unknown): EmpatraHostSubagentCommand {
	if (!isRecord(value) || typeof value.type !== "string") {
		throw new EmpatraHostProtocolError("subagent_request_invalid", "subagent command is invalid");
	}
	switch (value.type) {
		case "subagent_spawn": {
			const base = parseCommandBase(value, [
				"agentName",
				"assignment",
				"generation",
				"id",
				"modelId",
				"parentThreadId",
				"parentTurnId",
				"type",
			]);
			return {
				...base,
				...(optionalAgentName(value.agentName) === undefined ? {} : { agentName: optionalAgentName(value.agentName) }),
				assignment: boundedString(value.assignment, "assignment", EMPATRA_HOST_MAX_SUBAGENT_ASSIGNMENT_BYTES),
				...(optionalModelId(value.modelId) === undefined ? {} : { modelId: optionalModelId(value.modelId) }),
				type: "subagent_spawn",
			};
		}
		case "subagent_steer": {
			const base = parseCommandBase(value, [
				"childId",
				"generation",
				"id",
				"message",
				"parentThreadId",
				"parentTurnId",
				"type",
			]);
			return {
				...base,
				childId: identifier(value.childId, "childId"),
				message: boundedString(value.message, "message", EMPATRA_HOST_MAX_SUBAGENT_MESSAGE_BYTES),
				type: "subagent_steer",
			};
		}
		case "subagent_interrupt":
		case "subagent_close": {
			const base = parseCommandBase(value, [
				"childId",
				"generation",
				"id",
				"parentThreadId",
				"parentTurnId",
				"type",
			]);
			return { ...base, childId: identifier(value.childId, "childId"), type: value.type };
		}
		case "subagent_list": {
			const base = parseCommandBase(value, ["generation", "id", "parentThreadId", "parentTurnId", "type"]);
			return { ...base, type: "subagent_list" };
		}
		default:
			throw new EmpatraHostProtocolError("subagent_unknown_command", `Unknown subagent command: ${value.type}`);
	}
}

function parseSnapshot(value: unknown): EmpatraHostSubagentSnapshot {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"agentName",
			"childId",
			"description",
			"generation",
			"index",
			"parentThreadId",
			"parentTurnId",
			"status",
			"updatedAtMs",
		]) ||
		(value.description !== undefined && typeof value.description !== "string") ||
		(value.status !== "running" && value.status !== "completed" && value.status !== "failed" && value.status !== "aborted")
	) {
		throw new EmpatraHostProtocolError("subagent_response_invalid", "subagent snapshot is invalid");
	}
	return {
		agentName: agentName(value.agentName),
		childId: identifier(value.childId, "childId"),
		...(value.description === undefined
			? {}
			: { description: boundedString(value.description, "description", EMPATRA_HOST_MAX_SUBAGENT_DESCRIPTION_BYTES, true) }),
		...scope(value),
		index: boundedInteger(value.index, "index", 0, EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN - 1),
		status: value.status,
		updatedAtMs: boundedInteger(value.updatedAtMs, "updatedAtMs", 0, Number.MAX_SAFE_INTEGER),
	};
}

function parseResultData(value: unknown): EmpatraHostSubagentCommandResult | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new EmpatraHostProtocolError("subagent_response_invalid", "subagent response data is invalid");
	if ("childId" in value) {
		if (!hasOnlyKeys(value, ["childId", "index", "status"]) || value.status !== "running") {
			throw new EmpatraHostProtocolError("subagent_response_invalid", "subagent spawn result is invalid");
		}
		return {
			childId: identifier(value.childId, "childId"),
			index: boundedInteger(value.index, "index", 0, EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN - 1),
			status: "running",
		};
	}
	if (
		!hasOnlyKeys(value, ["subagents"]) ||
		!Array.isArray(value.subagents) ||
		value.subagents.length > EMPATRA_HOST_MAX_SUBAGENT_SNAPSHOTS
	) {
		throw new EmpatraHostProtocolError("subagent_response_invalid", "subagent list result is invalid");
	}
	return { subagents: value.subagents.map(parseSnapshot) };
}

/** Parse a response and keep failures safe for the controller boundary. */
export function parseEmpatraHostSubagentResponse(value: unknown): EmpatraHostSubagentResponse {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["data", "error", "id", "success", "type"]) ||
		value.type !== "subagent_response" ||
		typeof value.success !== "boolean" ||
		(value.success ? value.error !== undefined : value.error === undefined)
	) {
		throw new EmpatraHostProtocolError("subagent_response_invalid", "subagent response is invalid");
	}
	if (value.success) {
		return {
			...(parseResultData(value.data) === undefined ? {} : { data: parseResultData(value.data) }),
			id: identifier(value.id, "id"),
			success: true,
			type: "subagent_response",
		};
	}
	if (!isRecord(value.error) || !hasOnlyKeys(value.error, ["code", "message"])) {
		throw new EmpatraHostProtocolError("subagent_response_invalid", "subagent error is invalid");
	}
	return {
		error: {
			code: identifier(value.error.code, "error.code"),
			message: boundedString(value.error.message, "error.message", 4096),
		},
		id: identifier(value.id, "id"),
		success: false,
		type: "subagent_response",
	};
}

/** Parse the closed sidecar-to-main request family. */
export function parseEmpatraHostSubagentRequestEvent(value: unknown): EmpatraHostSubagentRequestEvent {
	if (!isRecord(value) || value.type !== "host_event" || value.event !== "subagent_request") {
		throw new EmpatraHostProtocolError("subagent_request_invalid", "subagent request is invalid");
	}
	const base = requestBase(value);
	switch (value.operation) {
		case "spawn":
			if (!hasOnlyKeys(value, ["agentName", "assignment", "event", "generation", "modelId", "operation", "requestId", "sequence", "threadId", "turnId", "type"])) {
				throw new EmpatraHostProtocolError("subagent_request_invalid", "subagent spawn request contains unknown fields");
			}
			return {
				...base,
				...(optionalAgentName(value.agentName) === undefined ? {} : { agentName: optionalAgentName(value.agentName) }),
				assignment: boundedString(value.assignment, "assignment", EMPATRA_HOST_MAX_SUBAGENT_ASSIGNMENT_BYTES),
				...(optionalModelId(value.modelId) === undefined ? {} : { modelId: optionalModelId(value.modelId) }),
				operation: "spawn",
			};
		case "steer":
			if (!hasOnlyKeys(value, ["childId", "event", "generation", "message", "operation", "requestId", "sequence", "threadId", "turnId", "type"])) {
				throw new EmpatraHostProtocolError("subagent_request_invalid", "subagent steer request contains unknown fields");
			}
			return { ...base, childId: identifier(value.childId, "childId"), message: boundedString(value.message, "message", EMPATRA_HOST_MAX_SUBAGENT_MESSAGE_BYTES), operation: "steer" };
		case "interrupt":
		case "close":
			if (!hasOnlyKeys(value, ["childId", "event", "generation", "operation", "requestId", "sequence", "threadId", "turnId", "type"])) {
				throw new EmpatraHostProtocolError("subagent_request_invalid", "subagent child request contains unknown fields");
			}
			return { ...base, childId: identifier(value.childId, "childId"), operation: value.operation };
		case "list":
			if (!hasOnlyKeys(value, ["event", "generation", "operation", "requestId", "sequence", "threadId", "turnId", "type"])) {
				throw new EmpatraHostProtocolError("subagent_request_invalid", "subagent list request contains unknown fields");
			}
			return { ...base, operation: "list" };
		default:
			throw new EmpatraHostProtocolError("subagent_unknown_request", "Unknown subagent request operation");
	}
}

/** Parse a projected lifecycle/progress/result event without exposing a transcript path. */
export function parseEmpatraHostSubagentEvent(value: unknown): EmpatraHostSubagentEvent {
	if (!isRecord(value) || value.type !== "host_event" || typeof value.event !== "string") {
		throw new EmpatraHostProtocolError("subagent_event_invalid", "subagent event is invalid");
	}
	const base = eventScope(value);
	const sequence = boundedInteger(value.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER);
	const childId = identifier(value.childId, "childId");
	if (value.event === "subagent_lifecycle") {
		if (
			!hasOnlyKeys(value, [
				"agentName",
				"childId",
				"event",
				"generation",
				"index",
				"threadId",
				"turnId",
				"sequence",
				"status",
				"type",
			]) ||
			(value.status !== "running" && value.status !== "completed" && value.status !== "failed" && value.status !== "aborted")
		) {
			throw new EmpatraHostProtocolError("subagent_event_invalid", "subagent lifecycle event is invalid");
		}
		return {
			...base,
			agentName: agentName(value.agentName),
			childId,
			event: "subagent_lifecycle",
			index: boundedInteger(value.index, "index", 0, EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN - 1),
			sequence,
			status: value.status,
			type: "host_event",
		};
	}
	if (value.event === "subagent_progress") {
		if (
			!hasOnlyKeys(value, [
				"childId",
				"event",
				"generation",
				"threadId",
				"turnId",
				"progress",
				"sequence",
				"status",
				"type",
			]) ||
			value.status !== "running"
		) {
			throw new EmpatraHostProtocolError("subagent_event_invalid", "subagent progress event is invalid");
		}
		return {
			...base,
			childId,
			event: "subagent_progress",
			progress: boundedString(value.progress, "progress", EMPATRA_HOST_MAX_SUBAGENT_PROGRESS_BYTES, true),
			sequence,
			status: "running",
			type: "host_event",
		};
	}
	if (value.event === "subagent_result") {
		if (
			!hasOnlyKeys(value, [
				"childId",
				"event",
				"generation",
				"output",
				"outputTruncated",
				"threadId",
				"turnId",
				"sequence",
				"status",
				"type",
			]) ||
			typeof value.outputTruncated !== "boolean" ||
			(value.status !== "completed" && value.status !== "failed" && value.status !== "aborted")
		) {
			throw new EmpatraHostProtocolError("subagent_event_invalid", "subagent result event is invalid");
		}
		return {
			...base,
			childId,
			event: "subagent_result",
			output: boundedString(value.output, "output", EMPATRA_HOST_MAX_SUBAGENT_RESULT_BYTES, true),
			outputTruncated: value.outputTruncated,
			sequence,
			status: value.status,
			type: "host_event",
		};
	}
	throw new EmpatraHostProtocolError("subagent_unknown_event", `Unknown subagent event: ${value.event}`);
}

export function assertEmpatraHostSubagentCapability(capabilities: readonly string[]): void {
	if (!capabilities.includes(EMPATRA_HOST_SUBAGENT_CAPABILITY)) {
		throw new EmpatraHostProtocolError(
			"subagent_unavailable",
			"OMP subagent lifecycle capability was not negotiated by the main host",
		);
	}
}

export interface EmpatraHostSubagentBroker {
	readonly capability: typeof EMPATRA_HOST_SUBAGENT_CAPABILITY;
	close(scope: EmpatraHostSubagentScope, childId: string): Promise<void>;
	interrupt(scope: EmpatraHostSubagentScope, childId: string): Promise<void>;
	list(scope: EmpatraHostSubagentScope): Promise<EmpatraHostSubagentListResult>;
	spawn(
		scope: EmpatraHostSubagentScope,
		request: Readonly<Pick<EmpatraHostSubagentSpawnCommand, "agentName" | "assignment" | "modelId">>,
	): Promise<EmpatraHostSubagentSpawnResult>;
	steer(scope: EmpatraHostSubagentScope, childId: string, message: string): Promise<void>;
}

export interface EmpatraHostSubagentRunContext {
	readonly agentName: string;
	readonly assignment: string;
	readonly childId: string;
	readonly modelId?: string;
	readonly parentThreadId: string;
	readonly parentTurnId: string;
	readonly signal: AbortSignal;
	onProgress(progress: string): void;
}

export interface EmpatraHostSubagentRunResult {
	output: string;
	status: Exclude<EmpatraHostSubagentLifecycleStatus, "running">;
}

/**
 * The only execution authority accepted by the host controller.  The runner
 * is injected by Electron main, where model selection, approval, workspace
 * inheritance, and task recursion policy are already owned.  It deliberately
 * has no cwd, environment, executable, or session-file fields.
 */
export interface EmpatraHostSubagentRunner {
	close?(childId: string): Promise<void>;
	interrupt?(childId: string): Promise<void>;
	run(context: EmpatraHostSubagentRunContext): Promise<EmpatraHostSubagentRunResult>;
	steer?(childId: string, message: string): Promise<void>;
}

export interface EmpatraHostSubagentControllerOptions {
	onEvent?: (event: EmpatraHostSubagentEvent) => Promise<void> | void;
	runner: EmpatraHostSubagentRunner;
	maxPerParent?: number;
	maxTotal?: number;
}

interface ActiveSubagent {
	abortController: AbortController;
	agentName: string;
	assignment: string;
	childId: string;
	generation: number;
	index: number;
	modelId?: string;
	parentThreadId: string;
	parentTurnId: string;
	runPromise: Promise<void>;
	updatedAtMs: number;
}

function subagentScopeKey(scope: EmpatraHostSubagentScope): string {
	return `${scope.parentThreadId}\u0000${scope.parentTurnId}\u0000${scope.generation}`;
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
	if (textEncoder.encode(value).byteLength <= maxBytes) return { text: value, truncated: false };
	let bytes = 0;
	let text = "";
	for (const character of value) {
		const characterBytes = textEncoder.encode(character).byteLength;
		if (bytes + characterBytes > maxBytes) break;
		bytes += characterBytes;
		text += character;
	}
	return { text, truncated: true };
}

function projectSubagentText(value: string, maxBytes: number): { text: string; truncated: boolean } {
	const safe = [...value]
		.map(character => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 32 && character !== "\n" && character !== "\r" && character !== "\t" ? "�" : character;
		})
		.join("");
	return truncateUtf8(safe, maxBytes);
}

/**
 * Main-owned bounded lifecycle controller for OMP task/subagent execution.
 *
 * This adapter is intentionally independent of the model-facing `TaskTool`:
 * OMP's task executor is injected as a runner so the host can expose only the
 * lifecycle/progress/result projection after Electron has granted the
 * capability.  Generation fencing and per-parent limits prevent stale turns
 * and unbounded fan-out from becoming a second source of truth.
 */
export class EmpatraHostSubagentController implements EmpatraHostSubagentBroker {
	readonly capability = EMPATRA_HOST_SUBAGENT_CAPABILITY;
	readonly #children = new Map<string, ActiveSubagent>();
	readonly #latestGenerations = new Map<string, number>();
	readonly #nextIndexes = new Map<string, number>();
	readonly #onEvent: (event: EmpatraHostSubagentEvent) => Promise<void> | void;
	readonly #runner: EmpatraHostSubagentRunner;
	readonly #maxPerParent: number;
	readonly #maxTotal: number;
	#disposed = false;

	constructor(options: EmpatraHostSubagentControllerOptions) {
		const maxPerParent = options.maxPerParent ?? EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN;
		const maxTotal = options.maxTotal ?? EMPATRA_HOST_MAX_SUBAGENT_SNAPSHOTS;
		if (!Number.isSafeInteger(maxPerParent) || maxPerParent < 1 || maxPerParent > EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN) {
			throw new RangeError("maxPerParent must be between 1 and 16");
		}
		if (!Number.isSafeInteger(maxTotal) || maxTotal < maxPerParent || maxTotal > EMPATRA_HOST_MAX_SUBAGENT_SNAPSHOTS) {
			throw new RangeError("maxTotal must be between maxPerParent and 256");
		}
		this.#maxPerParent = maxPerParent;
		this.#maxTotal = maxTotal;
		this.#onEvent = options.onEvent ?? (() => undefined);
		this.#runner = options.runner;
	}

	get isDisposed(): boolean {
		return this.#disposed;
	}

	async spawn(
		command: EmpatraHostSubagentSpawnCommand,
	): Promise<EmpatraHostSubagentSpawnResult> {
		this.#assertAvailable();
		this.#advanceGeneration(command);
		const parentKey = subagentScopeKey(command);
		const count = [...this.#children.values()].filter(child => subagentScopeKey(child) === parentKey).length;
		if (count >= this.#maxPerParent || this.#children.size >= this.#maxTotal) {
			throw new EmpatraHostProtocolError("subagent_capacity_exceeded", "Subagent capacity is exhausted");
		}
		const index = this.#nextIndexes.get(parentKey) ?? 0;
		if (index >= EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN) {
			throw new EmpatraHostProtocolError("subagent_capacity_exceeded", "Subagent generation limit is exhausted");
		}
		this.#nextIndexes.set(parentKey, index + 1);
		const child: ActiveSubagent = {
			abortController: new AbortController(),
			agentName: command.agentName ?? "task",
			assignment: command.assignment,
			childId: `subagent-${randomUUID()}`,
			generation: command.generation,
			index,
			...(command.modelId === undefined ? {} : { modelId: command.modelId }),
			parentThreadId: command.parentThreadId,
			parentTurnId: command.parentTurnId,
			runPromise: Promise.resolve(),
			updatedAtMs: Date.now(),
		};
		this.#children.set(child.childId, child);
		this.#emitLifecycle(child, "running");
		child.runPromise = this.#runChild(child);
		return { childId: child.childId, index, status: "running" };
	}

	async list(scope: EmpatraHostSubagentScope): Promise<EmpatraHostSubagentListResult> {
		this.#assertAvailable();
		this.#advanceGeneration(scope);
		return {
			subagents: [...this.#children.values()]
				.filter(child => subagentScopeKey(child) === subagentScopeKey(scope))
				.map(child => this.#snapshot(child)),
		};
	}

	async steer(scope: EmpatraHostSubagentScope, childId: string, message: string): Promise<void> {
		this.#assertAvailable();
		this.#advanceGeneration(scope);
		const child = this.#requireChild(scope, childId);
		if (!this.#runner.steer) {
			throw new EmpatraHostProtocolError("subagent_steer_unavailable", "Subagent steering is not wired by the main runner");
		}
		await this.#runner.steer(child.childId, message);
		child.updatedAtMs = Date.now();
	}

	async interrupt(scope: EmpatraHostSubagentScope, childId: string): Promise<void> {
		this.#assertAvailable();
		this.#advanceGeneration(scope);
		const child = this.#requireChild(scope, childId);
		child.abortController.abort();
		if (this.#runner.interrupt) await this.#runner.interrupt(child.childId);
		child.updatedAtMs = Date.now();
	}

	async close(scope: EmpatraHostSubagentScope, childId: string): Promise<void> {
		this.#assertAvailable();
		this.#advanceGeneration(scope);
		const child = this.#requireChild(scope, childId);
		child.abortController.abort();
		if (this.#runner.close) await this.#runner.close(child.childId);
		child.updatedAtMs = Date.now();
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const children = [...this.#children.values()];
		for (const child of children) {
			child.abortController.abort();
			if (this.#runner.close) await this.#runner.close(child.childId).catch(() => undefined);
		}
		await Promise.allSettled(children.map(child => child.runPromise));
		this.#children.clear();
		this.#latestGenerations.clear();
		this.#nextIndexes.clear();
	}

	#assertAvailable(): void {
		if (this.#disposed) throw new EmpatraHostProtocolError("subagent_disposed", "OMP subagent controller is disposed");
	}

	#advanceGeneration(scope: EmpatraHostSubagentScope): void {
		const previous = this.#latestGenerations.get(scope.parentThreadId);
		if (previous !== undefined && scope.generation < previous) {
			throw new EmpatraHostProtocolError("stale_turn", "Subagent command targets an older parent generation");
		}
		if (previous === undefined || scope.generation > previous) {
			this.#latestGenerations.set(scope.parentThreadId, scope.generation);
			for (const child of this.#children.values()) {
				if (child.parentThreadId === scope.parentThreadId && child.generation < scope.generation) child.abortController.abort();
			}
		}
	}

	#requireChild(scope: EmpatraHostSubagentScope, childId: string): ActiveSubagent {
		const child = this.#children.get(childId);
		if (
			!child ||
			child.parentThreadId !== scope.parentThreadId ||
			child.parentTurnId !== scope.parentTurnId ||
			child.generation !== scope.generation
		) {
			throw new EmpatraHostProtocolError("subagent_not_found", "Subagent is not active in the requested parent turn");
		}
		return child;
	}

	#snapshot(child: ActiveSubagent): EmpatraHostSubagentSnapshot {
		return {
			agentName: child.agentName,
			childId: child.childId,
			generation: child.generation,
			index: child.index,
			parentThreadId: child.parentThreadId,
			parentTurnId: child.parentTurnId,
			status: "running",
			updatedAtMs: child.updatedAtMs,
		};
	}

	#emit(event: EmpatraHostSubagentEvent): void {
		void Promise.resolve(this.#onEvent(event)).catch(() => undefined);
	}

	#nextSequence(child: ActiveSubagent): number {
		const key = subagentScopeKey(child);
		const next = this.#nextIndexes.get(`${key}\u0000events`) ?? 0;
		this.#nextIndexes.set(`${key}\u0000events`, next + 1);
		return next + 1;
	}

	#emitLifecycle(child: ActiveSubagent, status: EmpatraHostSubagentLifecycleStatus): void {
		this.#emit({
			agentName: child.agentName,
			childId: child.childId,
			event: "subagent_lifecycle",
			generation: child.generation,
			index: child.index,
			threadId: child.parentThreadId,
			turnId: child.parentTurnId,
			sequence: this.#nextSequence(child),
			status,
			type: "host_event",
		});
	}

	#runChild(child: ActiveSubagent): Promise<void> {
		return (async () => {
			let outcome: EmpatraHostSubagentRunResult;
			try {
				outcome = await this.#runner.run({
					agentName: child.agentName,
					assignment: child.assignment,
					childId: child.childId,
					...(child.modelId === undefined ? {} : { modelId: child.modelId }),
					parentThreadId: child.parentThreadId,
					parentTurnId: child.parentTurnId,
					signal: child.abortController.signal,
					onProgress: progress => {
						child.updatedAtMs = Date.now();
						const projection = projectSubagentText(progress, EMPATRA_HOST_MAX_SUBAGENT_PROGRESS_BYTES);
						this.#emit({
							childId: child.childId,
							event: "subagent_progress",
							generation: child.generation,
							threadId: child.parentThreadId,
							turnId: child.parentTurnId,
							progress: projection.text,
							sequence: this.#nextSequence(child),
							status: "running",
							type: "host_event",
						});
					},
				});
			} catch {
				outcome = { output: "", status: child.abortController.signal.aborted ? "aborted" : "failed" };
			}
			if (
				typeof outcome.output !== "string" ||
				(outcome.status !== "completed" && outcome.status !== "failed" && outcome.status !== "aborted")
			) {
				outcome = { output: "", status: child.abortController.signal.aborted ? "aborted" : "failed" };
			}
			const status = child.abortController.signal.aborted ? "aborted" : outcome.status;
			const projection = projectSubagentText(outcome.output, EMPATRA_HOST_MAX_SUBAGENT_RESULT_BYTES);
			this.#emit({
				childId: child.childId,
				event: "subagent_result",
				generation: child.generation,
				output: projection.text,
				outputTruncated: projection.truncated,
				threadId: child.parentThreadId,
				turnId: child.parentTurnId,
				sequence: this.#nextSequence(child),
				status,
				type: "host_event",
			});
			this.#emitLifecycle(child, status);
			this.#children.delete(child.childId);
		})();
	}
}

export function createFailClosedEmpatraHostSubagentBroker(): EmpatraHostSubagentBroker {
	const unavailable = async (): Promise<never> => {
		throw new EmpatraHostProtocolError(
			"subagent_unavailable",
			"OMP subagent lifecycle requires a main-owned executor",
		);
	};
	return {
		capability: EMPATRA_HOST_SUBAGENT_CAPABILITY,
		close: unavailable,
		interrupt: unavailable,
		list: unavailable,
		spawn: unavailable,
		steer: unavailable,
	};
}

export type EmpatraHostSubagentRequestEventEmitter = (event: EmpatraHostSubagentRequestEvent) => Promise<void>;

/** Sidecar transport for requests answered by Electron main. */
export interface EmpatraHostSubagentRpcTransport {
	readonly broker: EmpatraHostSubagentBroker;
	handleResponse(response: EmpatraHostSubagentResponseCommand): void;
	dispose(): void;
}

export function createEmpatraHostSubagentRpcTransport(options: Readonly<{
	capabilities?: readonly string[];
	emitEvent: EmpatraHostSubagentRequestEventEmitter;
	maxInflight?: number;
	nextSequence?: (scope: Pick<EmpatraHostSubagentRequestBase, "generation" | "threadId" | "turnId">) => number;
}>): EmpatraHostSubagentRpcTransport {
	assertEmpatraHostSubagentCapability(options.capabilities ?? []);
	const maxInflight = options.maxInflight ?? EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN;
	if (!Number.isSafeInteger(maxInflight) || maxInflight < 1 || maxInflight > EMPATRA_HOST_MAX_SUBAGENT_SNAPSHOTS) {
		throw new RangeError("maxInflight must be between 1 and 256");
	}
	const pending = new Map<string, { reject: (error: unknown) => void; resolve: (result: EmpatraHostSubagentCommandResult | undefined) => void }>();
	let disposed = false;
	let sequence = 0;
	const issue = async (event: EmpatraHostSubagentRequestEvent) => {
		if (disposed) throw new EmpatraHostProtocolError("subagent_disposed", "OMP subagent RPC transport is disposed");
		if (pending.size >= maxInflight) throw new EmpatraHostProtocolError("subagent_capacity_exceeded", "OMP subagent request capacity is exhausted");
		const { promise, resolve, reject } = Promise.withResolvers<EmpatraHostSubagentCommandResult | undefined>();
		pending.set(event.requestId, { reject, resolve });
		try {
			await options.emitEvent(event);
		} catch (error) {
			pending.delete(event.requestId);
			reject(error);
		}
		return promise;
	};
	const base = (scope: EmpatraHostSubagentScope) => {
		const requestScope = {
			generation: boundedInteger(scope.generation, "generation", 1, Number.MAX_SAFE_INTEGER),
			threadId: identifier(scope.parentThreadId, "threadId"),
			turnId: identifier(scope.parentTurnId, "turnId"),
		};
		const next = options.nextSequence?.(requestScope) ?? ++sequence;
		if (!Number.isSafeInteger(next) || next < 1) throw new EmpatraHostProtocolError("subagent_request_invalid", "sequence is invalid");
		return { ...requestScope, event: "subagent_request" as const, requestId: randomUUID(), sequence: next, type: "host_event" as const };
	};
	const broker: EmpatraHostSubagentBroker = {
		capability: EMPATRA_HOST_SUBAGENT_CAPABILITY,
		close: async (scope, childId) => { await issue({ ...base(scope), childId: identifier(childId, "childId"), operation: "close" }); },
		interrupt: async (scope, childId) => { await issue({ ...base(scope), childId: identifier(childId, "childId"), operation: "interrupt" }); },
		list: async scope => {
			const result = await issue({ ...base(scope), operation: "list" });
			if (!result || !("subagents" in result)) throw new EmpatraHostProtocolError("subagent_response_invalid", "OMP returned an invalid subagent list");
			return result;
		},
		spawn: async (scope, request) => {
			const result = await issue({ ...base(scope), ...(request.agentName === undefined ? {} : { agentName: agentName(request.agentName) }), assignment: boundedString(request.assignment, "assignment", EMPATRA_HOST_MAX_SUBAGENT_ASSIGNMENT_BYTES), ...(request.modelId === undefined ? {} : { modelId: optionalModelId(request.modelId) }), operation: "spawn" });
			if (!result || !("childId" in result)) throw new EmpatraHostProtocolError("subagent_response_invalid", "OMP returned an invalid subagent spawn result");
			return result;
		},
		steer: async (scope, childId, message) => { await issue({ ...base(scope), childId: identifier(childId, "childId"), message: boundedString(message, "message", EMPATRA_HOST_MAX_SUBAGENT_MESSAGE_BYTES), operation: "steer" }); },
	};
	return {
		broker,
		handleResponse: response => {
			if (disposed) return;
			const parsed = parseEmpatraHostSubagentResponse(response);
			const current = pending.get(parsed.id);
			if (!current) return;
			pending.delete(parsed.id);
			if (!parsed.success) {
				current.reject(new EmpatraHostProtocolError(parsed.error?.code ?? "subagent_failed", parsed.error?.message ?? "OMP subagent request failed"));
				return;
			}
			current.resolve(parsed.data);
		},
		dispose: () => {
			disposed = true;
			const error = new EmpatraHostProtocolError("subagent_disposed", "OMP subagent RPC transport is disposed");
			for (const entry of pending.values()) entry.reject(error);
			pending.clear();
		},
	};
}

export type EmpatraHostSubagentRequestEmitter = (command: EmpatraHostSubagentCommand) => Promise<void>;

export interface EmpatraHostSubagentTransport {
	readonly broker: EmpatraHostSubagentBroker;
	handleEvent(event: EmpatraHostSubagentEvent): void;
	handleResponse(response: EmpatraHostSubagentResponse): void;
	dispose(): void;
}

interface PendingResponse {
	command: EmpatraHostSubagentCommand["type"];
	reject: (error: unknown) => void;
	resolve: (result: EmpatraHostSubagentCommandResult | undefined) => void;
}

export function createEmpatraHostSubagentTransport(options: Readonly<{
	capabilities?: readonly string[];
	emitCommand: EmpatraHostSubagentRequestEmitter;
	maxInflight?: number;
	nextSequence?: (scope: EmpatraHostSubagentScope) => number;
	onEvent?: (event: EmpatraHostSubagentEvent) => void;
}>): EmpatraHostSubagentTransport {
	assertEmpatraHostSubagentCapability(options.capabilities ?? []);
	const maxInflight = options.maxInflight ?? EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN;
	if (!Number.isSafeInteger(maxInflight) || maxInflight < 1 || maxInflight > EMPATRA_HOST_MAX_SUBAGENT_SNAPSHOTS) {
		throw new RangeError("maxInflight must be between 1 and 256");
	}
	const pending = new Map<string, PendingResponse>();
	let disposed = false;
	let sequence = 0;
	const nextSequence = (scope: EmpatraHostSubagentScope): number => {
		const next = options.nextSequence?.(scope) ?? ++sequence;
		if (!Number.isSafeInteger(next) || next < 1) throw new EmpatraHostProtocolError("subagent_event_invalid", "sequence is invalid");
		return next;
	};
	const issue = async (
		command: EmpatraHostSubagentCommand,
	): Promise<EmpatraHostSubagentCommandResult | undefined> => {
		if (disposed) throw new EmpatraHostProtocolError("subagent_disposed", "OMP subagent transport is disposed");
		if (pending.size >= maxInflight) {
			throw new EmpatraHostProtocolError(
				"subagent_capacity_exceeded",
				"OMP subagent request capacity is exhausted",
			);
		}
		const { promise, resolve, reject } = Promise.withResolvers<EmpatraHostSubagentCommandResult | undefined>();
		pending.set(command.id, { command: command.type, reject, resolve });
		try {
			await options.emitCommand(command);
		} catch (error) {
			pending.delete(command.id);
			reject(error);
		}
		return promise;
	};
	const createCommandBase = (scope: EmpatraHostSubagentScope) => ({
		generation: boundedInteger(scope.generation, "generation", 1, Number.MAX_SAFE_INTEGER),
		id: randomUUID(),
		parentThreadId: identifier(scope.parentThreadId, "parentThreadId"),
		parentTurnId: identifier(scope.parentTurnId, "parentTurnId"),
	});
	const broker: EmpatraHostSubagentBroker = {
		capability: EMPATRA_HOST_SUBAGENT_CAPABILITY,
		close: async (scope, childId) => {
			await issue({ ...createCommandBase(scope), childId: identifier(childId, "childId"), type: "subagent_close" });
		},
		interrupt: async (scope, childId) => {
			await issue({ ...createCommandBase(scope), childId: identifier(childId, "childId"), type: "subagent_interrupt" });
		},
		list: async scope => {
			const result = await issue({ ...createCommandBase(scope), type: "subagent_list" });
			if (!result || !("subagents" in result)) {
				throw new EmpatraHostProtocolError(
					"subagent_response_invalid",
					"OMP returned an invalid subagent list",
				);
			}
			return result;
		},
		spawn: async (scope, request) => {
			const result = await issue({
				...createCommandBase(scope),
				...(request.agentName === undefined ? {} : { agentName: agentName(request.agentName) }),
				assignment: boundedString(request.assignment, "assignment", EMPATRA_HOST_MAX_SUBAGENT_ASSIGNMENT_BYTES),
				...(request.modelId === undefined ? {} : { modelId: optionalModelId(request.modelId) }),
				type: "subagent_spawn",
			});
			if (!result || !("childId" in result)) {
				throw new EmpatraHostProtocolError(
					"subagent_response_invalid",
					"OMP returned an invalid subagent spawn result",
				);
			}
			return result;
		},
		steer: async (scope, childId, message) => {
			await issue({
				...createCommandBase(scope),
				childId: identifier(childId, "childId"),
				message: boundedString(message, "message", EMPATRA_HOST_MAX_SUBAGENT_MESSAGE_BYTES),
				type: "subagent_steer",
			});
		},
	};
	return {
		broker,
		handleEvent: event => {
			if (disposed) return;
			const parsed = parseEmpatraHostSubagentEvent(event);
			options.onEvent?.(parsed);
		},
		handleResponse: response => {
			if (disposed) return;
			const parsed = parseEmpatraHostSubagentResponse(response);
			const current = pending.get(parsed.id);
			if (!current) return;
			pending.delete(parsed.id);
			if (!parsed.success) {
				current.reject(
					new EmpatraHostProtocolError(
						parsed.error?.code ?? "subagent_failed",
						parsed.error?.message ?? "OMP subagent request failed",
					),
				);
				return;
			}
			current.resolve(parsed.data);
		},
		dispose: () => {
			disposed = true;
			const error = new EmpatraHostProtocolError("subagent_disposed", "OMP subagent transport is disposed");
			for (const entry of pending.values()) entry.reject(error);
			pending.clear();
		},
	};
}
