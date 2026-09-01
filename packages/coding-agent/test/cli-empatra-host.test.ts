import { describe, expect, it } from "bun:test";
import { applyEmpatraHostPolicy, applyEmpatraHostSessionPolicy, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";

describe("--empatra-host", () => {
	it("parses the valueless flag and applies a fail-closed launch policy", () => {
		const parsed = parseArgs(["--empatra-host", "--mode", "rpc-ui"]);

		expect(parsed.empatraHost).toBe(true);
		expect(parsed.noExtensions).toBe(true);
		expect(parsed.noSkills).toBe(true);
		expect(parsed.noRules).toBe(true);
		expect(parsed.noLsp).toBe(true);
		expect(parsed.noPty).toBe(true);
		expect(parsed.noTitle).toBe(true);
		expect(parsed.autoApprove).toBe(false);
		expect(parsed.approvalMode).toBe("always-ask");
	});

	it("does not mutate the caller's parsed arguments", () => {
		const input = {
			...parseArgs(["--mode", "rpc-ui"]),
			empatraHost: true,
		};
		const result = applyEmpatraHostPolicy(input);

		expect(result).not.toBe(input);
		expect(input.noExtensions).toBeUndefined();
		expect(result.noExtensions).toBe(true);
	});

	it.each([
		[["--empatra-host"], "requires --mode rpc-ui"],
		[["--empatra-host", "--mode", "rpc"], "requires --mode rpc-ui"],
		[["--empatra-host", "--mode", "rpc-ui", "--auto-approve"], "does not allow automatic"],
		[["--empatra-host", "--mode", "rpc-ui", "--yolo"], "does not allow automatic"],
		[["--empatra-host", "--mode", "rpc-ui", "--approval-mode", "write"], "does not allow automatic"],
		[["--empatra-host", "--mode", "rpc-ui", "--approval-mode", "yolo"], "does not allow automatic"],
		[["--empatra-host", "--mode", "rpc-ui", "--extension", "/tmp/ext.ts"], "does not allow --extension"],
		[["--empatra-host", "--mode", "rpc-ui", "--hook", "/tmp/hook.ts"], "does not allow --hook"],
		[
			["--empatra-host", "--mode", "rpc-ui", "--trusted-extension", "/tmp/trusted.ts"],
			"does not allow --trusted-extension",
		],
		[["--empatra-host", "--mode", "rpc-ui", "--plugin-dir", "/tmp/plugin"], "does not allow --plugin-dir"],
		[["--empatra-host", "--mode", "rpc-ui", "--skills", "review"], "does not allow --skills"],
	])("rejects unsafe launch arguments: %j", (argv, message) => {
		expect(() => parseArgs(argv)).toThrow(message);
	});

	it("forces non-discovering session options", () => {
		const options: CreateAgentSessionOptions = {
			autoApprove: true,
			disableExtensionDiscovery: false,
			enableIrc: true,
			enableLsp: true,
			enableMCP: true,
		};

		applyEmpatraHostSessionPolicy({ empatraHost: true }, options);

		expect(options.disableExtensionDiscovery).toBe(true);
		expect(options.additionalExtensionPaths).toEqual([]);
		expect(options.preloadedCustomToolPaths).toEqual([]);
		expect(options.skills).toEqual([]);
		expect(options.rules).toEqual([]);
		expect(options.contextFiles).toEqual([]);
		expect(options.promptTemplates).toEqual([]);
		expect(options.slashCommands).toEqual([]);
		expect(options.enableMCP).toBe(false);
		expect(options.enableIrc).toBe(false);
		expect(options.enableLsp).toBe(false);
		expect(options.restrictToolNames).toBe(true);
		expect(options.toolNames).toEqual([]);
		expect(options.autoApprove).toBe(false);
	});

	it("retains only the host-provided built-in tool allowlist", () => {
		const options: CreateAgentSessionOptions = {};

		applyEmpatraHostSessionPolicy({ empatraHost: true, tools: ["read", "grep"] }, options);

		expect(options.restrictToolNames).toBe(true);
		expect(options.toolNames).toEqual(["read", "grep"]);
	});
});
