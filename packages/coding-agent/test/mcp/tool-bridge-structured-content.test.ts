import { describe, expect, it } from "bun:test";

import type { CustomToolContext } from "../../src/extensibility/custom-tools/types";
import { MCPTool } from "../../src/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolCallResult, MCPToolDefinition } from "../../src/mcp/types";

function toolFor(result: MCPToolCallResult): MCPTool {
	const connection = {
		name: "rhizome-mcp",
		transport: {
			request: async (method: string) => {
				if (method === "tools/call") return result as unknown;
				throw new Error(`unexpected method ${method}`);
			},
			close: async () => {},
		},
	} as unknown as MCPServerConnection;
	const definition: MCPToolDefinition = { name: "list_issues", inputSchema: { type: "object" } };
	return new MCPTool(connection, definition);
}

async function modelText(result: MCPToolCallResult): Promise<string> {
	const tool = toolFor(result);
	const built = await tool.execute("call-1", {}, undefined, {} as CustomToolContext);
	return built.content.map(block => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
}

describe("MCP bridge structuredContent", () => {
	it("surfaces structuredContent when content is a minimal ack", async () => {
		// rhizome-mcp shape: terse ack in content, real payload in structuredContent.
		const text = await modelText({
			content: [{ type: "text", text: "issues listed" }],
			structuredContent: {
				items: [],
				next_cursor: null,
				next_actions: ["Inspect a claimable issue with get_work_context."],
			},
		});

		expect(text).toContain("issues listed");
		expect(text).toContain("next_actions");
		expect(text).toContain("Inspect a claimable issue with get_work_context.");
	});

	it("does not duplicate structuredContent already echoed verbatim in a text block", async () => {
		const payload = { lease_token: "abc123", expires_in: 900 };
		const text = await modelText({
			content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
			structuredContent: payload,
		});

		// The token must be reachable exactly once — not appended a second time.
		const occurrences = text.split("abc123").length - 1;
		expect(occurrences).toBe(1);
	});

	it("leaves results without structuredContent untouched", async () => {
		const text = await modelText({ content: [{ type: "text", text: "plain result" }] });
		expect(text).toBe("plain result");
	});
});
