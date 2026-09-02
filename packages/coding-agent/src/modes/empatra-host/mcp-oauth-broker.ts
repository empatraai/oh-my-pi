import { randomUUID } from "node:crypto";

import { EmpatraHostProtocolError } from "./errors";
import { EMPATRA_HOST_MCP_OAUTH_CAPABILITY } from "./protocol";

/** Versioned main-owned MCP OAuth contract. */
export const EMPATRA_HOST_MCP_OAUTH_VERSION = 1 as const;
export const EMPATRA_HOST_MCP_OAUTH_MAX_URL_BYTES = 2048;
export const EMPATRA_HOST_MCP_OAUTH_MAX_SCOPES_BYTES = 8192;
export const EMPATRA_HOST_MCP_OAUTH_MAX_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export interface EmpatraHostMcpOAuthScope {
	generation: number;
	threadId: string;
	turnId: string;
}

/**
 * Non-secret OAuth metadata sent from OMP to Electron main.
 *
 * Deliberately absent: authorization code, access/refresh token, client
 * secret, headers, environment, token endpoint and callback URL. Main owns
 * discovery, PKCE/callback handling and credential persistence; OMP only
 * requests that operation for a turn-scoped MCP server identity.
 */
export interface EmpatraHostMcpOAuthRequest extends EmpatraHostMcpOAuthScope {
	capability: typeof EMPATRA_HOST_MCP_OAUTH_CAPABILITY;
	requestSha256: `sha256:${string}`;
	requestId: string;
	resource?: string;
	serverName: string;
	serverUrl: string;
	scopes?: string;
	type: "mcp_oauth_request";
	version: typeof EMPATRA_HOST_MCP_OAUTH_VERSION;
}

/** Host event delivered to Electron main. */
export interface EmpatraHostMcpOAuthRequestedEvent
	extends EmpatraHostMcpOAuthScope {
	event: "mcp_oauth_requested";
	request: EmpatraHostMcpOAuthRequest;
	sequence: number;
	type: "host_event";
}

export type EmpatraHostMcpOAuthStatus = "cancelled" | "completed" | "failed";

/**
 * Main-to-host acknowledgement. It intentionally contains no URL or
 * credential material; the main process may surface the authorization URL
 * directly through its own trusted UI channel.
 */
export interface EmpatraHostMcpOAuthResponseCommand
	extends EmpatraHostMcpOAuthScope {
	capability: typeof EMPATRA_HOST_MCP_OAUTH_CAPABILITY;
	error?: Readonly<{ code: string; message: string }>;
	expectedGeneration: number;
	id: string;
	requestId: string;
	requestSha256: `sha256:${string}`;
	status: EmpatraHostMcpOAuthStatus;
	type: "mcp_oauth_response";
	version: typeof EMPATRA_HOST_MCP_OAUTH_VERSION;
}

export interface EmpatraHostMcpOAuthStartInput
	extends EmpatraHostMcpOAuthScope {
	requestId?: string;
	resource?: string;
	serverName: string;
	serverUrl: string;
	scopes?: string;
}

export interface EmpatraHostMcpOAuthResult {
	status: EmpatraHostMcpOAuthStatus;
}

export type EmpatraHostMcpOAuthRequestEmitter = (
	event: EmpatraHostMcpOAuthRequestedEvent,
) => Promise<void>;

export type EmpatraHostMcpOAuthExecutor = (
	request: EmpatraHostMcpOAuthRequest,
	signal?: AbortSignal,
) => Promise<EmpatraHostMcpOAuthResult>;

export interface EmpatraHostMcpOAuthBroker {
	readonly capability: typeof EMPATRA_HOST_MCP_OAUTH_CAPABILITY;
	execute(
		input: EmpatraHostMcpOAuthStartInput,
		signal?: AbortSignal,
	): Promise<EmpatraHostMcpOAuthResult>;
}

export interface EmpatraHostMcpOAuthBrokerTransport {
	readonly broker: EmpatraHostMcpOAuthBroker;
	handleResponse(response: EmpatraHostMcpOAuthResponseCommand): void;
	dispose(): void;
}

const UTF8 = new TextEncoder();
const CONTROL_CHARACTER = /\p{Cc}/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(
	value: unknown,
	field: string,
	maxBytes: number,
): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		UTF8.encode(value).byteLength > maxBytes ||
		CONTROL_CHARACTER.test(value)
	) {
		throw new EmpatraHostProtocolError(
			"mcp_oauth_request_invalid",
			`${field} is invalid`,
		);
	}
	return value;
}

function boundedIdentity(value: unknown, field: string): string {
	return boundedString(value, field, 256);
}

function boundedInteger(
	value: unknown,
	field: string,
	min: number,
	max: number,
): number {
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < min ||
		(value as number) > max
	) {
		throw new EmpatraHostProtocolError(
			"mcp_oauth_request_invalid",
			`${field} is invalid`,
		);
	}
	return value as number;
}

function scope(value: Record<string, unknown>): EmpatraHostMcpOAuthScope {
	return {
		generation: boundedInteger(
			value.generation,
			"generation",
			1,
			Number.MAX_SAFE_INTEGER,
		),
		threadId: boundedIdentity(value.threadId, "threadId"),
		turnId: boundedIdentity(value.turnId, "turnId"),
	};
}

function url(value: unknown, field: string): string {
	const raw = boundedString(value, field, EMPATRA_HOST_MCP_OAUTH_MAX_URL_BYTES);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new EmpatraHostProtocolError(
			"mcp_oauth_request_invalid",
			`${field} is invalid`,
		);
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.hash !== ""
	) {
		throw new EmpatraHostProtocolError(
			"mcp_oauth_request_invalid",
			`${field} must be credential-free HTTP(S)`,
		);
	}
	return parsed.toString();
}

function optionalUrl(value: unknown, field: string): string | undefined {
	return value === undefined ? undefined : url(value, field);
}

function optionalScopes(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return boundedString(
		value,
		"scopes",
		EMPATRA_HOST_MCP_OAUTH_MAX_SCOPES_BYTES,
	);
}

function digestInput(
	request: Omit<EmpatraHostMcpOAuthRequest, "requestSha256">,
): string {
	return JSON.stringify([
		request.capability,
		request.version,
		request.requestId,
		request.generation,
		request.threadId,
		request.turnId,
		request.serverName,
		request.serverUrl,
		request.scopes ?? "",
		request.resource ?? "",
	]);
}

export function digestEmpatraHostMcpOAuthRequest(
	request: Omit<EmpatraHostMcpOAuthRequest, "requestSha256">,
): `sha256:${string}` {
	return `sha256:${Bun.SHA256.hash(digestInput(request), "hex")}`;
}

function parseDigest(value: unknown): `sha256:${string}` {
	if (typeof value !== "string" || !DIGEST.test(value)) {
		throw new EmpatraHostProtocolError(
			"mcp_oauth_request_invalid",
			"requestSha256 is invalid",
		);
	}
	return value as `sha256:${string}`;
}

function parseStatus(value: unknown): EmpatraHostMcpOAuthStatus {
	if (value === "cancelled" || value === "completed" || value === "failed")
		return value;
	throw new EmpatraHostProtocolError(
		"mcp_oauth_response_invalid",
		"status is invalid",
	);
}

function parseError(
	value: unknown,
): Readonly<{ code: string; message: string }> {
	if (!isRecord(value) || !hasOnlyKeys(value, ["code", "message"])) {
		throw new EmpatraHostProtocolError(
			"mcp_oauth_response_invalid",
			"error is invalid",
		);
	}
	return {
		code: boundedIdentity(value.code, "error.code"),
		message: boundedString(value.message, "error.message", 4096),
	};
}

/** Parse a sidecar OAuth request before any main-owned auth operation. */
export function parseEmpatraHostMcpOAuthRequest(
	value: unknown,
): EmpatraHostMcpOAuthRequest {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"capability",
			"generation",
			"requestId",
			"requestSha256",
			"resource",
			"serverName",
			"serverUrl",
			"scopes",
			"threadId",
			"turnId",
			"type",
			"version",
		]) ||
		value.type !== "mcp_oauth_request" ||
		value.version !== EMPATRA_HOST_MCP_OAUTH_VERSION ||
		value.capability !== EMPATRA_HOST_MCP_OAUTH_CAPABILITY
	) {
		throw new EmpatraHostProtocolError(
			"mcp_oauth_request_invalid",
			"MCP OAuth request is invalid",
		);
	}
	const outer = scope(value);
	const resource = optionalUrl(value.resource, "resource");
	const scopes = optionalScopes(value.scopes);
	const request: Omit<EmpatraHostMcpOAuthRequest, "requestSha256"> = {
		...outer,
		capability: EMPATRA_HOST_MCP_OAUTH_CAPABILITY,
		requestId: boundedIdentity(value.requestId, "requestId"),
		...(resource === undefined ? {} : { resource }),
		serverName: boundedIdentity(value.serverName, "serverName"),
		serverUrl: url(value.serverUrl, "serverUrl"),
		...(scopes === undefined ? {} : { scopes }),
		type: "mcp_oauth_request",
		version: EMPATRA_HOST_MCP_OAUTH_VERSION,
	};
	const requestSha256 = parseDigest(value.requestSha256);
	if (requestSha256 !== digestEmpatraHostMcpOAuthRequest(request)) {
		throw new EmpatraHostProtocolError(
			"identity_mismatch",
			"MCP OAuth request digest does not match its content",
		);
	}
	return { ...request, requestSha256 };
}

/** Parse the ordered host event and enforce nested request identity. */
export function parseEmpatraHostMcpOAuthRequestedEvent(
	value: unknown,
): EmpatraHostMcpOAuthRequestedEvent {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"event",
			"generation",
			"request",
			"sequence",
			"threadId",
			"turnId",
			"type",
		]) ||
		value.type !== "host_event" ||
		value.event !== "mcp_oauth_requested"
	) {
		throw new EmpatraHostProtocolError(
			"mcp_oauth_request_invalid",
			"MCP OAuth event is invalid",
		);
	}
	const outer = scope(value);
	const sequence = boundedInteger(
		value.sequence,
		"sequence",
		1,
		Number.MAX_SAFE_INTEGER,
	);
	const request = parseEmpatraHostMcpOAuthRequest(value.request);
	if (
		request.generation !== outer.generation ||
		request.threadId !== outer.threadId ||
		request.turnId !== outer.turnId
	) {
		throw new EmpatraHostProtocolError(
			"identity_mismatch",
			"MCP OAuth event scope does not match its request",
		);
	}
	return {
		...outer,
		event: "mcp_oauth_requested",
		request,
		sequence,
		type: "host_event",
	};
}

/** Parse main's status acknowledgement; no secret-bearing fields are accepted. */
export function parseEmpatraHostMcpOAuthResponseCommand(
	value: unknown,
): EmpatraHostMcpOAuthResponseCommand {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"capability",
			"error",
			"expectedGeneration",
			"generation",
			"id",
			"requestId",
			"requestSha256",
			"status",
			"threadId",
			"turnId",
			"type",
			"version",
		]) ||
		value.type !== "mcp_oauth_response" ||
		value.version !== EMPATRA_HOST_MCP_OAUTH_VERSION ||
		value.capability !== EMPATRA_HOST_MCP_OAUTH_CAPABILITY ||
		(value.status === "completed" && value.error !== undefined) ||
		(value.status === "failed" && value.error === undefined)
	) {
		throw new EmpatraHostProtocolError(
			"mcp_oauth_response_invalid",
			"MCP OAuth response is invalid",
		);
	}
	const status = parseStatus(value.status);
	const error = value.error === undefined ? undefined : parseError(value.error);
	return {
		...scope(value),
		capability: EMPATRA_HOST_MCP_OAUTH_CAPABILITY,
		...(error === undefined ? {} : { error }),
		expectedGeneration: boundedInteger(
			value.expectedGeneration,
			"expectedGeneration",
			1,
			Number.MAX_SAFE_INTEGER,
		),
		id: boundedIdentity(value.id, "id"),
		requestId: boundedIdentity(value.requestId, "requestId"),
		requestSha256: parseDigest(value.requestSha256),
		status,
		type: "mcp_oauth_response",
		version: EMPATRA_HOST_MCP_OAUTH_VERSION,
	};
}

export function assertEmpatraHostMcpOAuthCapability(
	capabilities: readonly string[],
): void {
	if (!capabilities.includes(EMPATRA_HOST_MCP_OAUTH_CAPABILITY)) {
		throw new EmpatraHostProtocolError(
			"mcp_oauth_unavailable",
			"OMP MCP OAuth capability was not negotiated by the main host",
		);
	}
}

function requestFromInput(
	input: EmpatraHostMcpOAuthStartInput,
): EmpatraHostMcpOAuthRequest {
	const requestWithoutDigest: Omit<
		EmpatraHostMcpOAuthRequest,
		"requestSha256"
	> = {
		capability: EMPATRA_HOST_MCP_OAUTH_CAPABILITY,
		generation: boundedInteger(
			input.generation,
			"generation",
			1,
			Number.MAX_SAFE_INTEGER,
		),
		requestId: boundedIdentity(input.requestId ?? randomUUID(), "requestId"),
		...(input.resource === undefined
			? {}
			: { resource: url(input.resource, "resource") }),
		serverName: boundedIdentity(input.serverName, "serverName"),
		serverUrl: url(input.serverUrl, "serverUrl"),
		...(input.scopes === undefined
			? {}
			: {
					scopes: boundedString(
						input.scopes,
						"scopes",
						EMPATRA_HOST_MCP_OAUTH_MAX_SCOPES_BYTES,
					),
				}),
		threadId: boundedIdentity(input.threadId, "threadId"),
		turnId: boundedIdentity(input.turnId, "turnId"),
		type: "mcp_oauth_request",
		version: EMPATRA_HOST_MCP_OAUTH_VERSION,
	};
	return {
		...requestWithoutDigest,
		requestSha256: digestEmpatraHostMcpOAuthRequest(requestWithoutDigest),
	};
}

function validateResult(
	result: EmpatraHostMcpOAuthResult,
): EmpatraHostMcpOAuthResult {
	if (!isRecord(result) || !hasOnlyKeys(result, ["status"])) {
		throw new EmpatraHostProtocolError(
			"mcp_oauth_response_invalid",
			"MCP OAuth result is invalid",
		);
	}
	return { status: parseStatus(result.status) };
}

/**
 * Create the OMP-side broker. It only emits bounded metadata and accepts a
 * status response. Main-owned OAuth implementations must keep all grant
 * material in their own process/keychain.
 */
export function createEmpatraHostMcpOAuthBrokerTransport(
	options: Readonly<{
		capabilities?: readonly string[];
		emitRequest: EmpatraHostMcpOAuthRequestEmitter;
		nextSequence?: (scope: EmpatraHostMcpOAuthScope) => number;
		requestTimeoutMs?: number;
	}>,
): EmpatraHostMcpOAuthBrokerTransport {
	assertEmpatraHostMcpOAuthCapability(options.capabilities ?? []);
	const timeoutMs = options.requestTimeoutMs ?? 5 * 60 * 1000;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > EMPATRA_HOST_MCP_OAUTH_MAX_REQUEST_TIMEOUT_MS
	) {
		throw new RangeError(
			"requestTimeoutMs must be between 1 and the OAuth timeout limit",
		);
	}
	const pending = new Map<
		string,
		{
			abortCleanup: () => void;
			reject: (error: unknown) => void;
			resolve: (result: EmpatraHostMcpOAuthResult) => void;
			scope: EmpatraHostMcpOAuthRequest;
			timeout: NodeJS.Timeout;
		}
	>();
	const sequenceByTurn = new Map<string, number>();
	const nextSequence = (request: EmpatraHostMcpOAuthRequest): number => {
		const sequence =
			options.nextSequence?.(request) ??
			(sequenceByTurn.get(`${request.threadId}\u0000${request.turnId}`) ?? 0) +
				1;
		if (!Number.isSafeInteger(sequence) || sequence < 1) {
			throw new EmpatraHostProtocolError(
				"mcp_oauth_request_invalid",
				"OAuth event sequence is invalid",
			);
		}
		sequenceByTurn.set(`${request.threadId}\u0000${request.turnId}`, sequence);
		return sequence;
	};
	const broker: EmpatraHostMcpOAuthBroker = {
		capability: EMPATRA_HOST_MCP_OAUTH_CAPABILITY,
		execute: async (input, signal) => {
			const request = requestFromInput(input);
			if (signal?.aborted)
				throw new DOMException("MCP OAuth request aborted", "AbortError");
			const event: EmpatraHostMcpOAuthRequestedEvent = {
				event: "mcp_oauth_requested",
				generation: request.generation,
				request,
				sequence: nextSequence(request),
				threadId: request.threadId,
				turnId: request.turnId,
				type: "host_event",
			};
			if (pending.has(request.requestId)) {
				throw new EmpatraHostProtocolError(
					"mcp_oauth_duplicate",
					"MCP OAuth request id is already pending",
				);
			}
			const deferred = Promise.withResolvers<EmpatraHostMcpOAuthResult>();
			let abortCleanup = () => {};
			const timeout = setTimeout(() => {
				if (!pending.delete(request.requestId)) return;
				abortCleanup();
				deferred.reject(
					new EmpatraHostProtocolError(
						"mcp_oauth_timeout",
						"MCP OAuth response timed out",
					),
				);
			}, timeoutMs);
			const abort = () => {
				if (!pending.delete(request.requestId)) return;
				clearTimeout(timeout);
				deferred.reject(
					new DOMException("MCP OAuth request aborted", "AbortError"),
				);
			};
			abortCleanup = () => signal?.removeEventListener("abort", abort);
			pending.set(request.requestId, {
				abortCleanup,
				reject: deferred.reject,
				resolve: deferred.resolve,
				scope: request,
				timeout,
			});
			signal?.addEventListener("abort", abort, { once: true });
			void options.emitRequest(event).catch((error) => {
				if (!pending.delete(request.requestId)) return;
				clearTimeout(timeout);
				deferred.reject(error);
			});
			return await deferred.promise.then((result) => validateResult(result));
		},
	};
	return {
		broker,
		handleResponse(response) {
			const parsed = parseEmpatraHostMcpOAuthResponseCommand(response);
			const request = pending.get(parsed.requestId);
			if (!request)
				throw new EmpatraHostProtocolError(
					"mcp_oauth_response_invalid",
					"MCP OAuth response is not pending",
				);
			if (
				request.scope.generation !== parsed.generation ||
				request.scope.generation !== parsed.expectedGeneration ||
				request.scope.threadId !== parsed.threadId ||
				request.scope.turnId !== parsed.turnId ||
				request.scope.requestSha256 !== parsed.requestSha256
			) {
				throw new EmpatraHostProtocolError(
					"identity_mismatch",
					"MCP OAuth response does not match its request",
				);
			}
			pending.delete(parsed.requestId);
			clearTimeout(request.timeout);
			request.abortCleanup();
			if (parsed.status === "failed") {
				request.reject(
					new EmpatraHostProtocolError(
						parsed.error?.code ?? "mcp_oauth_failed",
						parsed.error?.message ?? "MCP OAuth failed",
					),
				);
			} else request.resolve({ status: parsed.status });
		},
		dispose() {
			for (const request of pending.values()) {
				clearTimeout(request.timeout);
				request.abortCleanup();
				request.reject(
					new EmpatraHostProtocolError(
						"host_disposed",
						"OMP host is shutting down",
					),
				);
			}
			pending.clear();
			sequenceByTurn.clear();
		},
	};
}

export function createEmpatraHostMcpOAuthBroker(
	executor: EmpatraHostMcpOAuthExecutor,
): EmpatraHostMcpOAuthBroker {
	return {
		capability: EMPATRA_HOST_MCP_OAUTH_CAPABILITY,
		execute: async (input, signal) => {
			const request = requestFromInput(input);
			if (signal?.aborted)
				throw new DOMException("MCP OAuth request aborted", "AbortError");
			return validateResult(await executor(request, signal));
		},
	};
}

export function createFailClosedEmpatraHostMcpOAuthBroker(): EmpatraHostMcpOAuthBroker {
	return createEmpatraHostMcpOAuthBroker(async () => {
		throw new EmpatraHostProtocolError(
			"mcp_oauth_unavailable",
			"OMP MCP OAuth is unavailable; Electron main must own the callback and credential store",
		);
	});
}
