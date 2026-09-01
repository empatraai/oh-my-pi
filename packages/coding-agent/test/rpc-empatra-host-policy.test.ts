import { describe, expect, it } from "bun:test";
import { validateEmpatraHostRpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

function policy(command: RpcCommand): string | undefined {
	return validateEmpatraHostRpcCommand(command);
}

describe("Empatra host RPC policy", () => {
	const allowedCommands: RpcCommand[] = [
		{ type: "negotiate_protocol", protocolVersion: 2 },
		{ type: "prompt", message: "Inspect the project" },
		{ type: "steer", message: "Focus on the adapter" },
		{ type: "follow_up", message: "Run the checks" },
		{ type: "abort" },
		{ type: "get_state" },
		{ type: "get_available_commands" },
		{ type: "set_model", provider: "empatra-gateway", modelId: "managed" },
		{ type: "get_available_models" },
		{ type: "compact" },
		{ type: "get_messages_page" },
	];
	for (const command of allowedCommands) {
		it(`allows the bounded host command: ${command.type}`, () => {
			expect(policy(command)).toBeUndefined();
		});
	}

	const blockedCommands: RpcCommand[] = [
		{ type: "bash", command: "pwd" },
		{ type: "abort_bash" },
		{ type: "login", providerId: "openai" },
		{ type: "get_login_providers" },
		{ type: "set_host_tools", tools: [] },
		{ type: "set_host_uri_schemes", schemes: [] },
		{ type: "new_session" },
		{ type: "get_subagents" },
		{ type: "export_html" },
		{ type: "handoff" },
	];
	for (const command of blockedCommands) {
		it(`blocks the unowned RPC command: ${command.type}`, () => {
			expect(policy(command)).toContain("unavailable");
		});
	}

	it.each(["/marketplace install evil", " /mcp add remote", "\t/memory clear", "/login"])(
		"blocks slash dispatch before side effects: %s",
		message => {
			expect(policy({ type: "prompt", message })).toContain("Slash commands");
		},
	);
});
