import { EmpatraHostProtocolError } from "./errors";
import { EMPATRA_HOST_EXECUTION_BROKER_CAPABILITY } from "./protocol";
import { randomUUID } from "node:crypto";

/**
 * Reserved capability for the future main-owned execution broker.
 *
 * This is intentionally not part of `EMPATRA_HOST_CAPABILITIES` yet. OMP's
 * native shell/filesystem adapters execute in the OMP process today, while an
 * Empatra desktop host must keep those powers in Electron main. A controller
 * must therefore never infer this capability from the existence of this
 * module; it is advertised only after a real broker is wired and tested.
 */
export type EmpatraHostExecutionBrokerCapability = typeof EMPATRA_HOST_EXECUTION_BROKER_CAPABILITY;

/** Operations that can be delegated to Electron main without exposing a shell. */
export const EMPATRA_HOST_EXECUTION_OPERATIONS = [
	"filesystem.read",
	"filesystem.write",
	"filesystem.list",
	"process.exec",
] as const;
export type EmpatraHostExecutionOperation = (typeof EMPATRA_HOST_EXECUTION_OPERATIONS)[number];

export const EMPATRA_HOST_MAX_EXECUTION_PATH_BYTES = 4096;
export const EMPATRA_HOST_MAX_EXECUTION_COMMAND_BYTES = 16 * 1024;
export const EMPATRA_HOST_MAX_EXECUTION_ARGUMENTS = 128;
export const EMPATRA_HOST_MAX_EXECUTION_ARGUMENT_BYTES = 16 * 1024;
export const EMPATRA_HOST_MAX_EXECUTION_INPUT_BYTES = 4 * 1024 * 1024;
export const EMPATRA_HOST_MAX_EXECUTION_OUTPUT_BYTES = 512 * 1024;
export const EMPATRA_HOST_MAX_EXECUTION_TIMEOUT_MS = 15 * 60 * 1000;

export interface EmpatraHostExecutionScope {
	generation: number;
	threadId: string;
	turnId: string;
}

export interface EmpatraHostFilesystemReadRequest extends EmpatraHostExecutionScope {
	maxBytes: number;
	offsetBytes?: number;
	operation: "filesystem.read";
	path: string;
}

export interface EmpatraHostFilesystemWriteRequest extends EmpatraHostExecutionScope {
	content: string;
	expectedSha256?: string;
	operation: "filesystem.write";
	path: string;
}

export interface EmpatraHostFilesystemListRequest extends EmpatraHostExecutionScope {
	maxEntries: number;
	operation: "filesystem.list";
	path: string;
}

/**
 * Process execution deliberately has argv only. There is no shell, env, or
 * executable search-path override in this contract; Electron main chooses the
 * platform adapter and environment after policy/approval checks.
 */
export interface EmpatraHostProcessExecRequest extends EmpatraHostExecutionScope {
	args: readonly string[];
	command: string;
	maxOutputBytes: number;
	operation: "process.exec";
	timeoutMs: number;
}

export type EmpatraHostExecutionRequest =
	| EmpatraHostFilesystemReadRequest
	| EmpatraHostFilesystemWriteRequest
	| EmpatraHostFilesystemListRequest
	| EmpatraHostProcessExecRequest;

export interface EmpatraHostExecutionResult {
	exitCode?: number;
	output: string;
	outputTruncated: boolean;
	operation: EmpatraHostExecutionOperation;
}

/**
 * Sidecar-to-main request DTO. The request is deliberately nested so a future
 * protocol extension cannot silently add shell/environment fields alongside
 * the correlation scope. This DTO is reserved until the capability is
 * advertised by a real Electron-main adapter.
 */
export interface EmpatraHostExecutionBrokerRequest extends EmpatraHostExecutionScope {
	id: string;
	request: EmpatraHostExecutionRequest;
	type: "execution_broker_request";
}

/**
 * Sidecar-to-main request carried as a host event.  It intentionally uses the
 * normal turn identity and sequence so the controller can reject requests
 * from a stale process generation before they reach an executor.
 */
export interface EmpatraHostExecutionBrokerRequestEvent extends EmpatraHostExecutionScope {
	event: "execution_broker_request";
	id: string;
	request: EmpatraHostExecutionRequest;
	sequence: number;
	type: "host_event";
}

export interface EmpatraHostExecutionBrokerResponse extends EmpatraHostExecutionScope {
	error?: Readonly<{ code: string; message: string }>;
	id: string;
	operation: EmpatraHostExecutionOperation;
	result?: EmpatraHostExecutionResult;
	type: "execution_broker_response";
}

/** Main-to-sidecar response command for an execution broker request. */
export type EmpatraHostExecutionBrokerResponseCommand = EmpatraHostExecutionBrokerResponse;

export interface EmpatraHostExecutionBrokerTransport {
	readonly broker: EmpatraHostExecutionBroker;
	handleResponse(response: EmpatraHostExecutionBrokerResponse): void;
	dispose(): void;
}

export interface EmpatraHostExecutionBroker {
	readonly capability: EmpatraHostExecutionBrokerCapability;
	execute(request: EmpatraHostExecutionRequest, signal?: AbortSignal): Promise<EmpatraHostExecutionResult>;
}

export type EmpatraHostExecutionExecutor = (
	request: EmpatraHostExecutionRequest,
	signal?: AbortSignal,
) => Promise<EmpatraHostExecutionResult>;

export type EmpatraHostExecutionRequestEmitter = (event: EmpatraHostExecutionBrokerRequestEvent) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every(key => allowed.has(key));
}

function boundedString(value: unknown, field: string, maxBytes: number): string {
	if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > maxBytes) {
		throw new EmpatraHostProtocolError("execution_request_invalid", `${field} is invalid`);
	}
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 32 && character !== "\n" && character !== "\r" && character !== "\t") {
			throw new EmpatraHostProtocolError("execution_request_invalid", `${field} is invalid`);
		}
	}
	return value;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
		throw new EmpatraHostProtocolError("execution_request_invalid", `${field} is invalid`);
	}
	return value as number;
}

function scope(value: Record<string, unknown>): EmpatraHostExecutionScope {
	return {
		generation: boundedInteger(value.generation, "generation", 1, Number.MAX_SAFE_INTEGER),
		threadId: boundedString(value.threadId, "threadId", 256),
		turnId: boundedString(value.turnId, "turnId", 256),
	};
}

function identifier(value: unknown, field: string): string {
	return boundedString(value, field, 256);
}

function sha256(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
		throw new EmpatraHostProtocolError("execution_request_invalid", `${field} is invalid`);
	}
	return value;
}

/**
 * Strictly validate a request at the OMP boundary before it can reach a
 * platform adapter. Paths are still authorized by Electron main; this check
 * only keeps the wire shape bounded and prevents shell-like fields from being
 * smuggled through a future implementation.
 */
export function parseEmpatraHostExecutionRequest(value: unknown): EmpatraHostExecutionRequest {
	if (!isRecord(value) || typeof value.operation !== "string") {
		throw new EmpatraHostProtocolError("execution_request_invalid", "execution request is invalid");
	}
	const base = scope(value);
	switch (value.operation) {
		case "filesystem.read":
			if (
				!hasOnlyKeys(value, ["generation", "maxBytes", "offsetBytes", "operation", "path", "threadId", "turnId"])
			) {
				throw new EmpatraHostProtocolError("execution_request_invalid", "filesystem.read contains unknown fields");
			}
			return {
				...base,
				maxBytes: boundedInteger(value.maxBytes, "maxBytes", 1, EMPATRA_HOST_MAX_EXECUTION_OUTPUT_BYTES),
				...(value.offsetBytes === undefined
					? {}
					: { offsetBytes: boundedInteger(value.offsetBytes, "offsetBytes", 0, Number.MAX_SAFE_INTEGER) }),
				operation: "filesystem.read",
				path: boundedString(value.path, "path", EMPATRA_HOST_MAX_EXECUTION_PATH_BYTES),
			};
		case "filesystem.write":
			if (
				!hasOnlyKeys(value, ["content", "expectedSha256", "generation", "operation", "path", "threadId", "turnId"])
			) {
				throw new EmpatraHostProtocolError("execution_request_invalid", "filesystem.write contains unknown fields");
			}
			return {
				...base,
				content: boundedString(value.content, "content", EMPATRA_HOST_MAX_EXECUTION_INPUT_BYTES),
				...(sha256(value.expectedSha256, "expectedSha256") === undefined
					? {}
					: { expectedSha256: sha256(value.expectedSha256, "expectedSha256") }),
				operation: "filesystem.write",
				path: boundedString(value.path, "path", EMPATRA_HOST_MAX_EXECUTION_PATH_BYTES),
			};
		case "filesystem.list":
			if (!hasOnlyKeys(value, ["generation", "maxEntries", "operation", "path", "threadId", "turnId"])) {
				throw new EmpatraHostProtocolError("execution_request_invalid", "filesystem.list contains unknown fields");
			}
			return {
				...base,
				maxEntries: boundedInteger(value.maxEntries, "maxEntries", 1, 10_000),
				operation: "filesystem.list",
				path: boundedString(value.path, "path", EMPATRA_HOST_MAX_EXECUTION_PATH_BYTES),
			};
		case "process.exec":
			if (
				!hasOnlyKeys(value, [
					"args",
					"command",
					"generation",
					"maxOutputBytes",
					"operation",
					"threadId",
					"timeoutMs",
					"turnId",
				])
			) {
				throw new EmpatraHostProtocolError("execution_request_invalid", "process.exec contains unknown fields");
			}
			if (!Array.isArray(value.args) || value.args.length > EMPATRA_HOST_MAX_EXECUTION_ARGUMENTS) {
				throw new EmpatraHostProtocolError("execution_request_invalid", "args is invalid");
			}
			return {
				...base,
				args: value.args.map((arg, index) =>
					boundedString(arg, `args[${index}]`, EMPATRA_HOST_MAX_EXECUTION_ARGUMENT_BYTES),
				),
				command: boundedString(value.command, "command", EMPATRA_HOST_MAX_EXECUTION_COMMAND_BYTES),
				maxOutputBytes: boundedInteger(
					value.maxOutputBytes,
					"maxOutputBytes",
					1,
					EMPATRA_HOST_MAX_EXECUTION_OUTPUT_BYTES,
				),
				operation: "process.exec",
				timeoutMs: boundedInteger(value.timeoutMs, "timeoutMs", 1, EMPATRA_HOST_MAX_EXECUTION_TIMEOUT_MS),
			};
		default:
			throw new EmpatraHostProtocolError("execution_request_invalid", "execution operation is not supported");
	}
}

function validateResult(
	result: EmpatraHostExecutionResult,
	operation: EmpatraHostExecutionOperation,
): EmpatraHostExecutionResult {
	if (!isRecord(result) || !hasOnlyKeys(result, ["exitCode", "operation", "output", "outputTruncated"])) {
		throw new EmpatraHostProtocolError("execution_result_invalid", "execution result is invalid");
	}
	if (
		result.operation !== operation ||
		typeof result.output !== "string" ||
		typeof result.outputTruncated !== "boolean"
	) {
		throw new EmpatraHostProtocolError("execution_result_invalid", "execution result identity is invalid");
	}
	if (new TextEncoder().encode(result.output).byteLength > EMPATRA_HOST_MAX_EXECUTION_OUTPUT_BYTES) {
		throw new EmpatraHostProtocolError("execution_result_invalid", "execution result exceeds its limit");
	}
	if (result.exitCode !== undefined) boundedInteger(result.exitCode, "exitCode", -255, 255);
	return result;
}

function executionOperation(value: unknown): EmpatraHostExecutionOperation {
	if (typeof value !== "string" || !(EMPATRA_HOST_EXECUTION_OPERATIONS as readonly string[]).includes(value)) {
		throw new EmpatraHostProtocolError("execution_request_invalid", "operation is invalid");
	}
	return value as EmpatraHostExecutionOperation;
}

/** Parse the reserved sidecar request DTO without authorizing execution. */
export function parseEmpatraHostExecutionBrokerRequest(value: unknown): EmpatraHostExecutionBrokerRequest {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["generation", "id", "request", "threadId", "turnId", "type"]) ||
		value.type !== "execution_broker_request"
	) {
		throw new EmpatraHostProtocolError("execution_request_invalid", "execution broker request is invalid");
	}
	return {
		...scope(value),
		id: identifier(value.id, "id"),
		request: parseEmpatraHostExecutionRequest(value.request),
		type: "execution_broker_request",
	};
}

/** Parse a broker request emitted on the normal, ordered host event channel. */
export function parseEmpatraHostExecutionBrokerRequestEvent(value: unknown): EmpatraHostExecutionBrokerRequestEvent {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["event", "generation", "id", "request", "sequence", "threadId", "turnId", "type"]) ||
		value.type !== "host_event" ||
		value.event !== "execution_broker_request"
	) {
		throw new EmpatraHostProtocolError("execution_request_invalid", "execution broker event is invalid");
	}
	const outer = scope(value);
	const sequence = boundedInteger(value.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER);
	const request = parseEmpatraHostExecutionRequest(value.request);
	if (
		request.generation !== outer.generation ||
		request.threadId !== outer.threadId ||
		request.turnId !== outer.turnId
	) {
		throw new EmpatraHostProtocolError(
			"identity_mismatch",
			"execution broker event scope does not match its request",
		);
	}
	return {
		...outer,
		event: "execution_broker_request",
		id: identifier(value.id, "id"),
		request,
		sequence,
		type: "host_event",
	};
}

/** Parse a main-owned response and enforce correlation operation identity. */
export function parseEmpatraHostExecutionBrokerResponse(value: unknown): EmpatraHostExecutionBrokerResponse {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["error", "generation", "id", "operation", "result", "threadId", "turnId", "type"]) ||
		value.type !== "execution_broker_response" ||
		(value.result === undefined) === (value.error === undefined)
	) {
		throw new EmpatraHostProtocolError("execution_result_invalid", "execution broker response is invalid");
	}
	const operation = executionOperation(value.operation);
	if (value.error !== undefined) {
		if (!isRecord(value.error) || !hasOnlyKeys(value.error, ["code", "message"])) {
			throw new EmpatraHostProtocolError("execution_result_invalid", "execution broker error is invalid");
		}
		return {
			...scope(value),
			error: {
				code: identifier(value.error.code, "error.code"),
				message: boundedString(value.error.message, "error.message", 4096),
			},
			id: identifier(value.id, "id"),
			operation,
			type: "execution_broker_response",
		};
	}
	return {
		...scope(value),
		id: identifier(value.id, "id"),
		operation,
		result: validateResult(value.result as EmpatraHostExecutionResult, operation),
		type: "execution_broker_response",
	};
}

/**
 * Create the sidecar half of the main-owned execution broker.
 *
 * The executor is deliberately represented by an ordered host event and a
 * correlated command response.  No process, filesystem, environment, or
 * credential access is performed in this module.  The optional sequence
 * allocator lets the host runtime share its per-turn event ordering; callers
 * that do not have one get a deterministic per-turn sequence for isolated
 * use and tests.
 */
export function createEmpatraHostExecutionBrokerTransport(
	options: Readonly<{
		emitRequest: EmpatraHostExecutionRequestEmitter;
		nextSequence?: (scope: EmpatraHostExecutionScope) => number;
		requestTimeoutMs?: number;
	}>,
): EmpatraHostExecutionBrokerTransport {
	const timeoutMs = options.requestTimeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > EMPATRA_HOST_MAX_EXECUTION_TIMEOUT_MS) {
		throw new RangeError("requestTimeoutMs must be between 1 and the execution timeout limit");
	}
	const pending = new Map<
		string,
		{
			reject: (error: unknown) => void;
			resolve: (result: EmpatraHostExecutionResult) => void;
			scope: EmpatraHostExecutionRequest;
			timeout: ReturnType<typeof setTimeout>;
		}
	>();
	const sequenceByTurn = new Map<string, number>();
	const nextSequence = (scope: EmpatraHostExecutionScope): number => {
		if (options.nextSequence) {
			const sequence = options.nextSequence(scope);
			if (!Number.isSafeInteger(sequence) || sequence < 1) {
				throw new EmpatraHostProtocolError("execution_request_invalid", "execution event sequence is invalid");
			}
			return sequence;
		}
		const key = `${scope.threadId}\u0000${scope.turnId}`;
		const sequence = (sequenceByTurn.get(key) ?? 0) + 1;
		sequenceByTurn.set(key, sequence);
		return sequence;
	};
	const broker: EmpatraHostExecutionBroker = {
		capability: EMPATRA_HOST_EXECUTION_BROKER_CAPABILITY,
		execute: async (input, signal) => {
			const request = parseEmpatraHostExecutionRequest(input);
			if (signal?.aborted) throw new DOMException("Execution broker request aborted", "AbortError");
			const id = randomUUID();
			const event: EmpatraHostExecutionBrokerRequestEvent = {
				event: "execution_broker_request",
				generation: request.generation,
				id,
				request,
				sequence: nextSequence(request),
				threadId: request.threadId,
				turnId: request.turnId,
				type: "host_event",
			};
			return await new Promise<EmpatraHostExecutionResult>((resolve, reject) => {
				const timeout = setTimeout(() => {
					pending.delete(id);
					reject(new EmpatraHostProtocolError("execution_broker_timeout", "Execution broker response timed out"));
				}, timeoutMs);
				const abort = () => {
					if (!pending.delete(id)) return;
					clearTimeout(timeout);
					reject(new DOMException("Execution broker request aborted", "AbortError"));
				};
				pending.set(id, { reject, resolve, scope: request, timeout });
				signal?.addEventListener("abort", abort, { once: true });
				void options.emitRequest(event).catch(error => {
					if (!pending.delete(id)) return;
					clearTimeout(timeout);
					signal?.removeEventListener("abort", abort);
					reject(error);
				});
			}).then(result => {
				// The response handler cannot access the caller's AbortSignal here;
				// cleanup is performed by the response/timeout paths above.
				return result;
			});
		},
	};
	return {
		broker,
		handleResponse(response) {
			const parsed = parseEmpatraHostExecutionBrokerResponse(response);
			const request = pending.get(parsed.id);
			if (!request)
				throw new EmpatraHostProtocolError("execution_result_invalid", "Execution broker response is not pending");
			if (
				request.scope.generation !== parsed.generation ||
				request.scope.threadId !== parsed.threadId ||
				request.scope.turnId !== parsed.turnId ||
				request.scope.operation !== parsed.operation
			) {
				throw new EmpatraHostProtocolError(
					"identity_mismatch",
					"Execution broker response scope does not match its request",
				);
			}
			pending.delete(parsed.id);
			clearTimeout(request.timeout);
			if (parsed.error) request.reject(new EmpatraHostProtocolError(parsed.error.code, parsed.error.message));
			else request.resolve(parsed.result as EmpatraHostExecutionResult);
		},
		dispose() {
			for (const request of pending.values()) {
				clearTimeout(request.timeout);
				request.reject(new EmpatraHostProtocolError("host_disposed", "OMP host is shutting down"));
			}
			pending.clear();
			sequenceByTurn.clear();
		},
	};
}

/**
 * Build a broker around an Electron-main-owned executor. The wrapper validates
 * both sides and never falls back to `child_process`, `Bun.spawn`, or direct
 * filesystem access inside OMP.
 */
export function createEmpatraHostExecutionBroker(executor: EmpatraHostExecutionExecutor): EmpatraHostExecutionBroker {
	return {
		capability: EMPATRA_HOST_EXECUTION_BROKER_CAPABILITY,
		execute: async (request, signal) => {
			const parsed = parseEmpatraHostExecutionRequest(request);
			if (signal?.aborted) throw new DOMException("Execution broker request aborted", "AbortError");
			const result = await executor(parsed, signal);
			return validateResult(result, parsed.operation);
		},
	};
}

/** Explicit default for the current NO-GO state: no native execution path. */
export function createFailClosedEmpatraHostExecutionBroker(): EmpatraHostExecutionBroker {
	return createEmpatraHostExecutionBroker(async () => {
		throw new EmpatraHostProtocolError(
			"execution_broker_unavailable",
			"OMP execution broker is unavailable; native filesystem and process execution are disabled",
		);
	});
}
