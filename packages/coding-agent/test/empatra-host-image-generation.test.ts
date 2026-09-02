import { describe, expect, test } from "bun:test";

import {
	EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY,
	EMPATRA_HOST_IMAGE_GENERATION_VERSION,
	EmpatraHostProtocolError,
	digestEmpatraHostImageGenerationRequest,
	parseEmpatraHostCommand,
	parseEmpatraHostImageGenerationRequestedEvent,
	parseEmpatraHostImageGenerationRequest,
	serializeEmpatraHostFrame,
	type EmpatraHostImageGenerationRequest,
} from "../src/modes/empatra-host";

const requestWithoutDigest = {
	capability: EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY,
	expectedGeneration: 1,
	operation: "generation" as const,
	prompt: "Нарисуй обложку",
	threadId: "thread-1",
	turnId: "turn-1",
	type: "image_generation_request" as const,
	version: EMPATRA_HOST_IMAGE_GENERATION_VERSION,
};

const request: EmpatraHostImageGenerationRequest = {
	...requestWithoutDigest,
	requestSha256: digestEmpatraHostImageGenerationRequest(requestWithoutDigest),
};

describe("Empatra host image generation wire contract", () => {
	test("binds request identity to prompt and CAS descriptors", () => {
		expect(parseEmpatraHostImageGenerationRequest(request)).toEqual(request);
		expect(() => parseEmpatraHostImageGenerationRequest({ ...request, prompt: "Другой prompt" })).toThrow(
			EmpatraHostProtocolError,
		);
	});

	test("rejects inline bytes and credential-shaped fields", () => {
		expect(() => parseEmpatraHostImageGenerationRequest({ ...request, apiKey: "secret" })).toThrow(
			"image generation request is invalid",
		);
		expect(() => parseEmpatraHostImageGenerationRequest({ ...request, data: "base64" })).toThrow(
			"image generation request is invalid",
		);
	});

	test("accepts a generation request event and preserves fencing identity", () => {
		const event = {
			capability: EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY,
			event: "image_generation_requested" as const,
			generation: 1,
			request,
			sequence: 2,
			threadId: request.threadId,
			turnId: request.turnId,
			type: "host_event" as const,
			version: EMPATRA_HOST_IMAGE_GENERATION_VERSION,
		};
		expect(parseEmpatraHostImageGenerationRequestedEvent(event)).toEqual(event);
		expect(serializeEmpatraHostFrame(event)).toContain('"image_generation_requested"');
		expect(parseEmpatraHostImageGenerationRequestedEvent({ ...event, turnId: "other" })).toBeNull();
	});

	test("parses a main-owned completion response and rejects untrusted identity", () => {
		const response = {
			capability: EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY,
			expectedGeneration: 1,
			id: "response-1",
			requestSha256: request.requestSha256,
			result: {
				images: [{ byteLength: 1024, mimeType: "image/png" as const, sha256: "a".repeat(64) }],
			},
			status: "completed" as const,
			threadId: request.threadId,
			turnId: request.turnId,
			type: "image_generation_response" as const,
			version: EMPATRA_HOST_IMAGE_GENERATION_VERSION,
		};
		expect(parseEmpatraHostCommand(JSON.stringify(response))).toEqual(response);
		expect(() =>
			parseEmpatraHostCommand(JSON.stringify({ ...response, requestSha256: "sha256:" + "B".repeat(64) })),
		).toThrow();
	});
});
