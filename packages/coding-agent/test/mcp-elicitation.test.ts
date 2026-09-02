import { describe, expect, it } from "bun:test";
import { connectToServer } from "@oh-my-pi/pi-coding-agent/mcp/client";
import {
	elicitationCapabilities,
	parseMCPCreateElicitationRequest,
	validateMCPCreateElicitationResponse,
	type MCPClientElicitationSupport,
} from "@oh-my-pi/pi-coding-agent/mcp/elicitation";

const support: MCPClientElicitationSupport = {
	form: true,
	handler: async () => ({ action: "decline" }),
	url: true,
};

describe("MCP elicitation contract", () => {
	it("advertises only explicitly enabled modes", () => {
		expect(elicitationCapabilities(undefined)).toBeUndefined();
		expect(elicitationCapabilities({ ...support, url: undefined })).toEqual({ form: {} });
		expect(elicitationCapabilities(support)).toEqual({ form: {}, url: {} });
	});

	it("normalizes omitted form mode and preserves a bounded primitive schema", () => {
		const request = parseMCPCreateElicitationRequest({
			message: "Choose a display name",
			requestedSchema: {
				properties: { name: { type: "string", minLength: 1 } },
				required: ["name"],
				type: "object",
			},
		});
		expect(request).toEqual({
			message: "Choose a display name",
			mode: "form",
			requestedSchema: {
				properties: { name: { type: "string", minLength: 1 } },
				required: ["name"],
				type: "object",
			},
		});
		expect(() =>
			parseMCPCreateElicitationRequest({
				message: "nested",
				requestedSchema: { properties: { value: { type: "object" } }, type: "object" },
			}),
		).toThrow(/unsupported type/u);
	});

	it("rejects URL credentials and form values outside the requested schema", () => {
		expect(() =>
			parseMCPCreateElicitationRequest({
				elicitationId: "auth-1",
				message: "Continue",
				mode: "url",
				url: "https://user:password@example.com/login",
			}),
		).toThrow(/without embedded credentials/u);
		const request = parseMCPCreateElicitationRequest({
			message: "name",
			mode: "form",
			requestedSchema: { properties: { name: { type: "string" } }, type: "object" },
		});
		expect(() =>
			validateMCPCreateElicitationResponse({ action: "accept", content: { secret: "x" } }, request),
		).toThrow(/content is invalid/u);
		expect(validateMCPCreateElicitationResponse({ action: "accept", content: { name: "Ada" } }, request)).toEqual({
			action: "accept",
			content: { name: "Ada" },
		});
	});

	it("never allows content in URL or declined responses", () => {
		const urlRequest = parseMCPCreateElicitationRequest({
			elicitationId: "auth-1",
			message: "Open the secure sign-in page",
			mode: "url",
			url: "https://example.com/login",
		});
		expect(validateMCPCreateElicitationResponse({ action: "accept" }, urlRequest)).toEqual({ action: "accept" });
		expect(() => validateMCPCreateElicitationResponse({ action: "decline", content: {} }, urlRequest)).toThrow(
			/declined elicitation cannot include content/u,
		);
	});

	it("negotiates form capability and routes a server request through the explicit handler", async () => {
		const requested = Promise.withResolvers<{ serverName: string; message: string }>();
		const server = [
			"let buffer = '';",
			"const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
			"for await (const chunk of Bun.stdin.stream()) {",
			"  buffer += new TextDecoder().decode(chunk);",
			"  let index = buffer.indexOf('\\n');",
			"  while (index >= 0) {",
			"    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); index = buffer.indexOf('\\n');",
			"    if (!line) continue;",
			"    const message = JSON.parse(line);",
			"    if (message.method === 'initialize') { send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {}, protocolVersion: '2025-11-25', serverInfo: { name: 'fixture', version: '1.0.0' } } }); }",
			"    if (message.method === 'notifications/initialized') { send({ jsonrpc: '2.0', id: 901, method: 'elicitation/create', params: { message: 'Choose a name', requestedSchema: { properties: { name: { type: 'string' } }, type: 'object' } } }); }",
			"  }",
			"}",
		].join("\n");
		const connection = await connectToServer(
			"fixture-server",
			{ args: ["-e", server], command: process.execPath, type: "stdio" },
			{
				elicitation: {
					form: true,
					handler: async (request, context) => {
						if (request.mode !== "form") throw new Error("expected form request");
						requested.resolve({ message: request.message, serverName: context.serverName });
						return { action: "accept", content: { name: "Ada" } };
					},
				},
			},
		);
		try {
			expect(
				await Promise.race([
					requested.promise,
					Bun.sleep(1_000).then(() => {
						throw new Error("elicitation timed out");
					}),
				]),
			).toEqual({ message: "Choose a name", serverName: "fixture-server" });
		} finally {
			await connection.transport.close();
		}
	});
});
