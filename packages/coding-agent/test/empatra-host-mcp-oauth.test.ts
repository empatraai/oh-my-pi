import { describe, expect, test } from "bun:test";

import {
	createEmpatraHostMcpOAuthBrokerTransport,
	createFailClosedEmpatraHostMcpOAuthBroker,
	digestEmpatraHostMcpOAuthRequest,
	EMPATRA_HOST_CAPABILITIES,
	EMPATRA_HOST_MCP_OAUTH_CAPABILITY,
	EMPATRA_HOST_MCP_OAUTH_VERSION,
	type EmpatraHostMcpOAuthRequest,
	type EmpatraHostMcpOAuthRequestedEvent,
	EmpatraHostProtocolError,
	parseEmpatraHostCommand,
	parseEmpatraHostMcpOAuthRequest,
	parseEmpatraHostMcpOAuthRequestedEvent,
	parseEmpatraHostMcpOAuthResponseCommand,
	serializeEmpatraHostFrame,
} from "../src/modes/empatra-host";

const requestWithoutDigest = {
	capability: EMPATRA_HOST_MCP_OAUTH_CAPABILITY,
	generation: 3,
	requestId: "oauth-request-1",
	resource: "https://mcp.example.test/resource",
	serverName: "example-mcp",
	serverUrl: "https://mcp.example.test/mcp",
	scopes: "tools:read tools:write",
	threadId: "thread-1",
	turnId: "turn-1",
	type: "mcp_oauth_request" as const,
	version: EMPATRA_HOST_MCP_OAUTH_VERSION,
};

const request: EmpatraHostMcpOAuthRequest = {
	...requestWithoutDigest,
	requestSha256: digestEmpatraHostMcpOAuthRequest(requestWithoutDigest),
};

function requestedEvent(
	overrides: Partial<EmpatraHostMcpOAuthRequestedEvent> = {},
): EmpatraHostMcpOAuthRequestedEvent {
	return {
		event: "mcp_oauth_requested",
		generation: request.generation,
		request,
		sequence: 1,
		threadId: request.threadId,
		turnId: request.turnId,
		type: "host_event",
		...overrides,
	};
}

describe("Empatra host main-owned MCP OAuth contract", () => {
	test("keeps OAuth capability opt-in and secret-free", () => {
		expect(EMPATRA_HOST_MCP_OAUTH_CAPABILITY).toBe("mcp.oauth.main-owned-v1");
		expect(EMPATRA_HOST_CAPABILITIES).not.toContain(
			EMPATRA_HOST_MCP_OAUTH_CAPABILITY,
		);
		expect(parseEmpatraHostMcpOAuthRequest(request)).toEqual(request);
		expect(Object.keys(request)).not.toContain("clientSecret");
		expect(Object.keys(request)).not.toContain("authorizationCode");
	});

	test("binds the request digest and rejects credential or transport smuggling", () => {
		expect(() =>
			parseEmpatraHostMcpOAuthRequest({
				...request,
				serverUrl: "https://user:secret@mcp.example.test/mcp",
			}),
		).toThrow(EmpatraHostProtocolError);
		expect(() =>
			parseEmpatraHostMcpOAuthRequest({ ...request, clientSecret: "secret" }),
		).toThrow(EmpatraHostProtocolError);
		expect(() =>
			parseEmpatraHostMcpOAuthRequest({
				...request,
				requestSha256: `sha256:${"0".repeat(64)}`,
			}),
		).toThrow("digest");
		expect(() =>
			parseEmpatraHostMcpOAuthRequest({
				...request,
				headers: { Authorization: "Bearer secret" },
			}),
		).toThrow(EmpatraHostProtocolError);
	});

	test("parses and serializes a turn-fenced host event", () => {
		const event = requestedEvent();
		expect(parseEmpatraHostMcpOAuthRequestedEvent(event)).toEqual(event);
		expect(serializeEmpatraHostFrame(event)).toContain('"mcp_oauth_requested"');
		expect(() =>
			parseEmpatraHostMcpOAuthRequestedEvent({ ...event, turnId: "other" }),
		).toThrow("scope");
	});

	test("parses a status-only main response and rejects invalid status shape", () => {
		const response = {
			capability: EMPATRA_HOST_MCP_OAUTH_CAPABILITY,
			error: { code: "oauth_failed", message: "Authorization was denied" },
			expectedGeneration: request.generation,
			generation: request.generation,
			id: "oauth-response-1",
			requestId: request.requestId,
			requestSha256: request.requestSha256,
			status: "failed" as const,
			threadId: request.threadId,
			turnId: request.turnId,
			type: "mcp_oauth_response" as const,
			version: EMPATRA_HOST_MCP_OAUTH_VERSION,
		};
		expect(parseEmpatraHostCommand(JSON.stringify(response))).toEqual(response);
		expect(parseEmpatraHostMcpOAuthResponseCommand(response)).toEqual(response);
		expect(() =>
			parseEmpatraHostMcpOAuthResponseCommand({
				...response,
				accessToken: "secret",
			}),
		).toThrow(EmpatraHostProtocolError);
		expect(() =>
			parseEmpatraHostMcpOAuthResponseCommand({
				...response,
				status: "completed",
			}),
		).toThrow(EmpatraHostProtocolError);
	});

	test("emits one request and resolves only a matching response", async () => {
		let emitted: EmpatraHostMcpOAuthRequestedEvent | undefined;
		const transport = createEmpatraHostMcpOAuthBrokerTransport({
			capabilities: [EMPATRA_HOST_MCP_OAUTH_CAPABILITY],
			emitRequest: async (event) => {
				emitted = event;
			},
			nextSequence: () => 8,
			requestTimeoutMs: 100,
		});
		const pending = transport.broker.execute({
			...requestWithoutDigest,
			requestId: undefined,
		});
		await Promise.resolve();
		if (!emitted) throw new Error("MCP OAuth event was not emitted");
		expect(emitted.sequence).toBe(8);
		expect(emitted.request.requestSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
		transport.handleResponse({
			capability: EMPATRA_HOST_MCP_OAUTH_CAPABILITY,
			expectedGeneration: emitted.generation,
			generation: emitted.generation,
			id: "response-1",
			requestId: emitted.request.requestId,
			requestSha256: emitted.request.requestSha256,
			status: "completed",
			threadId: emitted.threadId,
			turnId: emitted.turnId,
			type: "mcp_oauth_response",
			version: EMPATRA_HOST_MCP_OAUTH_VERSION,
		});
		await expect(pending).resolves.toEqual({ status: "completed" });
		transport.dispose();
	});

	test("fails closed without negotiated capability and bounds cancellation/timeout", async () => {
		expect(() =>
			createEmpatraHostMcpOAuthBrokerTransport({ emitRequest: async () => {} }),
		).toThrow("not negotiated");
		await expect(
			createFailClosedEmpatraHostMcpOAuthBroker().execute({
				...requestWithoutDigest,
			}),
		).rejects.toMatchObject({
			code: "mcp_oauth_unavailable",
		});

		const controller = new AbortController();
		let emitCount = 0;
		const transport = createEmpatraHostMcpOAuthBrokerTransport({
			capabilities: [EMPATRA_HOST_MCP_OAUTH_CAPABILITY],
			emitRequest: async () => {
				emitCount += 1;
			},
			requestTimeoutMs: 10,
		});
		const aborted = transport.broker.execute(
			requestWithoutDigest,
			controller.signal,
		);
		controller.abort();
		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		const timedOut = transport.broker.execute(requestWithoutDigest);
		await expect(timedOut).rejects.toMatchObject({ code: "mcp_oauth_timeout" });
		expect(emitCount).toBe(2);
		transport.dispose();
	});
});
