import { randomUUID } from "node:crypto";

import { EmpatraHostProtocolError } from "./errors";
import { EMPATRA_HOST_RESOURCES_CAPABILITY } from "./protocol";

/** Versioned main-owned resource catalog contract. */
export const EMPATRA_HOST_RESOURCES_VERSION = 1 as const;
/** Launch opt-in for the stdio bridge; unset hosts never emit resource events. */
export const EMPATRA_HOST_RESOURCES_RPC_OPT_IN_ENV = "EMPATRA_OMP_RESOURCES_RPC" as const;
export const EMPATRA_HOST_RESOURCES_RPC_OPT_IN_VALUE = "v1" as const;
export const EMPATRA_HOST_RESOURCES_MAX_URI_BYTES = 4096;
export const EMPATRA_HOST_RESOURCES_MAX_NAME_BYTES = 512;
export const EMPATRA_HOST_RESOURCES_MAX_DESCRIPTION_BYTES = 8192;
export const EMPATRA_HOST_RESOURCES_MAX_CURSOR_BYTES = 1024;
export const EMPATRA_HOST_RESOURCES_MAX_ITEMS = 256;
export const EMPATRA_HOST_RESOURCES_MAX_CONTENT_ITEMS = 64;
export const EMPATRA_HOST_RESOURCES_MAX_CONTENT_BYTES = 4 * 1024 * 1024;
export const EMPATRA_HOST_RESOURCES_MAX_TOTAL_CONTENT_BYTES = 16 * 1024 * 1024;
export const EMPATRA_HOST_RESOURCES_MAX_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export type EmpatraHostResourcesMethod =
	| "resources/list"
	| "resources/templates/list"
	| "resources/read";
export type EmpatraHostResourcesStatus = "completed" | "failed";
export type EmpatraHostResourceDigest = `sha256:${string}`;

export interface EmpatraHostResourcesScope {
	generation: number;
	threadId: string;
	turnId: string;
}

/** Metadata is deliberately config-free: no server URL, headers, auth, or filesystem path. */
export interface EmpatraHostResourceDescriptor {
	description?: string;
	mimeType?: string;
	name: string;
	size?: number;
	title?: string;
	uri: string;
}

export interface EmpatraHostResourceTemplateDescriptor {
	description?: string;
	mimeType?: string;
	name: string;
	title?: string;
	uriTemplate: string;
}

export type EmpatraHostResourceContent = Readonly<{
	blob?: string;
	mimeType?: string;
	text?: string;
	uri: string;
}>;

export interface EmpatraHostResourcesListResult {
	catalogDigest: EmpatraHostResourceDigest;
	nextCursor?: string;
	resources: readonly EmpatraHostResourceDescriptor[];
}

export interface EmpatraHostResourceTemplatesListResult {
	catalogDigest: EmpatraHostResourceDigest;
	nextCursor?: string;
	resourceTemplates: readonly EmpatraHostResourceTemplateDescriptor[];
}

export interface EmpatraHostResourceReadResult {
	catalogDigest: EmpatraHostResourceDigest;
	contents: readonly EmpatraHostResourceContent[];
}

export type EmpatraHostResourcesResult =
	| EmpatraHostResourcesListResult
	| EmpatraHostResourceTemplatesListResult
	| EmpatraHostResourceReadResult;

interface EmpatraHostResourcesRequestBase extends EmpatraHostResourcesScope {
	capability: typeof EMPATRA_HOST_RESOURCES_CAPABILITY;
	method: EmpatraHostResourcesMethod;
	requestId: string;
	type: "resources_request";
	version: typeof EMPATRA_HOST_RESOURCES_VERSION;
}

export interface EmpatraHostResourcesListRequest extends EmpatraHostResourcesRequestBase {
	catalogDigest?: EmpatraHostResourceDigest;
	method: "resources/list";
	cursor?: string;
}

export interface EmpatraHostResourceTemplatesListRequest extends EmpatraHostResourcesRequestBase {
	catalogDigest?: EmpatraHostResourceDigest;
	method: "resources/templates/list";
	cursor?: string;
}

export interface EmpatraHostResourceReadRequest extends EmpatraHostResourcesRequestBase {
	catalogDigest: EmpatraHostResourceDigest;
	method: "resources/read";
	uri: string;
}

export type EmpatraHostResourcesRequest =
	| EmpatraHostResourcesListRequest
	| EmpatraHostResourceTemplatesListRequest
	| EmpatraHostResourceReadRequest;

export interface EmpatraHostResourcesRequestedEvent extends EmpatraHostResourcesScope {
	event: "resources_requested";
	request: EmpatraHostResourcesRequest;
	sequence: number;
	type: "host_event";
}

export interface EmpatraHostResourcesResponseCommand extends EmpatraHostResourcesScope {
	capability: typeof EMPATRA_HOST_RESOURCES_CAPABILITY;
	error?: Readonly<{ code: string; message: string }>;
	expectedGeneration: number;
	id: string;
	method: EmpatraHostResourcesMethod;
	requestId: string;
	requestSha256: EmpatraHostResourceDigest;
	result?: EmpatraHostResourcesResult;
	status: EmpatraHostResourcesStatus;
	type: "resources_response";
	version: typeof EMPATRA_HOST_RESOURCES_VERSION;
}

export type EmpatraHostResourcesRequestEmitter = (
	event: EmpatraHostResourcesRequestedEvent,
) => Promise<void>;
export type EmpatraHostResourcesExecutor = (
	request: EmpatraHostResourcesRequest,
	signal?: AbortSignal,
) => Promise<EmpatraHostResourcesResult>;

export interface EmpatraHostResourcesBroker {
	readonly capability: typeof EMPATRA_HOST_RESOURCES_CAPABILITY;
	list(
		input: EmpatraHostResourcesScope & { catalogDigest?: EmpatraHostResourceDigest; cursor?: string },
		signal?: AbortSignal,
	): Promise<EmpatraHostResourcesListResult>;
	listTemplates(
		input: EmpatraHostResourcesScope & { catalogDigest?: EmpatraHostResourceDigest; cursor?: string },
		signal?: AbortSignal,
	): Promise<EmpatraHostResourceTemplatesListResult>;
	read(
		input: EmpatraHostResourcesScope & { catalogDigest: EmpatraHostResourceDigest; uri: string },
		signal?: AbortSignal,
	): Promise<EmpatraHostResourceReadResult>;
}

export interface EmpatraHostResourcesBrokerTransport {
	readonly broker: EmpatraHostResourcesBroker;
	handleResponse(response: EmpatraHostResourcesResponseCommand): void;
	dispose(): void;
}

const UTF8 = new TextEncoder();
const CONTROL_CHARACTER = /\p{Cc}/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every(key => allowed.has(key));
}

function boundedString(value: unknown, field: string, maxBytes: number, minLength = 1): string {
	if (
		typeof value !== "string" ||
		value.length < minLength ||
		UTF8.encode(value).byteLength > maxBytes ||
		CONTROL_CHARACTER.test(value)
	) {
		throw new EmpatraHostProtocolError("resources_request_invalid", `${field} is invalid`);
	}
	return value;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
		throw new EmpatraHostProtocolError("resources_request_invalid", `${field} is invalid`);
	}
	return value as number;
}

function identity(value: unknown, field: string): string {
	return boundedString(value, field, 256);
}

function parseDigest(value: unknown, field: string): EmpatraHostResourceDigest {
	if (typeof value !== "string" || !DIGEST.test(value)) {
		throw new EmpatraHostProtocolError("resources_request_invalid", `${field} is invalid`);
	}
	return value as EmpatraHostResourceDigest;
}

/** Resource URIs are opaque identifiers at this boundary. Credentials, query strings and fragments are forbidden. */
function resourceUri(value: unknown, field: string): string {
	const uri = boundedString(value, field, EMPATRA_HOST_RESOURCES_MAX_URI_BYTES);
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		throw new EmpatraHostProtocolError("resources_request_invalid", `${field} is invalid`);
	}
	if (
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.protocol === "file:" ||
		parsed.protocol === "data:" ||
		parsed.protocol === "javascript:"
	) {
		throw new EmpatraHostProtocolError("resources_request_invalid", `${field} must be a credential-free opaque URI`);
	}
	return uri;
}

function optionalText(value: unknown, field: string, maxBytes: number): string | undefined {
	if (value === undefined) return undefined;
	return boundedString(value, field, maxBytes, 0);
}

function scope(value: Record<string, unknown>): EmpatraHostResourcesScope {
	return {
		generation: boundedInteger(value.generation, "generation", 1, Number.MAX_SAFE_INTEGER),
		threadId: identity(value.threadId, "threadId"),
		turnId: identity(value.turnId, "turnId"),
	};
}

function digestInput(request: EmpatraHostResourcesRequest): string {
	return JSON.stringify([
		request.capability,
		request.version,
		request.method,
		request.requestId,
		request.generation,
		request.threadId,
		request.turnId,
		"cursor" in request ? request.cursor ?? "" : "",
		"catalogDigest" in request ? request.catalogDigest : "",
		"uri" in request ? request.uri : "",
	]);
}

export function digestEmpatraHostResourcesRequest(
	request: EmpatraHostResourcesRequest,
): EmpatraHostResourceDigest {
	return `sha256:${Bun.SHA256.hash(digestInput(request), "hex")}`;
}

function parseRequestBase(value: Record<string, unknown>): EmpatraHostResourcesScope {
	if (
		value.type !== "resources_request" ||
		value.version !== EMPATRA_HOST_RESOURCES_VERSION ||
		value.capability !== EMPATRA_HOST_RESOURCES_CAPABILITY
	) {
		throw new EmpatraHostProtocolError("resources_request_invalid", "resources request is invalid");
	}
	return scope(value);
}

export function parseEmpatraHostResourcesRequest(value: unknown): EmpatraHostResourcesRequest {
	if (!isRecord(value) || !hasOnlyKeys(value, [
		"capability", "catalogDigest", "cursor", "generation", "method", "requestId", "threadId", "turnId", "type", "uri", "version",
	])) {
		throw new EmpatraHostProtocolError("resources_request_invalid", "resources request is invalid");
	}
	const base = parseRequestBase(value);
	const requestId = identity(value.requestId, "requestId");
	if (value.method === "resources/list" || value.method === "resources/templates/list") {
		const catalogDigest = value.catalogDigest === undefined ? undefined : parseDigest(value.catalogDigest, "catalogDigest");
		if (value.uri !== undefined) throw new EmpatraHostProtocolError("resources_request_invalid", "resource list request contains unknown fields");
		const cursor = value.cursor === undefined ? undefined : boundedString(value.cursor, "cursor", EMPATRA_HOST_RESOURCES_MAX_CURSOR_BYTES);
		return {
			...base,
			capability: EMPATRA_HOST_RESOURCES_CAPABILITY,
			...(catalogDigest === undefined ? {} : { catalogDigest }),
			...(cursor === undefined ? {} : { cursor }),
			method: value.method,
			requestId,
			type: "resources_request",
			version: EMPATRA_HOST_RESOURCES_VERSION,
		} as EmpatraHostResourcesRequest;
	}
	if (value.method !== "resources/read" || value.cursor !== undefined) {
		throw new EmpatraHostProtocolError("resources_request_invalid", "resource method is invalid");
	}
	return {
		...base,
		capability: EMPATRA_HOST_RESOURCES_CAPABILITY,
		catalogDigest: parseDigest(value.catalogDigest, "catalogDigest"),
		method: "resources/read",
		requestId,
		type: "resources_request",
		uri: resourceUri(value.uri, "uri"),
		version: EMPATRA_HOST_RESOURCES_VERSION,
	};
}

export function parseEmpatraHostResourcesRequestedEvent(value: unknown): EmpatraHostResourcesRequestedEvent {
	if (!isRecord(value) || !hasOnlyKeys(value, ["event", "generation", "request", "sequence", "threadId", "turnId", "type"]) || value.type !== "host_event" || value.event !== "resources_requested") {
		throw new EmpatraHostProtocolError("resources_request_invalid", "resources event is invalid");
	}
	const outer = scope(value);
	const request = parseEmpatraHostResourcesRequest(value.request);
	const sequence = boundedInteger(value.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER);
	if (outer.generation !== request.generation || outer.threadId !== request.threadId || outer.turnId !== request.turnId) {
		throw new EmpatraHostProtocolError("identity_mismatch", "resources event scope does not match its request");
	}
	return { ...outer, event: "resources_requested", request, sequence, type: "host_event" };
}

function parseResourceDescriptor(value: unknown, index: number): EmpatraHostResourceDescriptor {
	if (!isRecord(value) || !hasOnlyKeys(value, ["description", "mimeType", "name", "size", "title", "uri"])) {
		throw new EmpatraHostProtocolError("resources_response_invalid", `resources[${index}] is invalid`);
	}
	const size = value.size === undefined ? undefined : boundedInteger(value.size, `resources[${index}].size`, 0, EMPATRA_HOST_RESOURCES_MAX_CONTENT_BYTES);
	const description = optionalText(value.description, `resources[${index}].description`, EMPATRA_HOST_RESOURCES_MAX_DESCRIPTION_BYTES);
	const mimeType = optionalText(value.mimeType, `resources[${index}].mimeType`, 256);
	const title = optionalText(value.title, `resources[${index}].title`, EMPATRA_HOST_RESOURCES_MAX_NAME_BYTES);
	return {
		...(description === undefined ? {} : { description }),
		...(mimeType === undefined ? {} : { mimeType }),
		name: boundedString(value.name, `resources[${index}].name`, EMPATRA_HOST_RESOURCES_MAX_NAME_BYTES),
		...(size === undefined ? {} : { size }),
		...(title === undefined ? {} : { title }),
		uri: resourceUri(value.uri, `resources[${index}].uri`),
	};
}

function parseTemplateDescriptor(value: unknown, index: number): EmpatraHostResourceTemplateDescriptor {
	if (!isRecord(value) || !hasOnlyKeys(value, ["description", "mimeType", "name", "title", "uriTemplate"])) {
		throw new EmpatraHostProtocolError("resources_response_invalid", `resourceTemplates[${index}] is invalid`);
	}
	const description = optionalText(value.description, `resourceTemplates[${index}].description`, EMPATRA_HOST_RESOURCES_MAX_DESCRIPTION_BYTES);
	const mimeType = optionalText(value.mimeType, `resourceTemplates[${index}].mimeType`, 256);
	const title = optionalText(value.title, `resourceTemplates[${index}].title`, EMPATRA_HOST_RESOURCES_MAX_NAME_BYTES);
	return {
		...(description === undefined ? {} : { description }),
		...(mimeType === undefined ? {} : { mimeType }),
		name: boundedString(value.name, `resourceTemplates[${index}].name`, EMPATRA_HOST_RESOURCES_MAX_NAME_BYTES),
		...(title === undefined ? {} : { title }),
		uriTemplate: resourceUri(value.uriTemplate, `resourceTemplates[${index}].uriTemplate`),
	};
}

function parseContent(value: unknown, index: number): EmpatraHostResourceContent {
	if (!isRecord(value) || !hasOnlyKeys(value, ["blob", "mimeType", "text", "uri"])) {
		throw new EmpatraHostProtocolError("resources_response_invalid", `contents[${index}] is invalid`);
	}
	const text = value.text === undefined ? undefined : boundedString(value.text, `contents[${index}].text`, EMPATRA_HOST_RESOURCES_MAX_CONTENT_BYTES, 0);
	const blob = value.blob === undefined ? undefined : boundedString(value.blob, `contents[${index}].blob`, EMPATRA_HOST_RESOURCES_MAX_CONTENT_BYTES, 0);
	if ((text === undefined) === (blob === undefined)) throw new EmpatraHostProtocolError("resources_response_invalid", `contents[${index}] must contain exactly one payload`);
	if (text !== undefined && blob !== undefined) throw new EmpatraHostProtocolError("resources_response_invalid", `contents[${index}] has multiple payloads`);
	const mimeType = optionalText(value.mimeType, `contents[${index}].mimeType`, 256);
	return {
		...(blob === undefined ? {} : { blob }),
		...(mimeType === undefined ? {} : { mimeType }),
		...(text === undefined ? {} : { text }),
		uri: resourceUri(value.uri, `contents[${index}].uri`),
	};
}

function parseResult(value: unknown, method: EmpatraHostResourcesMethod): EmpatraHostResourcesResult {
	if (!isRecord(value) || !hasOnlyKeys(value, ["catalogDigest", "contents", "nextCursor", "resourceTemplates", "resources"])) {
		throw new EmpatraHostProtocolError("resources_response_invalid", "resources result is invalid");
	}
	const catalogDigest = parseDigest(value.catalogDigest, "catalogDigest");
	const nextCursor = value.nextCursor === undefined ? undefined : boundedString(value.nextCursor, "nextCursor", EMPATRA_HOST_RESOURCES_MAX_CURSOR_BYTES);
	if (method === "resources/list") {
		if (!Array.isArray(value.resources) || value.resources.length > EMPATRA_HOST_RESOURCES_MAX_ITEMS || value.resourceTemplates !== undefined || value.contents !== undefined) throw new EmpatraHostProtocolError("resources_response_invalid", "resources list result is invalid");
		return { catalogDigest, ...(nextCursor === undefined ? {} : { nextCursor }), resources: value.resources.map(parseResourceDescriptor) };
	}
	if (method === "resources/templates/list") {
		if (!Array.isArray(value.resourceTemplates) || value.resourceTemplates.length > EMPATRA_HOST_RESOURCES_MAX_ITEMS || value.resources !== undefined || value.contents !== undefined) throw new EmpatraHostProtocolError("resources_response_invalid", "resource templates result is invalid");
		return { catalogDigest, ...(nextCursor === undefined ? {} : { nextCursor }), resourceTemplates: value.resourceTemplates.map(parseTemplateDescriptor) };
	}
	if (!Array.isArray(value.contents) || value.contents.length < 1 || value.contents.length > EMPATRA_HOST_RESOURCES_MAX_CONTENT_ITEMS || value.resources !== undefined || value.resourceTemplates !== undefined || value.nextCursor !== undefined) throw new EmpatraHostProtocolError("resources_response_invalid", "resource read result is invalid");
	const contents = value.contents.map(parseContent);
	if (contents.reduce((total, content) => total + UTF8.encode(content.text ?? content.blob ?? "").byteLength, 0) > EMPATRA_HOST_RESOURCES_MAX_TOTAL_CONTENT_BYTES) throw new EmpatraHostProtocolError("resources_response_invalid", "resource contents exceed their aggregate limit");
	return { catalogDigest, contents };
}

export function parseEmpatraHostResourcesResponseCommand(value: unknown): EmpatraHostResourcesResponseCommand {
	if (!isRecord(value) || !hasOnlyKeys(value, ["capability", "error", "expectedGeneration", "generation", "id", "method", "requestId", "requestSha256", "result", "status", "threadId", "turnId", "type", "version"]) || value.type !== "resources_response" || value.version !== EMPATRA_HOST_RESOURCES_VERSION || value.capability !== EMPATRA_HOST_RESOURCES_CAPABILITY) {
		throw new EmpatraHostProtocolError("resources_response_invalid", "resources response is invalid");
	}
	const status = value.status;
	if (status !== "completed" && status !== "failed") throw new EmpatraHostProtocolError("resources_response_invalid", "status is invalid");
	if ((status === "completed" && (value.error !== undefined || value.result === undefined)) || (status === "failed" && (value.error === undefined || value.result !== undefined))) throw new EmpatraHostProtocolError("resources_response_invalid", "resources response status is invalid");
	let error: Readonly<{ code: string; message: string }> | undefined;
	if (value.error !== undefined) {
		if (!isRecord(value.error) || !hasOnlyKeys(value.error, ["code", "message"])) throw new EmpatraHostProtocolError("resources_response_invalid", "error is invalid");
		error = { code: identity(value.error.code, "error.code"), message: boundedString(value.error.message, "error.message", 4096) };
	}
	const method = value.method;
	if (method !== "resources/list" && method !== "resources/templates/list" && method !== "resources/read") throw new EmpatraHostProtocolError("resources_response_invalid", "method is invalid");
	return {
		...scope(value),
		capability: EMPATRA_HOST_RESOURCES_CAPABILITY,
		expectedGeneration: boundedInteger(value.expectedGeneration, "expectedGeneration", 1, Number.MAX_SAFE_INTEGER),
		...(error === undefined ? {} : { error }),
		id: identity(value.id, "id"),
		method,
		requestId: identity(value.requestId, "requestId"),
		requestSha256: parseDigest(value.requestSha256, "requestSha256"),
		...(value.result === undefined ? {} : { result: parseResult(value.result, method) }),
		status,
		type: "resources_response",
		version: EMPATRA_HOST_RESOURCES_VERSION,
	};
}

export function assertEmpatraHostResourcesCapability(capabilities: readonly string[]): void {
	if (!capabilities.includes(EMPATRA_HOST_RESOURCES_CAPABILITY)) throw new EmpatraHostProtocolError("resources_unavailable", "OMP host resources capability was not negotiated");
}

function requestFromInput(input: EmpatraHostResourcesScope & { cursor?: string; catalogDigest?: EmpatraHostResourceDigest; uri?: string; method?: EmpatraHostResourcesMethod; requestId?: string }): EmpatraHostResourcesRequest {
	const method = input.method ?? (input.uri !== undefined ? "resources/read" : "resources/list");
	const base = {
		capability: EMPATRA_HOST_RESOURCES_CAPABILITY,
		generation: boundedInteger(input.generation, "generation", 1, Number.MAX_SAFE_INTEGER),
		requestId: identity(input.requestId ?? randomUUID(), "requestId"),
		threadId: identity(input.threadId, "threadId"),
		turnId: identity(input.turnId, "turnId"),
		type: "resources_request" as const,
		version: EMPATRA_HOST_RESOURCES_VERSION,
	};
	if (method === "resources/read") return { ...base, catalogDigest: parseDigest(input.catalogDigest, "catalogDigest"), method, type: "resources_request", uri: resourceUri(input.uri, "uri") };
	if (method === "resources/templates/list") return { ...base, ...(input.catalogDigest === undefined ? {} : { catalogDigest: parseDigest(input.catalogDigest, "catalogDigest") }), ...(input.cursor === undefined ? {} : { cursor: boundedString(input.cursor, "cursor", EMPATRA_HOST_RESOURCES_MAX_CURSOR_BYTES) }), method, type: "resources_request" };
	return { ...base, ...(input.catalogDigest === undefined ? {} : { catalogDigest: parseDigest(input.catalogDigest, "catalogDigest") }), ...(input.cursor === undefined ? {} : { cursor: boundedString(input.cursor, "cursor", EMPATRA_HOST_RESOURCES_MAX_CURSOR_BYTES) }), method: "resources/list", type: "resources_request" };
}

function validateResult(result: EmpatraHostResourcesResult, method: EmpatraHostResourcesMethod): EmpatraHostResourcesResult {
	return parseResult(result, method);
}

export function createEmpatraHostResourcesBrokerTransport(options: Readonly<{ capabilities?: readonly string[]; emitRequest: EmpatraHostResourcesRequestEmitter; nextSequence?: (scope: EmpatraHostResourcesScope) => number; requestTimeoutMs?: number }>): EmpatraHostResourcesBrokerTransport {
	assertEmpatraHostResourcesCapability(options.capabilities ?? []);
	const timeoutMs = options.requestTimeoutMs ?? EMPATRA_HOST_RESOURCES_MAX_REQUEST_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > EMPATRA_HOST_RESOURCES_MAX_REQUEST_TIMEOUT_MS) throw new RangeError("requestTimeoutMs is invalid");
	type Pending = { abortCleanup: () => void; method: EmpatraHostResourcesMethod; reject: (error: unknown) => void; resolve: (result: EmpatraHostResourcesResult) => void; request: EmpatraHostResourcesRequest; timeout: NodeJS.Timeout };
	const pending = new Map<string, Pending>();
	const sequenceByTurn = new Map<string, number>();
	const nextSequence = (request: EmpatraHostResourcesRequest): number => {
		const sequence = options.nextSequence?.(request) ?? (sequenceByTurn.get(`${request.threadId}\u0000${request.turnId}`) ?? 0) + 1;
		if (!Number.isSafeInteger(sequence) || sequence < 1) throw new EmpatraHostProtocolError("resources_request_invalid", "resource event sequence is invalid");
		sequenceByTurn.set(`${request.threadId}\u0000${request.turnId}`, sequence);
		return sequence;
	};
	const execute = async (input: Parameters<EmpatraHostResourcesBroker["list"]>[0], method: EmpatraHostResourcesMethod, signal?: AbortSignal): Promise<EmpatraHostResourcesResult> => {
		const request = requestFromInput({ ...input, method });
		if (signal?.aborted) throw new DOMException("MCP resource request aborted", "AbortError");
		if (pending.has(request.requestId)) throw new EmpatraHostProtocolError("resources_duplicate", "resource request id is already pending");
		const deferred = Promise.withResolvers<EmpatraHostResourcesResult>();
		let abortCleanup = () => {};
		const timeout = setTimeout(() => {
			if (!pending.delete(request.requestId)) return;
			abortCleanup();
			deferred.reject(new EmpatraHostProtocolError("resources_timeout", "resource response timed out"));
		}, timeoutMs);
		const abort = () => {
			if (!pending.delete(request.requestId)) return;
			clearTimeout(timeout);
			deferred.reject(new DOMException("MCP resource request aborted", "AbortError"));
		};
		abortCleanup = () => signal?.removeEventListener("abort", abort);
		pending.set(request.requestId, { abortCleanup, method, reject: deferred.reject, resolve: deferred.resolve, request, timeout });
		signal?.addEventListener("abort", abort, { once: true });
		const event: EmpatraHostResourcesRequestedEvent = { event: "resources_requested", generation: request.generation, request, sequence: nextSequence(request), threadId: request.threadId, turnId: request.turnId, type: "host_event" };
		void options.emitRequest(event).catch(error => {
			const current = pending.get(request.requestId);
			if (!current) return;
			pending.delete(request.requestId);
			clearTimeout(current.timeout);
			current.reject(error);
		});
		return validateResult(await deferred.promise, method);
	};
	const broker: EmpatraHostResourcesBroker = {
		capability: EMPATRA_HOST_RESOURCES_CAPABILITY,
		list: (input, signal) => execute(input, "resources/list", signal) as Promise<EmpatraHostResourcesListResult>,
		listTemplates: (input, signal) => execute(input, "resources/templates/list", signal) as Promise<EmpatraHostResourceTemplatesListResult>,
		read: (input, signal) => execute(input, "resources/read", signal) as Promise<EmpatraHostResourceReadResult>,
	};
	return {
		broker,
		handleResponse(response) {
			const parsed = parseEmpatraHostResourcesResponseCommand(response);
			const current = pending.get(parsed.requestId);
			if (!current) throw new EmpatraHostProtocolError("resources_response_invalid", "resource response is not pending");
			const requestedCatalogDigest = "catalogDigest" in current.request ? current.request.catalogDigest : undefined;
			const requestedUri = "uri" in current.request ? current.request.uri : undefined;
			const responseCatalogDigest = parsed.status === "completed" ? parsed.result?.catalogDigest : undefined;
			const readUriMismatch =
				current.method === "resources/read" &&
				requestedUri !== undefined &&
				parsed.status === "completed" &&
				parsed.result !== undefined &&
				"contents" in parsed.result &&
				parsed.result.contents.some(content => content.uri !== requestedUri);
			if (
				current.method !== parsed.method ||
				current.request.generation !== parsed.generation ||
				current.request.generation !== parsed.expectedGeneration ||
				current.request.threadId !== parsed.threadId ||
				current.request.turnId !== parsed.turnId ||
				digestEmpatraHostResourcesRequest(current.request) !== parsed.requestSha256 ||
				(requestedCatalogDigest !== undefined && responseCatalogDigest !== requestedCatalogDigest) ||
				readUriMismatch
			) throw new EmpatraHostProtocolError("identity_mismatch", "resource response does not match its request");
			pending.delete(parsed.requestId);
			clearTimeout(current.timeout);
			current.abortCleanup();
			if (parsed.status === "failed") current.reject(new EmpatraHostProtocolError(parsed.error?.code ?? "resources_failed", parsed.error?.message ?? "resource request failed"));
			else current.resolve(parsed.result as EmpatraHostResourcesResult);
		},
		dispose() {
			for (const current of pending.values()) {
				clearTimeout(current.timeout);
				current.abortCleanup();
				current.reject(new EmpatraHostProtocolError("host_disposed", "OMP host is shutting down"));
			}
			pending.clear();
			sequenceByTurn.clear();
		},
	};
}

export function createEmpatraHostResourcesBroker(executor: EmpatraHostResourcesExecutor): EmpatraHostResourcesBroker {
	return {
		capability: EMPATRA_HOST_RESOURCES_CAPABILITY,
		list: async (input, signal) => validateResult(await executor(requestFromInput({ ...input, method: "resources/list" }), signal), "resources/list") as EmpatraHostResourcesListResult,
		listTemplates: async (input, signal) => validateResult(await executor(requestFromInput({ ...input, method: "resources/templates/list" }), signal), "resources/templates/list") as EmpatraHostResourceTemplatesListResult,
		read: async (input, signal) => validateResult(await executor(requestFromInput({ ...input, method: "resources/read" }), signal), "resources/read") as EmpatraHostResourceReadResult,
	};
}
