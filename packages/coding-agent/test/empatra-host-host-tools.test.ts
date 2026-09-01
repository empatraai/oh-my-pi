import { describe, expect, test } from "bun:test";

import {
	computeEmpatraHostToolCatalogRevision,
	EMPATRA_HOST_TOOL_WATCHDOG_MS,
	EmpatraHostProtocolError,
	type EmpatraHostToolCallFrame,
	type EmpatraHostToolDefinition,
	type EmpatraHostToolOutboundFrame,
	EmpatraHostToolsConnection,
	validateEmpatraHostToolCatalog,
} from "../src/modes/empatra-host";

const definition: EmpatraHostToolDefinition = {
	description: "Executes a desktop-owned operation",
	name: "desktop_action",
	parameters: {
		additionalProperties: false,
		properties: { value: { type: "string" } },
		required: ["value"],
		type: "object",
	},
};

function catalog(tools: readonly EmpatraHostToolDefinition[] = [definition]) {
	const catalogRevision = computeEmpatraHostToolCatalogRevision(tools);
	return { catalogRevision, tools };
}

function callFrame(frames: readonly EmpatraHostToolOutboundFrame[], index = 0): EmpatraHostToolCallFrame {
	const frame = frames.filter(candidate => candidate.type === "host_tool_call")[index];
	if (frame?.type !== "host_tool_call") throw new Error("Expected host_tool_call");
	return frame;
}

describe("Empatra host native tool bridge", () => {
	test("computes canonical revisions and rejects duplicate, malformed, or native-colliding catalogs atomically", () => {
		const first = catalog();
		expect(computeEmpatraHostToolCatalogRevision([{ ...definition, parameters: { type: "object" } }])).toMatch(
			/^sha256:[a-f0-9]{64}$/,
		);
		expect(validateEmpatraHostToolCatalog(first.tools, first.catalogRevision)).toEqual(first.tools);
		const second = { ...definition, name: "another_action", parameters: { properties: {}, type: "object" } };
		expect(computeEmpatraHostToolCatalogRevision([definition, second])).toBe(
			computeEmpatraHostToolCatalogRevision([
				{ ...second, parameters: { type: "object", properties: {} } },
				definition,
			]),
		);
		expect(() => validateEmpatraHostToolCatalog([definition, definition], first.catalogRevision)).toThrow(
			EmpatraHostProtocolError,
		);
		const malformed = [{ ...definition, parameters: { type: "invalid" } }];
		expect(() => validateEmpatraHostToolCatalog(malformed, computeEmpatraHostToolCatalogRevision(malformed))).toThrow(
			"schema",
		);
		const collision = [{ ...definition, name: "read" }];
		expect(() => validateEmpatraHostToolCatalog(collision, computeEmpatraHostToolCatalogRevision(collision))).toThrow(
			"native",
		);
		expect(() => validateEmpatraHostToolCatalog(first.tools, `sha256:${"0".repeat(64)}`)).toThrow("digest");
	});

	test("round-trips exact scoped calls and fails closed on mismatch and replay", async () => {
		const frames: EmpatraHostToolOutboundFrame[] = [];
		const tools = catalog();
		const connection = new EmpatraHostToolsConnection();
		connection.setSink(async frame => {
			frames.push(frame);
		});
		const session = connection.createSession(() => ({
			catalogRevision: tools.catalogRevision,
			generation: 3,
			threadId: "thread-1",
			turnId: "turn-1",
		}));
		const [tool] = session.replaceCatalog(tools.tools, tools.catalogRevision);
		if (!tool) throw new Error("Host tool was not registered");
		const result = tool.execute("provider-call-1", { value: "RAW_LOCAL_ARGUMENT" });
		await Bun.sleep(0);
		const call = callFrame(frames);
		expect(call).toEqual({
			arguments: { value: "RAW_LOCAL_ARGUMENT" },
			catalogRevision: tools.catalogRevision,
			generation: 3,
			id: call.id,
			threadId: "thread-1",
			toolCallId: "provider-call-1",
			toolName: "desktop_action",
			turnId: "turn-1",
			type: "host_tool_call",
		});
		expect(() =>
			connection.handleResult({
				catalogRevision: `sha256:${"0".repeat(64)}`,
				failed: false,
				generation: 3,
				id: call.id,
				result: { content: [{ text: "mismatched", type: "text" }] },
				threadId: "thread-1",
				turnId: "turn-1",
				type: "host_tool_result",
			}),
		).toThrow("mismatched");
		expect(() =>
			connection.handleResult({
				catalogRevision: tools.catalogRevision,
				failed: false,
				generation: 4,
				id: call.id,
				result: { content: [{ text: "mismatched", type: "text" }] },
				threadId: "thread-1",
				turnId: "turn-1",
				type: "host_tool_result",
			}),
		).toThrow("mismatched");
		connection.handleResult({
			catalogRevision: tools.catalogRevision,
			failed: false,
			generation: 3,
			id: call.id,
			result: { content: [{ text: "done", type: "text" }] },
			threadId: "thread-1",
			turnId: "turn-1",
			type: "host_tool_result",
		});
		await expect(result).resolves.toEqual({ content: [{ text: "done", type: "text" }] });
		expect(() =>
			connection.handleResult({
				catalogRevision: tools.catalogRevision,
				failed: false,
				generation: 3,
				id: call.id,
				result: { content: [{ text: "replay", type: "text" }] },
				threadId: "thread-1",
				turnId: "turn-1",
				type: "host_tool_result",
			}),
		).toThrow("replayed");
		const failed = tool.execute("provider-call-failed", { value: "safe" });
		await Bun.sleep(0);
		const failedCall = callFrame(frames, 1);
		connection.handleResult({
			catalogRevision: tools.catalogRevision,
			failed: true,
			generation: 3,
			id: failedCall.id,
			result: { content: [{ text: "Desktop operation failed", type: "text" }] },
			threadId: "thread-1",
			turnId: "turn-1",
			type: "host_tool_result",
		});
		await expect(failed).rejects.toThrow("Desktop operation failed");
		connection.dispose();
	});

	test("supports host cancellation, agent cancellation, and watchdog cancellation exactly once", async () => {
		const frames: EmpatraHostToolOutboundFrame[] = [];
		const watchdogs: Array<() => void> = [];
		const tools = catalog();
		const connection = new EmpatraHostToolsConnection({
			scheduleTimeout(callback, delayMs) {
				expect(delayMs).toBe(EMPATRA_HOST_TOOL_WATCHDOG_MS);
				watchdogs.push(callback);
				return () => {
					const index = watchdogs.indexOf(callback);
					if (index >= 0) watchdogs.splice(index, 1);
				};
			},
		});
		connection.setSink(async frame => {
			frames.push(frame);
		});
		const session = connection.createSession(() => ({
			catalogRevision: tools.catalogRevision,
			generation: 1,
			threadId: "thread-cancel",
			turnId: "turn-cancel",
		}));
		const [tool] = session.replaceCatalog(tools.tools, tools.catalogRevision);
		if (!tool) throw new Error("Host tool was not registered");

		const hostCancelled = tool.execute("provider-host-cancel", { value: "safe" });
		await Bun.sleep(0);
		const first = callFrame(frames, 0);
		connection.handleHostCancel({
			catalogRevision: tools.catalogRevision,
			generation: 1,
			id: "cancel-command-1",
			targetId: first.id,
			threadId: "thread-cancel",
			turnId: "turn-cancel",
			type: "host_tool_cancel",
		});
		await expect(hostCancelled).rejects.toThrow("cancelled");

		const controller = new AbortController();
		const agentCancelled = tool.execute("provider-agent-cancel", { value: "safe" }, controller.signal);
		await Bun.sleep(0);
		controller.abort();
		await expect(agentCancelled).rejects.toThrow("aborted");
		await Bun.sleep(0);
		expect(frames.some(frame => frame.type === "host_tool_cancel")).toBe(true);

		const timedOut = tool.execute("provider-timeout", { value: "safe" });
		await Bun.sleep(0);
		watchdogs.at(-1)?.();
		await expect(timedOut).rejects.toThrow("timed out");
		expect(frames.filter(frame => frame.type === "host_tool_cancel").length).toBeGreaterThanOrEqual(2);
		connection.dispose();
	});

	test("enforces argument and per-turn pending limits without exposing raw arguments in errors", async () => {
		const frames: EmpatraHostToolOutboundFrame[] = [];
		const tools = catalog();
		const connection = new EmpatraHostToolsConnection();
		connection.setSink(async frame => {
			frames.push(frame);
		});
		const session = connection.createSession(() => ({
			catalogRevision: tools.catalogRevision,
			generation: 1,
			threadId: "thread-capacity",
			turnId: "turn-capacity",
		}));
		const [tool] = session.replaceCatalog(tools.tools, tools.catalogRevision);
		if (!tool) throw new Error("Host tool was not registered");
		await expect(tool.execute("oversized", { value: "SECRET_RAW".repeat(30_000) })).rejects.toMatchObject({
			message: expect.not.stringContaining("SECRET_RAW"),
		});
		const pending = Array.from({ length: 16 }, (_, index) =>
			tool.execute(`provider-capacity-${index}`, { value: "safe" }),
		);
		await Bun.sleep(0);
		await expect(tool.execute("provider-capacity-overflow", { value: "SECRET_CAPACITY" })).rejects.toMatchObject({
			message: expect.not.stringContaining("SECRET_CAPACITY"),
		});
		expect(frames.filter(frame => frame.type === "host_tool_call")).toHaveLength(16);
		connection.dispose();
		await Promise.allSettled(pending);
	});

	test("enforces the connection-wide pending limit across independent turns", async () => {
		const tools = catalog();
		const connection = new EmpatraHostToolsConnection();
		connection.setSink(async () => undefined);
		const pending: Promise<unknown>[] = [];
		for (let turn = 0; turn < 4; turn += 1) {
			const session = connection.createSession(() => ({
				catalogRevision: tools.catalogRevision,
				generation: 1,
				threadId: `thread-${turn}`,
				turnId: `turn-${turn}`,
			}));
			const [tool] = session.replaceCatalog(tools.tools, tools.catalogRevision);
			if (!tool) throw new Error("Host tool was not registered");
			for (let call = 0; call < 16; call += 1) {
				pending.push(tool.execute(`provider-${turn}-${call}`, { value: "safe" }));
			}
		}
		await Bun.sleep(0);
		const overflowSession = connection.createSession(() => ({
			catalogRevision: tools.catalogRevision,
			generation: 1,
			threadId: "thread-overflow",
			turnId: "turn-overflow",
		}));
		const [overflowTool] = overflowSession.replaceCatalog(tools.tools, tools.catalogRevision);
		if (!overflowTool) throw new Error("Overflow host tool was not registered");
		await expect(
			overflowTool.execute("provider-overflow", { value: "SECRET_GLOBAL_CAPACITY" }),
		).rejects.toMatchObject({
			code: "host_tool_capacity",
			message: expect.not.stringContaining("SECRET_GLOBAL_CAPACITY"),
		});
		connection.dispose();
		await Promise.allSettled(pending);
	});
});
