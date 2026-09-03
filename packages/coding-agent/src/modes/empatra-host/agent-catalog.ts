import { createHash } from "node:crypto";

import { EmpatraHostProtocolError } from "./errors";
import type { EmpatraHostModelSelector } from "./model-routing";
import type { EmpatraHostReasoningEffort } from "./protocol";

/**
 * Main-injected metadata for one OMP task agent.
 *
 * OMP's native representation is a markdown agent definition: `description`,
 * an optional ordered `model` list, `thinking-level`, and the markdown body as
 * the system/developer prompt.  The host keeps that semantic shape explicit
 * without accepting paths, tools, provider credentials, or executable code.
 */
export interface EmpatraHostAgentDefinition {
	description: string;
	developerInstructions: string;
	model?: EmpatraHostModelSelector;
	name: string;
	reasoning?: EmpatraHostReasoningEffort;
}

export const EMPATRA_HOST_AGENT_CATALOG_VERSION = 1 as const;
export const EMPATRA_HOST_MAX_AGENT_CATALOG_ENTRIES = 128;
export const EMPATRA_HOST_MAX_AGENT_DESCRIPTION_BYTES = 4 * 1024;
export const EMPATRA_HOST_MAX_AGENT_INSTRUCTIONS_BYTES = 128 * 1024;
export const EMPATRA_HOST_MAX_AGENT_CATALOG_BYTES = 512 * 1024;
export const EMPATRA_HOST_MAX_AGENT_MODEL_SELECTORS = 16;

export interface EmpatraHostAgentCatalog {
	agents: EmpatraHostAgentDefinition[];
	revision: string;
	version: typeof EMPATRA_HOST_AGENT_CATALOG_VERSION;
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MODEL_SELECTOR = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const textEncoder = new TextEncoder();
const INVALID_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every(key => allowed.has(key));
}

function boundedText(value: unknown, field: string, maxBytes: number, allowEmpty = false): string {
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.trim() === "") ||
		textEncoder.encode(value).byteLength > maxBytes ||
		INVALID_TEXT_CONTROL.test(value)
	) {
		throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
	}
	return value.trim();
}

function parseModel(value: unknown): EmpatraHostModelSelector | undefined {
	if (value === undefined) return undefined;
	const selectors = Array.isArray(value) ? value : [value];
	if (selectors.length === 0 || selectors.length > EMPATRA_HOST_MAX_AGENT_MODEL_SELECTORS) {
		throw new EmpatraHostProtocolError("invalid_request", "agent model is invalid");
	}
	const parsed = selectors.map((selector, index) => {
		if (
			typeof selector !== "string" ||
			!MODEL_SELECTOR.test(selector) ||
			selector.trim() !== selector ||
			textEncoder.encode(selector).byteLength > 512
		) {
			throw new EmpatraHostProtocolError("invalid_request", `agent model[${index}] is invalid`);
		}
		return selector;
	});
	if (new Set(parsed).size !== parsed.length) {
		throw new EmpatraHostProtocolError("invalid_request", "agent model must not contain duplicate selectors");
	}
	return Array.isArray(value) ? parsed : parsed[0];
}

function parseAgent(value: unknown): EmpatraHostAgentDefinition {
	if (!isRecord(value) || !hasOnlyKeys(value, ["description", "developerInstructions", "model", "name", "reasoning"])) {
		throw new EmpatraHostProtocolError("invalid_request", "agent catalog contains an invalid agent");
	}
	if (typeof value.name !== "string" || !AGENT_NAME.test(value.name)) {
		throw new EmpatraHostProtocolError("invalid_request", "agent name is invalid");
	}
	const reasoning = value.reasoning;
	if (
		reasoning !== undefined &&
		!(["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const).includes(
			reasoning as EmpatraHostReasoningEffort,
		)
	) {
		throw new EmpatraHostProtocolError("invalid_request", "agent reasoning is invalid");
	}
	const model = parseModel(value.model);
	return {
		description: boundedText(value.description, "agent description", EMPATRA_HOST_MAX_AGENT_DESCRIPTION_BYTES),
		developerInstructions: boundedText(
			value.developerInstructions,
			"agent developerInstructions",
			EMPATRA_HOST_MAX_AGENT_INSTRUCTIONS_BYTES,
		),
		...(model === undefined ? {} : { model }),
		name: value.name,
		...(reasoning === undefined ? {} : { reasoning: reasoning as EmpatraHostReasoningEffort }),
	};
}

function canonicalAgents(agents: readonly EmpatraHostAgentDefinition[]): EmpatraHostAgentDefinition[] {
	return [...agents]
		.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
		.map(agent => ({
			description: agent.description,
			developerInstructions: agent.developerInstructions,
			...(agent.model === undefined
				? {}
				: { model: Array.isArray(agent.model) ? [...agent.model] : agent.model }),
			name: agent.name,
			...(agent.reasoning === undefined ? {} : { reasoning: agent.reasoning }),
		}));
}

function canonicalCatalog(catalog: EmpatraHostCatalog): EmpatraHostCatalog {
	return {
		agents: canonicalAgents(catalog.agents),
		version: EMPATRA_HOST_AGENT_CATALOG_VERSION,
	};
}

type EmpatraHostCatalog = Omit<EmpatraHostAgentCatalog, "revision">;

function computeRevision(value: EmpatraHostCatalog): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function computeEmpatraHostAgentCatalogRevision(
	value: Omit<EmpatraHostAgentCatalog, "revision">,
): string {
	return computeRevision(canonicalCatalog(value));
}

export function createEmpatraHostAgentCatalog(
	agents: readonly EmpatraHostAgentDefinition[] = [],
): EmpatraHostAgentCatalog {
	if (agents.length > EMPATRA_HOST_MAX_AGENT_CATALOG_ENTRIES) {
		throw new EmpatraHostProtocolError("invalid_request", "agent catalog exceeds its entry limit");
	}
	const parsedAgents = agents.map(agent => parseAgent(agent));
	const names = new Set<string>();
	for (const parsed of parsedAgents) {
		if (names.has(parsed.name)) {
			throw new EmpatraHostProtocolError("invalid_request", "agent catalog names must be unique");
		}
		names.add(parsed.name);
	}
	const canonical = canonicalCatalog({ agents: parsedAgents, version: EMPATRA_HOST_AGENT_CATALOG_VERSION });
	if (textEncoder.encode(JSON.stringify(canonical)).byteLength > EMPATRA_HOST_MAX_AGENT_CATALOG_BYTES) {
		throw new EmpatraHostProtocolError("invalid_request", "agent catalog exceeds its size limit");
	}
	return { ...canonical, revision: computeRevision(canonical) };
}

export function parseEmpatraHostAgentCatalog(value: unknown): EmpatraHostAgentCatalog {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["agents", "revision", "version"]) ||
		value.version !== EMPATRA_HOST_AGENT_CATALOG_VERSION ||
		!Array.isArray(value.agents) ||
		value.agents.length > EMPATRA_HOST_MAX_AGENT_CATALOG_ENTRIES ||
		typeof value.revision !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(value.revision)
	) {
		throw new EmpatraHostProtocolError("invalid_request", "agent catalog is invalid");
	}
	const agents = value.agents.map(parseAgent);
	const names = new Set<string>();
	for (const agent of agents) {
		if (names.has(agent.name)) {
			throw new EmpatraHostProtocolError("invalid_request", "agent catalog names must be unique");
		}
		names.add(agent.name);
	}
	const canonical = canonicalCatalog({ agents, version: EMPATRA_HOST_AGENT_CATALOG_VERSION });
	if (textEncoder.encode(JSON.stringify(canonical)).byteLength > EMPATRA_HOST_MAX_AGENT_CATALOG_BYTES) {
		throw new EmpatraHostProtocolError("invalid_request", "agent catalog exceeds its size limit");
	}
	const expectedRevision = computeRevision(canonical);
	if (value.revision !== expectedRevision) {
		throw new EmpatraHostProtocolError("invalid_request", "agent catalog revision does not match its content");
	}
	return { ...canonical, revision: value.revision };
}

/** Validate model selectors only against the host's main-injected model set. */
export function validateEmpatraHostAgentCatalogModels(
	catalog: EmpatraHostAgentCatalog,
	modelIds: ReadonlySet<string>,
): void {
	const isAllowed = (selector: string): boolean => {
		const separator = selector.lastIndexOf(":");
		const effort = separator > 0 ? selector.slice(separator + 1) : "";
		const base = separator > 0 && ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)
			? selector.slice(0, separator)
			: selector;
		return modelIds.has(base) || base === "*" || /^@[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(base) || /^pi\/[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(base);
	};
	for (const agent of catalog.agents) {
		const selectors = agent.model === undefined ? [] : Array.isArray(agent.model) ? agent.model : [agent.model];
		if (selectors.some(selector => !isAllowed(selector))) {
			throw new EmpatraHostProtocolError(
				"model_denied",
				`agent ${agent.name} contains a model outside the injected model catalog`,
			);
		}
	}
}
