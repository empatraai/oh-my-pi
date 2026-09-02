import { describe, expect, test } from "bun:test";

import {
	assertEmpatraHostSubagentCapability,
	createEmpatraHostSubagentTransport,
	createFailClosedEmpatraHostSubagentBroker,
	EMPATRA_HOST_CAPABILITIES,
	EMPATRA_HOST_MAX_SUBAGENT_ASSIGNMENT_BYTES,
	EMPATRA_HOST_SUBAGENT_CAPABILITY,
	EmpatraHostProtocolError,
	parseEmpatraHostSubagentCommand,
	parseEmpatraHostSubagentEvent,
	parseEmpatraHostSubagentResponse,
	type EmpatraHostSubagentCommand,
	type EmpatraHostSubagentEvent,
	type EmpatraHostSubagentTransport,
} from "../src/modes/empatra-host";

const scope = {
	generation: 3,
	parentThreadId: "thread-parent",
	parentTurnId: "turn-parent",
};

describe("Empatra host subagent broker seam", () => {
	test("keeps subagent control reserved until Electron main owns the executor", () => {
		expect(EMPATRA_HOST_SUBAGENT_CAPABILITY).toBe("subagents.lifecycle.v1");
		expect(EMPATRA_HOST_CAPABILITIES).not.toContain(EMPATRA_HOST_SUBAGENT_CAPABILITY);
		expect(() => assertEmpatraHostSubagentCapability([])).toThrow("not negotiated");
	});

	test("parses only the bounded selector and lifecycle contract", () => {
		const spawn: EmpatraHostSubagentCommand = {
			...scope,
			agentName: "scout.readonly",
			assignment: "Проверь безопасную границу выполнения",
			id: "spawn-1",
			modelId: "empatra-gateway/managed",
			type: "subagent_spawn",
		};
		expect(parseEmpatraHostSubagentCommand(spawn)).toEqual(spawn);
		expect(
			parseEmpatraHostSubagentEvent({
				agentName: "scout.readonly",
				childId: "child-1",
				event: "subagent_lifecycle",
				generation: scope.generation,
				index: 0,
				sequence: 1,
				status: "running",
				threadId: scope.parentThreadId,
				turnId: scope.parentTurnId,
				type: "host_event",
			}),
		).toMatchObject({ childId: "child-1", event: "subagent_lifecycle", status: "running" });
	});

	test("rejects path, shell, transcript, and unbounded payload smuggling", () => {
		const command = {
			...scope,
			assignment: "Inspect",
			id: "spawn-1",
			type: "subagent_spawn" as const,
		};
		expect(() => parseEmpatraHostSubagentCommand({ ...command, cwd: "/workspace" })).toThrow("unknown fields");
		expect(() => parseEmpatraHostSubagentCommand({ ...command, env: { TOKEN: "secret" } })).toThrow(
			"unknown fields",
		);
		expect(() => parseEmpatraHostSubagentCommand({ ...command, sessionFile: "/private/transcript.jsonl" })).toThrow(
			"unknown fields",
		);
		expect(() =>
			parseEmpatraHostSubagentCommand({
				...command,
				assignment: "x".repeat(EMPATRA_HOST_MAX_SUBAGENT_ASSIGNMENT_BYTES + 1),
			}),
		).toThrow("assignment");
		expect(() => parseEmpatraHostSubagentCommand({ ...command, agentName: "../escape" })).toThrow("agentName");
	});

	test("validates response projections and excludes raw session paths", () => {
		const response = parseEmpatraHostSubagentResponse({
			data: {
				childId: "child-1",
				index: 0,
				status: "running",
			},
			id: "spawn-1",
			success: true,
			type: "subagent_response",
		});
		expect(response).toMatchObject({ data: { childId: "child-1", status: "running" } });
		expect(() =>
			parseEmpatraHostSubagentResponse({
				data: { childId: "child-1", index: 0, sessionFile: "/secret.jsonl", status: "running" },
				id: "spawn-1",
				success: true,
				type: "subagent_response",
			}),
		).toThrow(EmpatraHostProtocolError);
	});

	test("fails closed without negotiated capability or main-owned executor", async () => {
		const broker = createFailClosedEmpatraHostSubagentBroker();
		await expect(broker.spawn(scope, { assignment: "Inspect" })).rejects.toMatchObject({
			code: "subagent_unavailable",
		});
		expect(() => createEmpatraHostSubagentTransport({ emitCommand: async () => {} })).toThrow("not negotiated");
	});

	test("correlates spawn, steer, interrupt, close, and list through one bounded transport", async () => {
		const commands: EmpatraHostSubagentCommand[] = [];
		let transport: EmpatraHostSubagentTransport;
		transport = createEmpatraHostSubagentTransport({
			capabilities: [EMPATRA_HOST_SUBAGENT_CAPABILITY],
			emitCommand: async command => {
				commands.push(command);
				if (command.type === "subagent_spawn") {
					transport.handleResponse({
						data: { childId: "child-1", index: 0, status: "running" },
						id: command.id,
						success: true,
						type: "subagent_response",
					});
				} else if (command.type === "subagent_list") {
					transport.handleResponse({
						data: { subagents: [] },
						id: command.id,
						success: true,
						type: "subagent_response",
					});
				} else {
					transport.handleResponse({ id: command.id, success: true, type: "subagent_response" });
				}
			},
			nextSequence: () => 4,
		});
		const started = await transport.broker.spawn(scope, { agentName: "task", assignment: "Inspect" });
		await transport.broker.steer(scope, started.childId, "Сфокусируйся на границе");
		await transport.broker.interrupt(scope, started.childId);
		await transport.broker.close(scope, started.childId);
		await expect(transport.broker.list(scope)).resolves.toEqual({ subagents: [] });
		expect(commands.map(command => command.type)).toEqual([
			"subagent_spawn",
			"subagent_steer",
			"subagent_interrupt",
			"subagent_close",
			"subagent_list",
		]);
		const events: EmpatraHostSubagentEvent[] = [];
		const event = {
			childId: started.childId,
			event: "subagent_progress" as const,
			generation: scope.generation,
			threadId: scope.parentThreadId,
			turnId: scope.parentTurnId,
			progress: "Проверка продолжается",
			sequence: 4,
			status: "running" as const,
			type: "host_event" as const,
		};
		transport = createEmpatraHostSubagentTransport({
			capabilities: [EMPATRA_HOST_SUBAGENT_CAPABILITY],
			emitCommand: async () => {},
			onEvent: received => events.push(received),
		});
		transport.handleEvent(event);
		expect(events).toEqual([event]);
		expect(events[0]).not.toBe(event);
		transport.dispose();
	});
});
