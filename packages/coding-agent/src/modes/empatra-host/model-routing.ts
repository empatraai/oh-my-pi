import { createHash } from "node:crypto";

import { EmpatraHostProtocolError } from "./errors";

/**
 * Main-mediated model routing for the Empatra host.
 *
 * This contract intentionally contains selectors only. Provider credentials,
 * local OMP configuration, and endpoint metadata never cross the host
 * boundary. Electron main owns persistence and sends a fresh snapshot when
 * it changes; the OMP process keeps only an in-memory copy for session/task
 * resolution.
 */
export const EMPATRA_HOST_MODEL_ROUTING_CAPABILITY = "settings.model-routing.v1" as const;
export const EMPATRA_HOST_MODEL_ROUTING_VERSION = 1 as const;
export const EMPATRA_HOST_MAX_MODEL_ROLES = 64;
export const EMPATRA_HOST_MAX_AGENT_MODEL_OVERRIDES = 256;
export const EMPATRA_HOST_MAX_MODEL_SELECTOR_BYTES = 512;
export const EMPATRA_HOST_MAX_AGENT_MODEL_SELECTOR_LIST = 16;
export const EMPATRA_HOST_MAX_MODEL_ROUTING_BYTES = 64 * 1024;

export type EmpatraHostModelSelector = string | string[];

export interface EmpatraHostModelRoutingSnapshot {
	modelRoles: Record<string, string>;
	revision: string;
	taskAgentModelOverrides: Record<string, EmpatraHostModelSelector>;
	version: typeof EMPATRA_HOST_MODEL_ROUTING_VERSION;
}

export interface EmpatraHostModelRoutingWrite {
	modelRoles: Record<string, string>;
	taskAgentModelOverrides: Record<string, EmpatraHostModelSelector>;
	version: typeof EMPATRA_HOST_MODEL_ROUTING_VERSION;
}

export interface EmpatraHostModelRoutingReadCommand {
	id: string;
	type: "settings_model_routing_read";
}

export interface EmpatraHostModelRoutingWriteCommand extends EmpatraHostModelRoutingWrite {
	expectedRevision: string;
	id: string;
	type: "settings_model_routing_write";
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const MODEL_SELECTOR = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const ROUTING_KEY = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const ROLE_ALIAS = /^@[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const LEGACY_ROLE_ALIAS = /^pi\/[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const EFFORT = /^(none|minimal|low|medium|high|xhigh|max)$/u;
const RESERVED_ROUTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const textEncoder = new TextEncoder();

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every(key => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRoutingKey(value: unknown, field: string): string {
	if (typeof value !== "string" || !ROUTING_KEY.test(value)) {
		throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
	}
	return value;
}

function parseSelector(value: unknown, field: string): EmpatraHostModelSelector {
	if (typeof value === "string") {
		if (
			!MODEL_SELECTOR.test(value) ||
			textEncoder.encode(value).byteLength > EMPATRA_HOST_MAX_MODEL_SELECTOR_BYTES ||
			CONTROL_CHARACTER.test(value) ||
			value.trim() !== value
		) {
			throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
		}
		return value;
	}
	if (!Array.isArray(value) || value.length === 0 || value.length > EMPATRA_HOST_MAX_AGENT_MODEL_SELECTOR_LIST) {
		throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
	}
	const selectors = value.map((selector, index) => parseSelector(selector, `${field}[${index}]`));
	if (selectors.some(selector => typeof selector !== "string")) {
		throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
	}
	if (new Set(selectors).size !== selectors.length) {
		throw new EmpatraHostProtocolError("invalid_request", `${field} must not contain duplicate selectors`);
	}
	return selectors as string[];
}

function parseRecord(
	value: unknown,
	field: string,
	maxEntries: number,
	selectorKind: "role" | "agent",
): Record<string, string | EmpatraHostModelSelector> {
	if (!isRecord(value) || Object.keys(value).length > maxEntries) {
		throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
	}
	const result: Record<string, string | EmpatraHostModelSelector> = {};
	let bytes = 0;
	for (const [key, selector] of Object.entries(value)) {
		const safeKey = parseRoutingKey(key, `${field} key`);
		if (RESERVED_ROUTING_KEYS.has(safeKey)) {
			throw new EmpatraHostProtocolError("invalid_request", `${field} key is invalid`);
		}
		const parsed = parseSelector(selector, `${field}.${safeKey}`);
		if (selectorKind === "role" && typeof parsed !== "string") {
			throw new EmpatraHostProtocolError("invalid_request", `${field}.${safeKey} must be a single model selector`);
		}
		bytes += textEncoder.encode(safeKey).byteLength + (Array.isArray(parsed)
			? parsed.reduce((total, item) => total + textEncoder.encode(item).byteLength, 0)
			: textEncoder.encode(parsed).byteLength);
		if (bytes > EMPATRA_HOST_MAX_MODEL_ROUTING_BYTES) {
			throw new EmpatraHostProtocolError("invalid_request", `${field} exceeds its size limit`);
		}
		result[safeKey] = parsed;
	}
	return result;
}

function canonicalRecord(value: Record<string, string | EmpatraHostModelSelector>): Record<string, string | EmpatraHostModelSelector> {
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, selector]) => [key, Array.isArray(selector) ? [...selector] : selector]),
	);
}

function canonicalWrite(value: EmpatraHostModelRoutingWrite): EmpatraHostModelRoutingWrite {
	return {
		modelRoles: canonicalRecord(value.modelRoles) as Record<string, string>,
		taskAgentModelOverrides: canonicalRecord(value.taskAgentModelOverrides) as Record<
			string,
			EmpatraHostModelSelector
		>,
		version: EMPATRA_HOST_MODEL_ROUTING_VERSION,
	};
}

/** Compute a stable content revision without including the revision itself. */
export function computeEmpatraHostModelRoutingRevision(value: EmpatraHostModelRoutingWrite): string {
	const canonical = JSON.stringify(canonicalWrite(value));
	return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function createEmpatraHostModelRoutingSnapshot(
	value: EmpatraHostModelRoutingWrite = {
		modelRoles: {},
		taskAgentModelOverrides: {},
		version: EMPATRA_HOST_MODEL_ROUTING_VERSION,
	},
): EmpatraHostModelRoutingSnapshot {
	const write = canonicalWrite(value);
	return {
		...write,
		revision: computeEmpatraHostModelRoutingRevision(write),
	};
}

export function parseEmpatraHostModelRoutingWrite(value: unknown): EmpatraHostModelRoutingWrite {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["modelRoles", "taskAgentModelOverrides", "version"]) ||
		value.version !== EMPATRA_HOST_MODEL_ROUTING_VERSION
	) {
		throw new EmpatraHostProtocolError("invalid_request", "model routing settings are invalid");
	}
	const modelRoles = parseRecord(value.modelRoles, "modelRoles", EMPATRA_HOST_MAX_MODEL_ROLES, "role");
	const taskAgentModelOverrides = parseRecord(
		value.taskAgentModelOverrides,
		"task.agentModelOverrides",
		EMPATRA_HOST_MAX_AGENT_MODEL_OVERRIDES,
		"agent",
	);
	const write = canonicalWrite({
		modelRoles: modelRoles as Record<string, string>,
		taskAgentModelOverrides: taskAgentModelOverrides as Record<string, EmpatraHostModelSelector>,
		version: EMPATRA_HOST_MODEL_ROUTING_VERSION,
	});
	if (textEncoder.encode(JSON.stringify(write)).byteLength > EMPATRA_HOST_MAX_MODEL_ROUTING_BYTES) {
		throw new EmpatraHostProtocolError("invalid_request", "model routing settings exceed their size limit");
	}
	return write;
}

export function parseEmpatraHostModelRoutingSnapshot(value: unknown): EmpatraHostModelRoutingSnapshot {
	if (!isRecord(value) || !hasOnlyKeys(value, ["modelRoles", "revision", "taskAgentModelOverrides", "version"])) {
		throw new EmpatraHostProtocolError("invalid_request", "model routing snapshot is invalid");
	}
	const write = parseEmpatraHostModelRoutingWrite({
		modelRoles: value.modelRoles,
		taskAgentModelOverrides: value.taskAgentModelOverrides,
		version: value.version,
	});
	if (typeof value.revision !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.revision)) {
		throw new EmpatraHostProtocolError("invalid_request", "model routing revision is invalid");
	}
	const expectedRevision = computeEmpatraHostModelRoutingRevision(write);
	if (value.revision !== expectedRevision) {
		throw new EmpatraHostProtocolError("invalid_request", "model routing revision does not match its content");
	}
	return { ...write, revision: value.revision };
}

/**
 * Apply the semantic part of the boundary after host_initialize has supplied
 * the closed model catalog. A selector may be an injected model id or one of
 * OMP's bounded role aliases; arbitrary provider paths, URLs, and credential
 * shaped values are not accepted merely because they are strings.
 */
export function validateEmpatraHostModelRoutingModels(
	value: EmpatraHostModelRoutingWrite,
	modelIds: ReadonlySet<string>,
): void {
	const isAllowedSelector = (selector: string): boolean => {
		const separator = selector.lastIndexOf(":");
		const effort = separator > 0 ? selector.slice(separator + 1) : "";
		const base = separator > 0 && EFFORT.test(effort) ? selector.slice(0, separator) : selector;
		return modelIds.has(base) || base === "*" || ROLE_ALIAS.test(base) || LEGACY_ROLE_ALIAS.test(base);
	};
	for (const [role, selector] of Object.entries(value.modelRoles)) {
		if (!isAllowedSelector(selector)) {
			throw new EmpatraHostProtocolError("model_denied", `modelRoles.${role} is outside the injected model catalog`);
		}
	}
	for (const [agent, selector] of Object.entries(value.taskAgentModelOverrides)) {
		const selectors = Array.isArray(selector) ? selector : [selector];
		if (selectors.some(candidate => !isAllowedSelector(candidate))) {
			throw new EmpatraHostProtocolError(
				"model_denied",
				`task.agentModelOverrides.${agent} is outside the injected model catalog`,
			);
		}
	}
}

export function parseEmpatraHostModelRoutingReadCommand(
	value: Record<string, unknown>,
	id: string,
): EmpatraHostModelRoutingReadCommand {
	if (!hasOnlyKeys(value, ["id", "type"]) || value.type !== "settings_model_routing_read" || value.id !== id) {
		throw new EmpatraHostProtocolError("invalid_request", "settings_model_routing_read is invalid");
	}
	return { id, type: "settings_model_routing_read" };
}

export function parseEmpatraHostModelRoutingWriteCommand(
	value: Record<string, unknown>,
	id: string,
): EmpatraHostModelRoutingWriteCommand {
	if (
		!hasOnlyKeys(value, ["expectedRevision", "id", "modelRoles", "taskAgentModelOverrides", "type", "version"]) ||
		value.type !== "settings_model_routing_write" ||
		value.id !== id ||
		typeof value.expectedRevision !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(value.expectedRevision)
	) {
		throw new EmpatraHostProtocolError("invalid_request", "settings_model_routing_write is invalid");
	}
	const write = parseEmpatraHostModelRoutingWrite({
		modelRoles: value.modelRoles,
		taskAgentModelOverrides: value.taskAgentModelOverrides,
		version: value.version,
	});
	return { ...write, expectedRevision: value.expectedRevision, id, type: "settings_model_routing_write" };
}
