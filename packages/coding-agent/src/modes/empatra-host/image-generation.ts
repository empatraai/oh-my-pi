import { createHash } from "node:crypto";

import { EmpatraHostProtocolError } from "./errors";
import {
	EMPATRA_HOST_MAX_IMAGE_BYTES,
	EMPATRA_HOST_MAX_IMAGE_BYTES_TOTAL,
	EMPATRA_HOST_MAX_IMAGE_PIXELS,
	EMPATRA_HOST_MAX_IMAGES,
	EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY,
	type EmpatraHostImageMimeType,
} from "./protocol";

/**
 * Main-owned image generation contract.  It is intentionally separate from
 * the advertised host capability list until Electron provides the provider
 * executor.  OMP must never receive provider credentials or inline image
 * bytes; it receives only this versioned, content-addressed descriptor.
 */
export const EMPATRA_HOST_IMAGE_GENERATION_VERSION = 1 as const;
export const EMPATRA_HOST_MAX_IMAGE_PROMPT_BYTES = 256 * 1024;

type ImageGenerationOperation = "edit" | "generation";

export interface EmpatraHostImageGenerationCasDescriptor {
	byteLength: number;
	displayName?: string;
	heightPixels?: number;
	mimeType: EmpatraHostImageMimeType;
	sha256: string;
	widthPixels?: number;
}

export interface EmpatraHostImageGenerationRequest {
	capability: typeof EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY;
	expectedGeneration: number;
	inputImages?: readonly EmpatraHostImageGenerationCasDescriptor[];
	operation: ImageGenerationOperation;
	prompt: string;
	requestSha256: string;
	threadId: string;
	turnId: string;
	type: "image_generation_request";
	version: typeof EMPATRA_HOST_IMAGE_GENERATION_VERSION;
}

export interface EmpatraHostImageGenerationResult {
	images: readonly EmpatraHostImageGenerationCasDescriptor[];
	revisedPrompt?: string;
}

export interface EmpatraHostImageGenerationEvent {
	capability: typeof EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY;
	error?: Readonly<{ code: string; message: string }>;
	event: "image_generation";
	generation: number;
	operation: ImageGenerationOperation;
	requestSha256: string;
	result?: EmpatraHostImageGenerationResult;
	sequence: number;
	status: "completed" | "failed";
	threadId: string;
	turnId: string;
	type: "host_event";
	version: typeof EMPATRA_HOST_IMAGE_GENERATION_VERSION;
}

export type EmpatraHostImageGenerationCommand = EmpatraHostImageGenerationRequest;
export type EmpatraHostImageGenerationResponse = EmpatraHostImageGenerationEvent;

const encoder = new TextEncoder();
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const REQUEST_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const CONTROL_CHARACTER = /\p{Cc}/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every(key => allowed.has(key));
}

function boundedIdentity(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 256 || CONTROL_CHARACTER.test(value)) {
		throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
	}
	return value;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
		throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
	}
	return value as number;
}

function boundedPrompt(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		encoder.encode(value).byteLength > EMPATRA_HOST_MAX_IMAGE_PROMPT_BYTES ||
		CONTROL_CHARACTER.test(value)
	) {
		throw new EmpatraHostProtocolError("invalid_request", "prompt is invalid");
	}
	return value;
}

function parseCasDescriptor(value: unknown, index: number): EmpatraHostImageGenerationCasDescriptor {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["byteLength", "displayName", "heightPixels", "mimeType", "sha256", "widthPixels"]) ||
		(typeof value.displayName !== "undefined" &&
			(typeof value.displayName !== "string" ||
				value.displayName.length < 1 ||
				value.displayName.length > 160 ||
				CONTROL_CHARACTER.test(value.displayName))) ||
		typeof value.sha256 !== "string" ||
		!HEX_SHA256.test(value.sha256) ||
		(value.mimeType !== "image/gif" &&
			value.mimeType !== "image/jpeg" &&
			value.mimeType !== "image/png" &&
			value.mimeType !== "image/webp")
	) {
		throw new EmpatraHostProtocolError("invalid_request", `images[${index}] is invalid`);
	}
	const byteLength = boundedInteger(value.byteLength, `images[${index}].byteLength`, 1, EMPATRA_HOST_MAX_IMAGE_BYTES);
	const hasWidth = value.widthPixels !== undefined;
	const hasHeight = value.heightPixels !== undefined;
	if (hasWidth !== hasHeight) {
		throw new EmpatraHostProtocolError("invalid_request", `images[${index}] dimensions are incomplete`);
	}
	const widthPixels = hasWidth
		? boundedInteger(value.widthPixels, `images[${index}].widthPixels`, 1, EMPATRA_HOST_MAX_IMAGE_PIXELS)
		: undefined;
	const heightPixels = hasHeight
		? boundedInteger(value.heightPixels, `images[${index}].heightPixels`, 1, EMPATRA_HOST_MAX_IMAGE_PIXELS)
		: undefined;
	if (
		widthPixels !== undefined &&
		heightPixels !== undefined &&
		widthPixels * heightPixels > EMPATRA_HOST_MAX_IMAGE_PIXELS
	) {
		throw new EmpatraHostProtocolError("invalid_request", `images[${index}] exceeds its pixel limit`);
	}
	return {
		byteLength,
		...(value.displayName === undefined ? {} : { displayName: value.displayName }),
		...(heightPixels === undefined ? {} : { heightPixels }),
		mimeType: value.mimeType,
		sha256: value.sha256,
		...(widthPixels === undefined ? {} : { widthPixels }),
	};
}

function parseCasDescriptors(value: unknown): readonly EmpatraHostImageGenerationCasDescriptor[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length < 1 || value.length > EMPATRA_HOST_MAX_IMAGES) {
		throw new EmpatraHostProtocolError("invalid_request", "images is invalid");
	}
	const descriptors = value.map(parseCasDescriptor);
	if (
		descriptors.reduce((total, descriptor) => total + descriptor.byteLength, 0) > EMPATRA_HOST_MAX_IMAGE_BYTES_TOTAL
	) {
		throw new EmpatraHostProtocolError("invalid_request", "images exceeds its aggregate byte limit");
	}
	return descriptors;
}

function canonicalRequest(request: Omit<EmpatraHostImageGenerationRequest, "requestSha256">): string {
	return JSON.stringify({
		capability: request.capability,
		expectedGeneration: request.expectedGeneration,
		inputImages: request.inputImages ?? [],
		operation: request.operation,
		prompt: request.prompt,
		threadId: request.threadId,
		turnId: request.turnId,
		type: request.type,
		version: request.version,
	});
}

export function digestEmpatraHostImageGenerationRequest(
	request: Omit<EmpatraHostImageGenerationRequest, "requestSha256">,
): string {
	return `sha256:${createHash("sha256").update(canonicalRequest(request)).digest("hex")}`;
}

/** Parse and bind a request without ever accepting provider credentials or bytes. */
export function parseEmpatraHostImageGenerationRequest(value: unknown): EmpatraHostImageGenerationRequest {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"capability",
			"expectedGeneration",
			"inputImages",
			"operation",
			"prompt",
			"requestSha256",
			"threadId",
			"turnId",
			"type",
			"version",
		]) ||
		value.capability !== EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY ||
		value.version !== EMPATRA_HOST_IMAGE_GENERATION_VERSION ||
		(value.operation !== "generation" && value.operation !== "edit") ||
		value.type !== "image_generation_request" ||
		typeof value.requestSha256 !== "string" ||
		!REQUEST_SHA256.test(value.requestSha256)
	) {
		throw new EmpatraHostProtocolError("invalid_request", "image generation request is invalid");
	}
	const inputImages = parseCasDescriptors(value.inputImages);
	const request: Omit<EmpatraHostImageGenerationRequest, "requestSha256"> = {
		capability: EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY,
		expectedGeneration: boundedInteger(value.expectedGeneration, "expectedGeneration", 0, Number.MAX_SAFE_INTEGER),
		...(inputImages === undefined ? {} : { inputImages }),
		operation: value.operation,
		prompt: boundedPrompt(value.prompt),
		threadId: boundedIdentity(value.threadId, "threadId"),
		turnId: boundedIdentity(value.turnId, "turnId"),
		type: "image_generation_request",
		version: EMPATRA_HOST_IMAGE_GENERATION_VERSION,
	};
	if (digestEmpatraHostImageGenerationRequest(request) !== value.requestSha256) {
		throw new EmpatraHostProtocolError(
			"identity_mismatch",
			"image generation request digest does not match its inputs",
		);
	}
	return { ...request, requestSha256: value.requestSha256 };
}

function parseResult(value: unknown): EmpatraHostImageGenerationResult {
	if (!isRecord(value) || !hasOnlyKeys(value, ["images", "revisedPrompt"]) || !Array.isArray(value.images)) {
		throw new EmpatraHostProtocolError("image_generation_invalid", "image generation result is invalid");
	}
	const images = parseCasDescriptors(value.images);
	if (!images) throw new EmpatraHostProtocolError("image_generation_invalid", "image generation returned no images");
	if (
		value.revisedPrompt !== undefined &&
		(typeof value.revisedPrompt !== "string" || value.revisedPrompt.length > 65_536)
	) {
		throw new EmpatraHostProtocolError("image_generation_invalid", "revisedPrompt is invalid");
	}
	return { images, ...(value.revisedPrompt === undefined ? {} : { revisedPrompt: value.revisedPrompt }) };
}

/** Validate a result event before projecting it to a controller. */
export function parseEmpatraHostImageGenerationEvent(value: unknown): EmpatraHostImageGenerationEvent {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"capability",
			"error",
			"event",
			"generation",
			"operation",
			"requestSha256",
			"result",
			"sequence",
			"status",
			"threadId",
			"turnId",
			"type",
			"version",
		]) ||
		value.capability !== EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY ||
		value.event !== "image_generation" ||
		value.type !== "host_event" ||
		value.version !== EMPATRA_HOST_IMAGE_GENERATION_VERSION ||
		(value.operation !== "generation" && value.operation !== "edit") ||
		(value.status !== "completed" && value.status !== "failed") ||
		typeof value.requestSha256 !== "string" ||
		!REQUEST_SHA256.test(value.requestSha256)
	) {
		throw new EmpatraHostProtocolError("invalid_request", "image generation event is invalid");
	}
	const generation = boundedInteger(value.generation, "generation", 0, Number.MAX_SAFE_INTEGER);
	const sequence = boundedInteger(value.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER);
	const threadId = boundedIdentity(value.threadId, "threadId");
	const turnId = boundedIdentity(value.turnId, "turnId");
	if (value.status === "completed") {
		if (value.result === undefined || value.error !== undefined) {
			throw new EmpatraHostProtocolError(
				"image_generation_invalid",
				"completed image event must contain only a result",
			);
		}
		return {
			capability: EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY,
			event: "image_generation",
			generation,
			operation: value.operation,
			requestSha256: value.requestSha256,
			result: parseResult(value.result),
			sequence,
			status: "completed",
			threadId,
			turnId,
			type: "host_event",
			version: EMPATRA_HOST_IMAGE_GENERATION_VERSION,
		};
	}
	if (value.result !== undefined || !isRecord(value.error) || !hasOnlyKeys(value.error, ["code", "message"])) {
		throw new EmpatraHostProtocolError(
			"image_generation_invalid",
			"failed image event must contain only a safe error",
		);
	}
	const code = boundedIdentity(value.error.code, "error.code");
	const message = boundedPrompt(value.error.message);
	return {
		capability: EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY,
		error: { code, message },
		event: "image_generation",
		generation,
		operation: value.operation,
		requestSha256: value.requestSha256,
		sequence,
		status: "failed",
		threadId,
		turnId,
		type: "host_event",
		version: EMPATRA_HOST_IMAGE_GENERATION_VERSION,
	};
}
