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

export interface EmpatraHostSubagentLifecycleEvent extends EmpatraHostSubagentScope {
	agentName: string;
	childId: string;
	event: "subagent_lifecycle";
	index: number;
	sequence: number;
	status: EmpatraHostSubagentLifecycleStatus;
	type: "host_event";
}

export interface EmpatraHostSubagentProgressEvent extends EmpatraHostSubagentScope {
	childId: string;
	event: "subagent_progress";
	progress: string;
	sequence: number;
	status: "running";
	type: "host_event";
}

export interface EmpatraHostSubagentResultEvent extends EmpatraHostSubagentScope {
	childId: string;
	event: "subagent_result";
	output: string;
	outputTruncated: boolean;
	sequence: number;
	status: Exclude<EmpatraHostSubagentLifecycleStatus, "running">;
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

/** Parse a projected lifecycle/progress/result event without exposing a transcript path. */
export function parseEmpatraHostSubagentEvent(value: unknown): EmpatraHostSubagentEvent {
	if (!isRecord(value) || value.type !== "host_event" || typeof value.event !== "string") {
		throw new EmpatraHostProtocolError("subagent_event_invalid", "subagent event is invalid");
	}
	const base = scope(value);
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
				"parentThreadId",
				"parentTurnId",
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
				"parentThreadId",
				"parentTurnId",
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
				"parentThreadId",
				"parentTurnId",
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
			parseEmpatraHostSubagentEvent(event);
			options.onEvent?.(event);
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
