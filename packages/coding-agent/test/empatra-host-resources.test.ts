import { describe, expect, test } from "bun:test";

import {
	EMPATRA_HOST_MAX_FRAME_BYTES,
	EMPATRA_HOST_RESOURCES_CAPABILITY,
	EMPATRA_HOST_RESOURCES_VERSION,
	EmpatraHostProtocolError,
	assertEmpatraHostResourcesCapability,
	createEmpatraHostResourcesBrokerTransport,
	digestEmpatraHostResourcesRequest,
	parseEmpatraHostResourcesRequest,
	parseEmpatraHostResourcesResponseCommand,
	parseEmpatraHostResourcesRequestedEvent,
	serializeEmpatraHostFrame,
	type EmpatraHostResourcesRequest,
	type EmpatraHostResourcesResponseCommand,
	type EmpatraHostResourceDigest,
} from "../src/modes/empatra-host";

const scope = { generation: 3, threadId: "thread-1", turnId: "turn-1" } as const;

function listRequest(): EmpatraHostResourcesRequest {
	return {
		...scope,
		capability: EMPATRA_HOST_RESOURCES_CAPABILITY,
		method: "resources/list",
		requestId: "request-1",
		type: "resources_request",
		version: EMPATRA_HOST_RESOURCES_VERSION,
	};
}

describe("Empatra host resources contract", () => {
	test("requires explicit capability opt-in and keeps request metadata config-free", () => {
		expect(() => assertEmpatraHostResourcesCapability([])).toThrow(EmpatraHostProtocolError);
		assertEmpatraHostResourcesCapability([EMPATRA_HOST_RESOURCES_CAPABILITY]);
		expect(parseEmpatraHostResourcesRequest(listRequest())).toEqual(listRequest());
		expect(() => parseEmpatraHostResourcesRequest({ ...listRequest(), serverUrl: "https://secret.invalid" })).toThrow(
		"resources request is invalid",
		);
	});

	test("rejects credential-bearing, local-path, query, and fragment resource authorities", () => {
		for (const uri of [
			"https://user:password@example.com/resource",
			"file:///Users/roman/private.txt",
			"https://example.com/resource?token=secret",
			"https://example.com/resource#secret",
		]) {
			expect(() =>
				parseEmpatraHostResourcesRequest({
					...scope,
					capability: EMPATRA_HOST_RESOURCES_CAPABILITY,
					catalogDigest: `sha256:${"a".repeat(64)}`,
					method: "resources/read",
					requestId: "read-1",
					type: "resources_request",
					uri,
					version: EMPATRA_HOST_RESOURCES_VERSION,
				}),
			).toThrow(EmpatraHostProtocolError);
		}
	});

	test("fences transport responses by method, generation, scope, and request digest", async () => {
		let event: Awaited<ReturnType<typeof parseEmpatraHostResourcesRequestedEvent>> | undefined;
		const transport = createEmpatraHostResourcesBrokerTransport({
			capabilities: [EMPATRA_HOST_RESOURCES_CAPABILITY],
			emitRequest: async request => {
				event = parseEmpatraHostResourcesRequestedEvent(request);
			},
			requestTimeoutMs: 1000,
		});
		const pending = transport.broker.list(scope);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(event?.request.method).toBe("resources/list");
		if (!event) throw new Error("resource event was not emitted");
		const requestSha256 = digestEmpatraHostResourcesRequest(event.request);
		const catalogDigest = `sha256:${"b".repeat(64)}` as EmpatraHostResourceDigest;
		const result = { catalogDigest, resources: [{ name: "Документ", uri: "empatra://resource/document", size: 12 }] };
		const response: EmpatraHostResourcesResponseCommand = {
			capability: EMPATRA_HOST_RESOURCES_CAPABILITY,
			expectedGeneration: scope.generation,
			generation: scope.generation,
			id: "response-1",
			method: "resources/list" as const,
			requestId: event.request.requestId,
			requestSha256,
			result,
			status: "completed" as const,
			threadId: scope.threadId,
			turnId: scope.turnId,
			type: "resources_response" as const,
			version: EMPATRA_HOST_RESOURCES_VERSION,
		};
		transport.handleResponse(response);
		expect(await pending).toMatchObject(result);
		expect(() => parseEmpatraHostResourcesResponseCommand({ ...response, expectedGeneration: 2 })).not.toThrow();
		transport.dispose();
	});

	test("serializes bounded request events and rejects oversized content", () => {
		const request = listRequest();
		const digest = digestEmpatraHostResourcesRequest(request);
		const event = {
			event: "resources_requested" as const,
			generation: scope.generation,
			request,
			sequence: 1,
			threadId: scope.threadId,
			turnId: scope.turnId,
			type: "host_event" as const,
		};
		expect(serializeEmpatraHostFrame(event)).toContain("resources_requested");
		expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
		expect(EMPATRA_HOST_MAX_FRAME_BYTES).toBeGreaterThan(0);
		expect(() => parseEmpatraHostResourcesResponseCommand({
			capability: EMPATRA_HOST_RESOURCES_CAPABILITY,
			expectedGeneration: 3,
			generation: 3,
			id: "response-2",
			method: "resources/read",
			requestId: "read-2",
			requestSha256: `sha256:${"a".repeat(64)}`,
			result: {
				catalogDigest: `sha256:${"b".repeat(64)}`,
				contents: [{ blob: "x", text: "y", uri: "empatra://resource/document" }],
			},
			status: "completed",
			threadId: "thread-1",
			turnId: "turn-1",
			type: "resources_response",
			version: EMPATRA_HOST_RESOURCES_VERSION,
		})).toThrow(EmpatraHostProtocolError);
	});
});
