/**
 * Typed MCP server-to-client elicitation contracts.
 *
 * Elicitation is deliberately opt-in.  A caller must advertise the modes it
 * can render and provide a handler; transports otherwise answer
 * `elicitation/create` with JSON-RPC "method not found".  This keeps a headless
 * OMP host from silently accepting a prompt it cannot safely present.
 */

import type { JsonRpcError } from "./types";

export type MCPElicitationMode = "form" | "url";

export type MCPPrimitiveSchema = Readonly<{
	default?: boolean | number | string;
	description?: string;
	format?: "date" | "date-time" | "email" | "uri";
	maxLength?: number;
	maximum?: number;
	minLength?: number;
	minimum?: number;
	pattern?: string;
	title?: string;
	type: "boolean" | "integer" | "number" | "string";
}>;

/** Restricted, flat form schema permitted by MCP 2025-11-25. */
export type MCPFormRequestedSchema = Readonly<{
	additionalProperties?: boolean;
	properties?: Readonly<Record<string, MCPPrimitiveSchema>>;
	required?: readonly string[];
	type: "object";
}>;

export type MCPFormElicitationRequest = Readonly<{
	message: string;
	mode?: "form";
	requestedSchema: MCPFormRequestedSchema;
}>;

export type MCPUrlElicitationRequest = Readonly<{
	elicitationId: string;
	message: string;
	mode: "url";
	url: string;
}>;

export type MCPCreateElicitationRequest = MCPFormElicitationRequest | MCPUrlElicitationRequest;

export type MCPCreateElicitationResponse = Readonly<{
	action: "accept" | "cancel" | "decline";
	content?: Readonly<Record<string, boolean | number | string>>;
}>;

export interface MCPServerRequestContext {
	/** Main-owned identity of the server that initiated the request. */
	readonly serverName: string;
}

export type MCPElicitationHandler = (
	request: MCPCreateElicitationRequest,
	context: MCPServerRequestContext,
) => Promise<MCPCreateElicitationResponse>;

/** Explicit capability declaration and responder for elicitation/create. */
export interface MCPClientElicitationSupport {
	readonly form?: true;
	readonly handler: MCPElicitationHandler;
	readonly url?: true;
}

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_URL_BYTES = 2 * 1024;
const MAX_ELICITATION_ID_BYTES = 256;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_PROPERTIES = 128;
const MAX_PROPERTY_NAME_BYTES = 256;
const MAX_PROPERTY_TEXT_BYTES = 8 * 1024;
const MAX_REQUIRED = 128;
const CONTROL_CHARACTER = /\p{Cc}/u;
const PRIMITIVE_TYPES = new Set<MCPPrimitiveSchema["type"]>(["boolean", "integer", "number", "string"]);

function boundedText(value: unknown, maxBytes: number, label: string): string {
	if (typeof value !== "string" || value.length === 0 || CONTROL_CHARACTER.test(value)) {
		throw invalidParams(`${label} is invalid`);
	}
	if (new TextEncoder().encode(value).byteLength > maxBytes) throw invalidParams(`${label} is too large`);
	return value;
}

function invalidParams(message: string): JsonRpcError & Error {
	return Object.assign(new Error(message), { code: -32602 as const });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidParams(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function validateSchema(value: unknown): MCPFormRequestedSchema {
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		throw invalidParams("requestedSchema is not JSON serializable");
	}
	if (Buffer.byteLength(encoded, "utf8") > MAX_SCHEMA_BYTES) throw invalidParams("requestedSchema is too large");
	const schema = asRecord(value, "requestedSchema");
	if (schema.type !== "object") throw invalidParams("requestedSchema.type must be object");
	if (Object.keys(schema).some(key => !["type", "properties", "required", "additionalProperties"].includes(key))) {
		throw invalidParams("requestedSchema contains unsupported fields");
	}
	if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
		throw invalidParams("requestedSchema.additionalProperties is invalid");
	}
	const propertiesValue = schema.properties ?? {};
	const properties = asRecord(propertiesValue, "requestedSchema.properties");
	const propertyEntries = Object.entries(properties);
	if (propertyEntries.length > MAX_PROPERTIES) throw invalidParams("requestedSchema has too many properties");
	const normalized: Record<string, MCPPrimitiveSchema> = {};
	for (const [name, rawValue] of propertyEntries) {
		boundedText(name, MAX_PROPERTY_NAME_BYTES, "property name");
		const property = asRecord(rawValue, `property ${name}`);
		if (typeof property.type !== "string" || !PRIMITIVE_TYPES.has(property.type as MCPPrimitiveSchema["type"])) {
			throw invalidParams(`property ${name} has an unsupported type`);
		}
		for (const key of Object.keys(property)) {
			if (
				![
					"type",
					"title",
					"description",
					"format",
					"minLength",
					"maxLength",
					"pattern",
					"minimum",
					"maximum",
					"default",
				].includes(key)
			) {
				throw invalidParams(`property ${name} contains unsupported fields`);
			}
		}
		for (const key of ["title", "description", "pattern"] as const) {
			if (property[key] !== undefined)
				boundedText(property[key], MAX_PROPERTY_TEXT_BYTES, `property ${name}.${key}`);
		}
		if (property.format !== undefined && !["date", "date-time", "email", "uri"].includes(String(property.format))) {
			throw invalidParams(`property ${name}.format is invalid`);
		}
		for (const key of ["minLength", "maxLength"] as const) {
			const value = property[key];
			if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
				throw invalidParams(`property ${name}.${key} is invalid`);
			}
		}
		for (const key of ["minimum", "maximum"] as const) {
			if (property[key] !== undefined && (typeof property[key] !== "number" || !Number.isFinite(property[key]))) {
				throw invalidParams(`property ${name}.${key} is invalid`);
			}
		}
		normalized[name] = property as MCPPrimitiveSchema;
	}
	const requiredValue = schema.required ?? [];
	if (
		!Array.isArray(requiredValue) ||
		requiredValue.length > MAX_REQUIRED ||
		requiredValue.some(name => typeof name !== "string")
	) {
		throw invalidParams("requestedSchema.required is invalid");
	}
	const required = requiredValue as string[];
	if (new Set(required).size !== required.length || required.some(name => !Object.hasOwn(normalized, name))) {
		throw invalidParams("requestedSchema.required references an unknown property");
	}
	return {
		...(schema.additionalProperties === undefined ? {} : { additionalProperties: schema.additionalProperties }),
		properties: normalized,
		required,
		type: "object",
	};
}

/** Parse and validate the parameters of an MCP `elicitation/create` request. */
export function parseMCPCreateElicitationRequest(value: unknown): MCPCreateElicitationRequest {
	const params = asRecord(value ?? {}, "elicitation/create params");
	const mode = params.mode === undefined ? "form" : params.mode;
	const message = boundedText(params.message, MAX_MESSAGE_BYTES, "elicitation message");
	if (mode === "form") {
		return {
			message,
			mode: "form",
			requestedSchema: validateSchema(params.requestedSchema),
		};
	}
	if (mode !== "url") throw invalidParams("elicitation mode is unsupported");
	const elicitationId = boundedText(params.elicitationId, MAX_ELICITATION_ID_BYTES, "elicitationId");
	const url = boundedText(params.url, MAX_URL_BYTES, "elicitation URL");
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw invalidParams("elicitation URL is invalid");
	}
	if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
		throw invalidParams("elicitation URL must be HTTP(S) without embedded credentials");
	}
	return { elicitationId, message, mode: "url", url: parsed.toString() };
}

/** Validate an explicit handler result before returning it to an MCP server. */
export function validateMCPCreateElicitationResponse(
	value: unknown,
	request: MCPCreateElicitationRequest,
): MCPCreateElicitationResponse {
	const result = asRecord(value, "elicitation response");
	if (result.action !== "accept" && result.action !== "decline" && result.action !== "cancel") {
		throw invalidParams("elicitation response action is invalid");
	}
	if (result.action !== "accept") {
		if (result.content !== undefined) throw invalidParams("declined elicitation cannot include content");
		return { action: result.action };
	}
	if (request.mode === "url") {
		if (result.content !== undefined) throw invalidParams("URL elicitation cannot include content");
		return { action: "accept" };
	}
	const content = asRecord(result.content ?? {}, "elicitation response content");
	const properties = request.requestedSchema.properties ?? {};
	for (const [key, item] of Object.entries(content)) {
		if (
			!Object.hasOwn(properties, key) ||
			(typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") ||
			(typeof item === "number" && !Number.isFinite(item))
		) {
			throw invalidParams("elicitation response content is invalid");
		}
		const type = properties[key]!.type;
		if (
			(type === "string" && typeof item !== "string") ||
			(type === "boolean" && typeof item !== "boolean") ||
			((type === "number" || type === "integer") &&
				(typeof item !== "number" || (type === "integer" && !Number.isInteger(item))))
		) {
			throw invalidParams("elicitation response content type is invalid");
		}
	}
	for (const key of request.requestedSchema.required ?? []) {
		if (!Object.hasOwn(content, key)) throw invalidParams("elicitation response is missing a required value");
	}
	return { action: "accept", content: content as MCPCreateElicitationResponse["content"] };
}

/** Build the exact capability object sent during MCP initialize. */
export function elicitationCapabilities(
	support: MCPClientElicitationSupport | undefined,
): { form?: Record<string, never>; url?: Record<string, never> } | undefined {
	if (!support) return undefined;
	if (support.form !== true && support.url !== true)
		throw new RangeError("MCP elicitation requires form or url support");
	return {
		...(support.form === true ? { form: {} } : {}),
		...(support.url === true ? { url: {} } : {}),
	};
}
