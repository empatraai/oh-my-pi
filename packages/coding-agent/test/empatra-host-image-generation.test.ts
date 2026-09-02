import { describe, expect, test } from "bun:test";

import {
	digestEmpatraHostImageGenerationRequest,
	EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY,
	EMPATRA_HOST_IMAGE_GENERATION_VERSION,
	EmpatraHostProtocolError,
	parseEmpatraHostImageGenerationEvent,
	parseEmpatraHostImageGenerationRequest,
	type EmpatraHostImageGenerationRequest,
} from "../src/modes/empatra-host";

const input = {
	byteLength: 1024,
	displayName: "reference.png",
	heightPixels: 64,
	mimeType: "image/png" as const,
	sha256: "a".repeat(64),
	widthPixels: 64,
};

function request(): EmpatraHostImageGenerationRequest {
	const unsigned = {
		capability: EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY,
		expectedGeneration: 3,
		inputImages: [input],
		operation: "edit" as const,
		prompt: "Удалить фон и сохранить объект",
		threadId: "thread-1",
		turnId: "turn-1",
		type: "image_generation_request" as const,
		version: EMPATRA_HOST_IMAGE_GENERATION_VERSION,
	};
	return { ...unsigned, requestSha256: digestEmpatraHostImageGenerationRequest(unsigned) };
}

describe("Empatra host image generation contract", () => {
	test("binds request identity to the prompt, CAS descriptors, and generation", () => {
		const parsed = parseEmpatraHostImageGenerationRequest(request());
		expect(parsed).toEqual(request());
		expect(() => parseEmpatraHostImageGenerationRequest({ ...request(), prompt: "Другой prompt" })).toThrow(
			EmpatraHostProtocolError,
		);
	});

	test("rejects inline bytes and credential-shaped fields at the boundary", () => {
		const value = { ...request(), apiKey: "secret" };
		expect(() => parseEmpatraHostImageGenerationRequest(value)).toThrow("image generation request is invalid");
		expect(() => parseEmpatraHostImageGenerationRequest({ ...request(), data: "base64" })).toThrow(
			"image generation request is invalid",
		);
	});

	test("validates completed CAS result events", () => {
		const inputRequest = request();
		const event = parseEmpatraHostImageGenerationEvent({
			capability: EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY,
			event: "image_generation",
			generation: inputRequest.expectedGeneration,
			operation: inputRequest.operation,
			requestSha256: inputRequest.requestSha256,
			result: { images: [{ ...input, sha256: "b".repeat(64) }] },
			sequence: 1,
			status: "completed",
			threadId: inputRequest.threadId,
			turnId: inputRequest.turnId,
			type: "host_event",
			version: EMPATRA_HOST_IMAGE_GENERATION_VERSION,
		});
		expect(event.status).toBe("completed");
		expect(event.result?.images[0]?.sha256).toBe("b".repeat(64));
		expect(() => parseEmpatraHostImageGenerationEvent({ ...event, result: undefined })).toThrow(
			"completed image event",
		);
	});
});
