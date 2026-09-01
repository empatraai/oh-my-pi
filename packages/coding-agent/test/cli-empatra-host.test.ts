import { describe, expect, it } from "bun:test";
import {
	applyEmpatraHostPolicy,
	applyEmpatraHostSessionPolicy,
	parseArgs,
	validateEmpatraHostRuntimeEnvironment,
} from "@oh-my-pi/pi-coding-agent/cli/args";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";

const HOST_ARGS = [
	"--empatra-host",
	"--mode",
	"rpc-ui",
	"--no-session",
	"--model",
	"empatra-gateway/test",
	"--system-prompt",
	"Empatra runtime",
];

function hostModel(): NonNullable<CreateAgentSessionOptions["model"]> {
	return {
		id: "test",
		identity: { class: "unknown" },
		name: "Empatra Test",
		api: "openai-responses",
		provider: "empatra-gateway",
		baseUrl: "http://127.0.0.1:4242/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		compat: {},
	} as NonNullable<CreateAgentSessionOptions["model"]>;
}

describe("--empatra-host", () => {
	it("parses the valueless flag and applies a fail-closed launch policy", () => {
		const parsed = parseArgs(HOST_ARGS);

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

	it("rejects boolean assignment syntax for the valueless host flag", () => {
		expect(() => parseArgs(["--empatra-host=true", ...HOST_ARGS.slice(1)])).toThrow("does not take a value");
		expect(() => parseArgs(["--empatra-host=false", ...HOST_ARGS.slice(1)])).toThrow("does not take a value");
	});

	it("does not mutate the caller's parsed arguments", () => {
		const input = {
			...parseArgs([
				"--mode",
				"rpc-ui",
				"--no-session",
				"--model",
				"empatra-gateway/test",
				"--system-prompt",
				"Empatra runtime",
			]),
			empatraHost: true,
		};
		const result = applyEmpatraHostPolicy(input);

		expect(result).not.toBe(input);
		expect(input.noExtensions).toBeUndefined();
		expect(result.noExtensions).toBe(true);
	});

	it.each([
		[["--empatra-host", "--no-session", "--model", "empatra-gateway/test"], "requires --mode rpc-ui"],
		[
			["--empatra-host", "--mode", "rpc", "--no-session", "--model", "empatra-gateway/test"],
			"requires --mode rpc-ui",
		],
		[["--empatra-host", "--mode", "rpc-ui", "--model", "empatra-gateway/test"], "requires --no-session"],
		[["--empatra-host", "--mode", "rpc-ui", "--no-session"], "requires an explicit empatra-gateway"],
		[
			["--empatra-host", "--mode", "rpc-ui", "--no-session", "--model", "empatra-gateway/test"],
			"requires an explicit Empatra-owned --system-prompt",
		],
		[[...HOST_ARGS, "--auto-approve"], "does not allow automatic"],
		[[...HOST_ARGS, "--yolo"], "does not allow automatic"],
		[[...HOST_ARGS, "--approval-mode", "write"], "does not allow automatic"],
		[[...HOST_ARGS, "--approval-mode", "yolo"], "does not allow automatic"],
		[[...HOST_ARGS, "--extension", "/tmp/ext.ts"], "does not allow --extension"],
		[[...HOST_ARGS, "--hook", "/tmp/hook.ts"], "does not allow --hook"],
		[[...HOST_ARGS, "--trusted-extension", "/tmp/trusted.ts"], "does not allow --trusted-extension"],
		[[...HOST_ARGS, "--plugin-dir", "/tmp/plugin"], "does not allow --plugin-dir"],
		[[...HOST_ARGS, "--skills", "review"], "does not allow --skills"],
		[[...HOST_ARGS, "--api-key", "secret"], "does not allow --api-key"],
		[[...HOST_ARGS, "--config", "override.json"], "does not allow --config"],
		[[...HOST_ARGS, "--resume", "session-id"], "does not allow --resume"],
		[[...HOST_ARGS, "--fork", "session-id"], "does not allow --fork"],
		[[...HOST_ARGS, "--plan-yolo", "handoff"], "does not allow --plan-yolo"],
		[[...HOST_ARGS, "--append-system-prompt", "ambient"], "does not allow --append-system-prompt"],
	])("rejects unsafe launch arguments: %j", (argv, message) => {
		expect(() => parseArgs(argv)).toThrow(message);
	});

	it("forces non-discovering session options", () => {
		const options: CreateAgentSessionOptions = {
			model: hostModel(),
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
		const options: CreateAgentSessionOptions = { model: hostModel() };

		applyEmpatraHostSessionPolicy({ empatraHost: true, tools: ["read", "grep"] }, options);

		expect(options.restrictToolNames).toBe(true);
		expect(options.toolNames).toEqual(["read", "grep"]);
	});

	it("requires an isolated absolute runtime directory before storage opens", () => {
		expect(() => validateEmpatraHostRuntimeEnvironment({ empatraHost: true }, {})).toThrow(
			"absolute PI_CODING_AGENT_DIR",
		);
		expect(() =>
			validateEmpatraHostRuntimeEnvironment({ empatraHost: true }, { PI_CODING_AGENT_DIR: "relative" }),
		).toThrow("absolute PI_CODING_AGENT_DIR");
		expect(() =>
			validateEmpatraHostRuntimeEnvironment({ empatraHost: true }, { PI_CODING_AGENT_DIR: "/tmp/empatra-runtime" }),
		).not.toThrow();
	});

	it("rejects non-loopback or non-Responses host models", () => {
		const remote = { ...hostModel(), baseUrl: "https://provider.example/v1" };
		expect(() => applyEmpatraHostSessionPolicy({ empatraHost: true }, { model: remote })).toThrow(
			"must use HTTP loopback",
		);
		const wrongApi = { ...hostModel(), api: "openai-completions" } as NonNullable<CreateAgentSessionOptions["model"]>;
		expect(() => applyEmpatraHostSessionPolicy({ empatraHost: true }, { model: wrongApi })).toThrow(
			"openai-responses",
		);
		const secretUrl = { ...hostModel(), baseUrl: "http://user:secret@127.0.0.1:4242/v1?token=secret" };
		expect(() => applyEmpatraHostSessionPolicy({ empatraHost: true }, { model: secretUrl })).toThrow(
			"must use HTTP loopback",
		);
	});
});
