import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isValidJsonSchema } from "@oh-my-pi/pi-ai/utils/schema";

import { ESSENTIAL_BUILTIN_TOOL_NAMES } from "../../tools/essential-tools";
import { RpcHostToolBridge, type RpcHostToolDispatchContext } from "../rpc/host-tools";
import type { RpcHostToolCallRequest, RpcHostToolCancelRequest, RpcHostToolDefinition } from "../rpc/rpc-types";
import { EmpatraHostProtocolError } from "./errors";
import {
	EMPATRA_HOST_MAX_HOST_TOOL_ARGUMENT_BYTES,
	type EmpatraHostToolCancelFrame,
	type EmpatraHostToolDefinition,
	type EmpatraHostToolOutboundFrame,
	type EmpatraHostToolResultFrame,
} from "./protocol";

export const EMPATRA_HOST_TOOL_WATCHDOG_MS = 15 * 60 * 1000;
export const EMPATRA_HOST_MAX_PENDING_TOOLS = 64;
export const EMPATRA_HOST_MAX_PENDING_TOOLS_PER_TURN = 16;

const encoder = new TextEncoder();

export interface EmpatraHostToolScope {
	catalogRevision: string;
	generation: number;
	threadId: string;
	turnId: string;
}

interface PendingHostTool extends EmpatraHostToolScope {
	bridge: RpcHostToolBridge;
	cancelWatchdog: () => void;
	owner: EmpatraHostSessionTools;
	toolCallId: string;
	toolName: string;
}

export type EmpatraHostToolTimeoutScheduler = (callback: () => void, delayMs: number) => () => void;

function scheduleHostToolTimeout(callback: () => void, delayMs: number): () => void {
	const timer = setTimeout(callback, delayMs);
	return () => clearTimeout(timer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (!isRecord(value)) throw new EmpatraHostProtocolError("host_tool_catalog_invalid", "Catalog is not JSON");
	return `{${Object.keys(value)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
		.join(",")}}`;
}

export function computeEmpatraHostToolCatalogRevision(tools: readonly EmpatraHostToolDefinition[]): string {
	const canonical = canonicalJson(
		[...tools].toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
	);
	return `sha256:${new Bun.CryptoHasher("sha256").update(canonical).digest("hex").toLowerCase()}`;
}

export function validateEmpatraHostToolCatalog(
	tools: readonly EmpatraHostToolDefinition[],
	catalogRevision: string,
): readonly EmpatraHostToolDefinition[] {
	const names = new Set<string>();
	for (const tool of tools) {
		if (names.has(tool.name)) {
			throw new EmpatraHostProtocolError("host_tool_catalog_invalid", "Host tool names must be unique");
		}
		names.add(tool.name);
		if (tool.name in ESSENTIAL_BUILTIN_TOOL_NAMES) {
			throw new EmpatraHostProtocolError("host_tool_catalog_invalid", "Host tool conflicts with a native tool");
		}
		if (!isValidJsonSchema(tool.parameters)) {
			throw new EmpatraHostProtocolError("host_tool_catalog_invalid", "Host tool schema is invalid");
		}
	}
	if (computeEmpatraHostToolCatalogRevision(tools) !== catalogRevision) {
		throw new EmpatraHostProtocolError("host_tool_catalog_mismatch", "Host tool catalog digest mismatch");
	}
	return tools;
}

function rpcDefinition(tool: EmpatraHostToolDefinition): RpcHostToolDefinition {
	return {
		description: tool.description,
		...(tool.hidden === undefined ? {} : { hidden: tool.hidden }),
		...(tool.label === undefined ? {} : { label: tool.label }),
		...(tool.loadMode === undefined ? {} : { loadMode: tool.loadMode }),
		name: tool.name,
		parameters: tool.parameters,
	};
}

function safeFailureResult(message: string): AgentToolResult<unknown> {
	return { content: [{ text: message, type: "text" }] };
}

function turnKey(scope: Pick<EmpatraHostToolScope, "generation" | "threadId" | "turnId">): string {
	return `${scope.threadId}\0${scope.turnId}\0${scope.generation}`;
}

export class EmpatraHostToolsConnection {
	readonly #completed = new Set<string>();
	readonly #pending = new Map<string, PendingHostTool>();
	#sink: (frame: EmpatraHostToolOutboundFrame) => Promise<void> = async () => {
		throw new EmpatraHostProtocolError("event_sink_missing", "Host tool transport is unavailable");
	};
	readonly #scheduleTimeout: EmpatraHostToolTimeoutScheduler;

	constructor(options: { scheduleTimeout?: EmpatraHostToolTimeoutScheduler } = {}) {
		this.#scheduleTimeout = options.scheduleTimeout ?? scheduleHostToolTimeout;
	}

	setSink(sink: (frame: EmpatraHostToolOutboundFrame) => Promise<void>): void {
		this.#sink = sink;
	}

	createSession(getScope: () => EmpatraHostToolScope | undefined): EmpatraHostSessionTools {
		return new EmpatraHostSessionTools(this, getScope);
	}

	dispatchCall(
		owner: EmpatraHostSessionTools,
		bridge: RpcHostToolBridge,
		frame: RpcHostToolCallRequest,
		scope: EmpatraHostToolScope,
	): void {
		let serializedArguments: string;
		try {
			serializedArguments = JSON.stringify(frame.arguments);
		} catch {
			throw new EmpatraHostProtocolError("host_tool_protocol_violation", "Host tool arguments are not JSON");
		}
		if (encoder.encode(serializedArguments).byteLength > EMPATRA_HOST_MAX_HOST_TOOL_ARGUMENT_BYTES) {
			throw new EmpatraHostProtocolError("frame_too_large", "Host tool arguments exceed their limit");
		}
		if (this.#pending.has(frame.id) || this.#completed.has(frame.id)) {
			throw new EmpatraHostProtocolError("host_tool_protocol_violation", "Host tool call id is duplicated");
		}
		if (this.#pending.size >= EMPATRA_HOST_MAX_PENDING_TOOLS) {
			throw new EmpatraHostProtocolError("host_tool_capacity", "Host tool connection capacity is exhausted");
		}
		const key = turnKey(scope);
		const perTurn = [...this.#pending.values()].filter(pending => turnKey(pending) === key).length;
		if (perTurn >= EMPATRA_HOST_MAX_PENDING_TOOLS_PER_TURN) {
			throw new EmpatraHostProtocolError("host_tool_capacity", "Host tool turn capacity is exhausted");
		}
		const cancelWatchdog = this.#scheduleTimeout(() => this.#expire(frame.id), EMPATRA_HOST_TOOL_WATCHDOG_MS);
		this.#pending.set(frame.id, {
			...scope,
			bridge,
			cancelWatchdog,
			owner,
			toolCallId: frame.toolCallId,
			toolName: frame.toolName,
		});
		const outbound: EmpatraHostToolOutboundFrame = {
			...scope,
			arguments: frame.arguments,
			id: frame.id,
			toolCallId: frame.toolCallId,
			toolName: frame.toolName,
			type: "host_tool_call",
		};
		this.#send(outbound, () => this.#fail(frame.id, "Host tool transport failed"));
	}

	dispatchAgentCancel(frame: RpcHostToolCancelRequest): void {
		const pending = this.#take(frame.targetId);
		if (!pending) return;
		const outbound: EmpatraHostToolOutboundFrame = {
			catalogRevision: pending.catalogRevision,
			generation: pending.generation,
			id: frame.id,
			targetId: frame.targetId,
			threadId: pending.threadId,
			turnId: pending.turnId,
			type: "host_tool_cancel",
		};
		this.#send(outbound, () => undefined);
	}

	handleResult(frame: EmpatraHostToolResultFrame): void {
		const pending = this.#requireCorrelated(frame.id, frame);
		this.#take(frame.id);
		const accepted = pending.bridge.handleResult({
			id: frame.id,
			isError: frame.failed,
			result: { ...frame.result, ...(frame.failed ? { isError: true } : {}) },
			type: "host_tool_result",
		});
		if (!accepted) {
			throw new EmpatraHostProtocolError("host_tool_protocol_violation", "Host tool result was not accepted");
		}
	}

	handleHostCancel(frame: EmpatraHostToolCancelFrame): void {
		const pending = this.#requireCorrelated(frame.targetId, frame);
		this.#take(frame.targetId);
		const accepted = pending.bridge.handleResult({
			id: frame.targetId,
			isError: true,
			result: safeFailureResult("Host tool execution was cancelled"),
			type: "host_tool_result",
		});
		if (!accepted) {
			throw new EmpatraHostProtocolError("host_tool_protocol_violation", "Host tool cancellation was not accepted");
		}
	}

	cancelOwner(owner: EmpatraHostSessionTools, message = "Host tool session closed"): void {
		for (const [id, pending] of [...this.#pending]) {
			if (pending.owner !== owner) continue;
			this.#take(id);
			pending.bridge.handleResult({
				id,
				isError: true,
				result: safeFailureResult(message),
				type: "host_tool_result",
			});
		}
	}

	dispose(): void {
		for (const [id, pending] of [...this.#pending]) {
			this.#take(id);
			pending.bridge.handleResult({
				id,
				isError: true,
				result: safeFailureResult("Host tool connection closed"),
				type: "host_tool_result",
			});
		}
	}

	#requireCorrelated(id: string, frame: EmpatraHostToolScope): PendingHostTool {
		const pending = this.#pending.get(id);
		if (!pending) {
			throw new EmpatraHostProtocolError(
				this.#completed.has(id) ? "host_tool_protocol_violation" : "host_tool_not_pending",
				"Host tool response is stale or replayed",
			);
		}
		if (
			pending.catalogRevision !== frame.catalogRevision ||
			pending.generation !== frame.generation ||
			pending.threadId !== frame.threadId ||
			pending.turnId !== frame.turnId
		) {
			throw new EmpatraHostProtocolError("host_tool_protocol_violation", "Host tool response scope mismatched");
		}
		return pending;
	}

	#take(id: string): PendingHostTool | undefined {
		const pending = this.#pending.get(id);
		if (!pending) return undefined;
		pending.cancelWatchdog();
		this.#pending.delete(id);
		this.#completed.add(id);
		if (this.#completed.size > 4096) this.#completed.delete(this.#completed.values().next().value ?? "");
		return pending;
	}

	#expire(id: string): void {
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#send(
			{
				catalogRevision: pending.catalogRevision,
				generation: pending.generation,
				id: crypto.randomUUID(),
				targetId: id,
				threadId: pending.threadId,
				turnId: pending.turnId,
				type: "host_tool_cancel",
			},
			() => undefined,
		);
		this.#fail(id, "Host tool execution timed out");
	}

	#send(frame: EmpatraHostToolOutboundFrame, onFailure: () => void): void {
		let delivery: Promise<void>;
		try {
			delivery = this.#sink(frame);
		} catch {
			onFailure();
			return;
		}
		void delivery.catch(onFailure);
	}

	#fail(id: string, message: string): void {
		const pending = this.#take(id);
		if (!pending) return;
		pending.bridge.handleResult({ id, isError: true, result: safeFailureResult(message), type: "host_tool_result" });
	}
}

export class EmpatraHostSessionTools {
	readonly #bridge: RpcHostToolBridge;
	readonly #connection: EmpatraHostToolsConnection;
	readonly #getScope: () => EmpatraHostToolScope | undefined;
	readonly #revisions = new WeakMap<RpcHostToolDefinition, string>();
	#toolNames = new Set<string>();

	constructor(connection: EmpatraHostToolsConnection, getScope: () => EmpatraHostToolScope | undefined) {
		this.#connection = connection;
		this.#getScope = getScope;
		this.#bridge = new RpcHostToolBridge((frame, context) => this.#dispatch(frame, context));
	}

	getToolNames(): ReadonlySet<string> {
		return this.#toolNames;
	}

	replaceCatalog(tools: readonly EmpatraHostToolDefinition[], catalogRevision: string): AgentTool[] {
		const definitions = tools.map(rpcDefinition);
		for (const definition of definitions) this.#revisions.set(definition, catalogRevision);
		this.#toolNames = new Set(definitions.map(definition => definition.name));
		return this.#bridge.setTools(definitions);
	}

	dispose(): void {
		this.#connection.cancelOwner(this);
		this.#bridge.close("Host tool session closed");
	}

	#dispatch(frame: RpcHostToolCallRequest | RpcHostToolCancelRequest, context?: RpcHostToolDispatchContext): void {
		if (frame.type === "host_tool_cancel") {
			this.#connection.dispatchAgentCancel(frame);
			return;
		}
		if (!context) throw new EmpatraHostProtocolError("host_tool_protocol_violation", "Host tool context is missing");
		const revision = this.#revisions.get(context.definition);
		const scope = this.#getScope();
		if (!scope || !revision) {
			throw new EmpatraHostProtocolError("host_tool_protocol_violation", "Host tool turn scope is stale");
		}
		this.#connection.dispatchCall(this, this.#bridge, frame, { ...scope, catalogRevision: revision });
	}
}
