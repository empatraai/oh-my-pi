import { describe, expect, test } from "bun:test";

import {
	type EmpatraHostEvent,
	type EmpatraHostInitializeCommand,
	EmpatraHostProtocolError,
	type EmpatraHostRuntime,
	type EmpatraHostToolOutboundFrame,
	runEmpatraHostServer,
} from "../src/modes/empatra-host";

const encoder = new TextEncoder();

function inputStream(frames: readonly unknown[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const frame of frames) controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
			controller.close();
		},
	});
}

function initializeCommand(): EmpatraHostInitializeCommand {
	return {
		capability: "c".repeat(48),
		gatewayBaseUrl: "http://127.0.0.1:43123/v1",
		id: "initialize-1",
		models: [
			{
				api: "openai-responses",
				contextWindow: 200_000,
				id: "managed-model",
				input: ["text", "image"],
				maxTokens: 32_000,
				name: "Managed Model",
				reasoning: true,
				supportsTools: true,
			},
		],
		protocolVersion: 4,
		sessionDirectory: "/tmp/empatra-omp-sessions",
		type: "host_initialize",
		workspaceRoots: ["/tmp/workspace"],
	};
}

function runtime(overrides: Partial<EmpatraHostRuntime> = {}): EmpatraHostRuntime {
	return {
		async archiveThread() {
			return { archived: true };
		},
		async clearThreadGoal() {
			return { cleared: true };
		},
		async compactThread() {
			return { compacted: true };
		},
		async deleteThread() {
			return { deleted: true };
		},
		async dispose() {},
		async initialize() {
			return { initialized: true };
		},
		handleHostToolCancel() {},
		handleHostToolResult() {},
		async noteInteractionActivity() {
			return { expiresAt: 1 };
		},
		async cancelInteraction() {
			return { cancelled: true };
		},
		async respondToInteraction() {
			return { accepted: true };
		},
		async forkThread() {
			return { threadId: "thread-fork" };
		},
		async forkThreadAndStart() {
			return { threadId: "thread-fork", turnId: "turn-1" };
		},
		async getThreadGoal() {
			return { goal: null };
		},
		async interruptTurn() {
			return { interrupted: true };
		},
		async listThreads() {
			return { threads: [] };
		},
		async listThreadTurns() {
			return { backwardsCursor: null, data: [], nextCursor: null };
		},
		async readThread() {
			return { thread: null };
		},
		async renameThread() {
			return { renamed: true };
		},
		async rollbackThread() {
			return { rolledBack: true };
		},
		setEventSink() {},
		setHostToolSink() {},
		async replaceHostTools() {
			return { toolNames: [] };
		},
		async setThreadGoal() {
			return { goal: null };
		},
		async startThread() {
			return { threadId: "thread-1" };
		},
		async startThreadAndTurn() {
			return { threadId: "thread-1", turnId: "turn-1" };
		},
		async startTurn() {
			return { turnId: "turn-1" };
		},
		async steerTurn() {
			return { steered: true };
		},
		async unarchiveThread() {
			return { archived: false };
		},
		...overrides,
	};
}

describe("Empatra host protocol server", () => {
	test("writes turn acceptance before the first event and bounds the activation barrier", async () => {
		let sink: ((event: EmpatraHostEvent) => Promise<void>) | undefined;
		let deliveries: PromiseSettledResult<void>[] = [];
		const output: string[] = [];
		await runEmpatraHostServer({
			input: inputStream([
				initializeCommand(),
				{
					expectedGeneration: 0,
					id: "turn-start-barrier",
					message: "Implement",
					threadId: "thread-barrier",
					turnId: "turn-barrier",
					type: "turn_start",
				},
				{ id: "shutdown-barrier", type: "host_shutdown" },
			]),
			runtime: runtime({
				setEventSink(next) {
					sink = next;
				},
				async startTurn() {
					if (!sink) throw new Error("event sink is missing");
					const events = [1, 2, 3].map(sequence =>
						sink?.({
							contentIndex: 0,
							delta: "x".repeat(700_000),
							event: "turn_output",
							generation: 1,
							kind: "text_delta",
							messageIndex: 0,
							sequence,
							threadId: "thread-barrier",
							turnId: "turn-barrier",
							type: "host_event",
						}),
					);
					void Promise.allSettled(events).then(result => {
						deliveries = result;
					});
					return { generation: 1, threadId: "thread-barrier", turnId: "turn-barrier" };
				},
			}),
			write: async frame => {
				output.push(frame);
			},
		});

		const frames = output.map(frame => JSON.parse(frame));
		const responseIndex = frames.findIndex(frame => frame.id === "turn-start-barrier");
		const eventIndex = frames.findIndex(frame => frame.event === "turn_output");
		expect(responseIndex).toBeGreaterThan(-1);
		expect(eventIndex).toBeGreaterThan(responseIndex);
		expect(deliveries.filter(result => result.status === "fulfilled")).toHaveLength(2);
		const rejected = deliveries.find(result => result.status === "rejected");
		expect(rejected).toMatchObject({ reason: { code: "event_backpressure" }, status: "rejected" });
	});

	test("writes turn acceptance before a raw host tool call and treats correlated completion as one-way", async () => {
		let hostToolSink: ((frame: EmpatraHostToolOutboundFrame) => Promise<void>) | undefined;
		let delivery: Promise<void> | undefined;
		const handledResults: string[] = [];
		const output: string[] = [];
		const catalogRevision = `sha256:${"a".repeat(64)}`;
		await runEmpatraHostServer({
			input: inputStream([
				initializeCommand(),
				{
					catalogRevision,
					id: "catalog-1",
					tools: [
						{
							description: "Desktop operation",
							name: "desktop_action",
							parameters: { properties: {}, type: "object" },
						},
					],
					type: "host_tools_replace",
				},
				{
					expectedGeneration: 0,
					id: "turn-host-tool",
					message: "Use desktop_action",
					threadId: "thread-host-tool",
					turnId: "turn-host-tool",
					type: "turn_start",
				},
				{
					catalogRevision,
					failed: false,
					generation: 1,
					id: "host-call-1",
					result: { content: [{ text: "done", type: "text" }] },
					threadId: "thread-host-tool",
					turnId: "turn-host-tool",
					type: "host_tool_result",
				},
				{ id: "shutdown-host-tool", type: "host_shutdown" },
			]),
			runtime: runtime({
				handleHostToolResult(frame) {
					handledResults.push(frame.id);
				},
				setHostToolSink(next) {
					hostToolSink = next;
				},
				async startTurn() {
					if (!hostToolSink) throw new Error("host tool sink is missing");
					delivery = hostToolSink({
						arguments: { localSecret: "RAW_LOCAL_ONLY" },
						catalogRevision,
						generation: 1,
						id: "host-call-1",
						threadId: "thread-host-tool",
						toolCallId: "provider-call-1",
						toolName: "desktop_action",
						turnId: "turn-host-tool",
						type: "host_tool_call",
					});
					return { generation: 1, threadId: "thread-host-tool", turnId: "turn-host-tool" };
				},
			}),
			write: async frame => {
				output.push(frame);
			},
		});
		await delivery;
		const frames = output.map(frame => JSON.parse(frame));
		expect(frames.findIndex(frame => frame.id === "turn-host-tool")).toBeLessThan(
			frames.findIndex(frame => frame.type === "host_tool_call"),
		);
		expect(handledResults).toEqual(["host-call-1"]);
		expect(frames.filter(frame => frame.type === "host_response" && frame.id === "host-call-1")).toHaveLength(0);
	});

	test("holds atomic turn events until the generated thread identity is accepted", async () => {
		let sink: ((event: EmpatraHostEvent) => Promise<void>) | undefined;
		let delivery: Promise<void> | undefined;
		const output: string[] = [];
		await runEmpatraHostServer({
			input: inputStream([
				initializeCommand(),
				{
					cwd: "/tmp/workspace",
					id: "atomic-barrier",
					message: "Implement",
					modelId: "managed-model",
					operationId: "operation-atomic-barrier",
					systemPrompt: "System",
					turnId: "turn-atomic-barrier",
					type: "thread_create_and_start",
				},
				{ id: "shutdown-atomic-barrier", type: "host_shutdown" },
			]),
			runtime: runtime({
				setEventSink(next) {
					sink = next;
				},
				async startThreadAndTurn() {
					if (!sink) throw new Error("event sink is missing");
					delivery = sink({
						contentIndex: 0,
						delta: "first",
						event: "turn_output",
						generation: 1,
						kind: "text_delta",
						messageIndex: 0,
						sequence: 1,
						threadId: "generated-thread-id",
						turnId: "turn-atomic-barrier",
						type: "host_event",
					});
					return { generation: 1, threadId: "generated-thread-id", turnId: "turn-atomic-barrier" };
				},
			}),
			write: async frame => {
				output.push(frame);
			},
		});
		await delivery;
		const frames = output.map(frame => JSON.parse(frame));
		expect(frames.findIndex(frame => frame.id === "atomic-barrier")).toBeLessThan(
			frames.findIndex(frame => frame.event === "turn_output"),
		);
	});

	test("writes an interaction response before resumed turn events", async () => {
		let sink: ((event: EmpatraHostEvent) => Promise<void>) | undefined;
		const output: string[] = [];
		await runEmpatraHostServer({
			input: inputStream([
				initializeCommand(),
				{
					digest: `sha256:${"1".repeat(64)}`,
					expectedGeneration: 1,
					id: "interaction-response-1",
					requestId: "interaction-1",
					response: { inputKind: "confirm", kind: "user_input_response", value: true },
					threadId: "thread-1",
					turnId: "turn-1",
					type: "interaction_respond",
				},
				{ id: "shutdown-interaction", type: "host_shutdown" },
			]),
			runtime: runtime({
				setEventSink(next) {
					sink = next;
				},
				async respondToInteraction() {
					if (!sink) throw new Error("event sink is missing");
					void sink({
						contentIndex: 0,
						delta: "resumed",
						event: "turn_output",
						generation: 1,
						kind: "text_delta",
						messageIndex: 0,
						sequence: 2,
						threadId: "thread-1",
						turnId: "turn-1",
						type: "host_event",
					});
					return { accepted: true };
				},
			}),
			write: async frame => {
				output.push(frame);
			},
		});
		const frames = output.map(frame => JSON.parse(frame));
		const responseIndex = frames.findIndex(frame => frame.id === "interaction-response-1");
		const eventIndex = frames.findIndex(frame => frame.event === "turn_output" && frame.delta === "resumed");
		expect(responseIndex).toBeGreaterThan(-1);
		expect(eventIndex).toBeGreaterThan(responseIndex);
	});

	test("requires bootstrap before thread commands and shuts down cleanly", async () => {
		let disposed = 0;
		const output: string[] = [];
		await runEmpatraHostServer({
			input: inputStream([
				{ id: "list-before-init", limit: 50, offset: 0, type: "thread_list" },
				initializeCommand(),
				{ id: "list-after-init", limit: 50, offset: 0, type: "thread_list" },
				{ id: "shutdown-1", type: "host_shutdown" },
			]),
			runtime: runtime({
				async dispose() {
					disposed += 1;
				},
			}),
			write: async frame => {
				output.push(frame);
			},
		});

		const frames = output.map(frame => JSON.parse(frame));
		expect(frames[0]).toMatchObject({ protocolVersion: 3, type: "host_ready" });
		expect(frames.find(frame => frame.id === "list-before-init")).toMatchObject({
			code: "not_initialized",
			success: false,
		});
		expect(frames.find(frame => frame.id === "list-after-init")).toMatchObject({
			data: { threads: [] },
			success: true,
		});
		expect(frames.find(frame => frame.id === "shutdown-1")).toMatchObject({ success: true });
		expect(disposed).toBe(1);
	});

	test("keeps reading correlated interrupt commands while a turn is running", async () => {
		const turnFinished = Promise.withResolvers<void>();
		const output: string[] = [];
		await runEmpatraHostServer({
			input: inputStream([
				initializeCommand(),
				{
					expectedGeneration: 0,
					id: "turn-start-1",
					message: "Implement",
					threadId: "thread-1",
					turnId: "turn-1",
					type: "turn_start",
				},
				{
					expectedGeneration: 1,
					id: "turn-interrupt-1",
					threadId: "thread-1",
					turnId: "turn-1",
					type: "turn_interrupt",
				},
				{ id: "shutdown-1", type: "host_shutdown" },
			]),
			runtime: runtime({
				async interruptTurn() {
					turnFinished.resolve();
					return { interrupted: true };
				},
				async startTurn() {
					await turnFinished.promise;
					return { turnId: "turn-1" };
				},
			}),
			write: async frame => {
				output.push(frame);
			},
		});

		const responses = output.map(frame => JSON.parse(frame)).filter(frame => frame.type === "host_response");
		expect(responses.find(frame => frame.id === "turn-start-1")).toMatchObject({ success: true });
		expect(responses.find(frame => frame.id === "turn-interrupt-1")).toMatchObject({ success: true });
	});

	test("dispatches every thread lifecycle command through the typed runtime boundary", async () => {
		const calls: string[] = [];
		const output: string[] = [];
		await runEmpatraHostServer({
			input: inputStream([
				initializeCommand(),
				{
					id: "fork-1",
					operationId: "operation-fork-1",
					threadId: "thread-1",
					type: "thread_fork",
				},
				{ id: "compact-1", threadId: "thread-1", type: "thread_compact" },
				{ id: "rename-1", threadId: "thread-1", title: "Проект", type: "thread_rename" },
				{ id: "archive-1", threadId: "thread-1", type: "thread_archive" },
				{ id: "unarchive-1", threadId: "thread-1", type: "thread_unarchive" },
				{ id: "delete-1", threadId: "thread-1", type: "thread_delete" },
				{ id: "shutdown-1", type: "host_shutdown" },
			]),
			runtime: runtime({
				async archiveThread() {
					calls.push("archive");
				},
				async deleteThread() {
					calls.push("delete");
				},
				async compactThread() {
					calls.push("compact");
				},
				async forkThread() {
					calls.push("fork");
				},
				async renameThread() {
					calls.push("rename");
				},
				async unarchiveThread() {
					calls.push("unarchive");
				},
			}),
			write: async frame => {
				output.push(frame);
			},
		});

		expect(new Set(calls)).toEqual(new Set(["fork", "compact", "rename", "archive", "unarchive", "delete"]));
		const responses = output.map(frame => JSON.parse(frame));
		for (const id of ["fork-1", "compact-1", "rename-1", "archive-1", "unarchive-1", "delete-1"]) {
			expect(responses.find(frame => frame.id === id)).toMatchObject({ success: true });
		}
	});

	test("dispatches turn history and goal CRUD through the native runtime boundary", async () => {
		const calls: string[] = [];
		const output: string[] = [];
		await runEmpatraHostServer({
			input: inputStream([
				initializeCommand(),
				{ id: "turns-1", limit: 25, threadId: "thread-1", type: "thread_turns" },
				{ id: "goal-get-1", threadId: "thread-1", type: "goal_get" },
				{ id: "goal-set-1", objective: "Цель", threadId: "thread-1", type: "goal_set" },
				{ id: "goal-clear-1", threadId: "thread-1", type: "goal_clear" },
				{ id: "shutdown-1", type: "host_shutdown" },
			]),
			runtime: runtime({
				async clearThreadGoal() {
					calls.push("goal-clear");
				},
				async getThreadGoal() {
					calls.push("goal-get");
				},
				async listThreadTurns() {
					calls.push("thread-turns");
				},
				async setThreadGoal() {
					calls.push("goal-set");
				},
			}),
			write: async frame => {
				output.push(frame);
			},
		});

		expect(new Set(calls)).toEqual(new Set(["thread-turns", "goal-get", "goal-set", "goal-clear"]));
		const responses = output.map(frame => JSON.parse(frame));
		for (const id of ["turns-1", "goal-get-1", "goal-set-1", "goal-clear-1"]) {
			expect(responses.find(frame => frame.id === id)).toMatchObject({ success: true });
		}
	});

	test("does not serialize raw runtime error messages", async () => {
		const protocolSecret = "SECRET_SENTINEL_protocol_failure";
		const runtimeSecret = "SECRET_SENTINEL_runtime_failure";
		const output: string[] = [];
		await runEmpatraHostServer({
			input: inputStream([
				initializeCommand(),
				{ id: "list-secret", limit: 50, offset: 0, type: "thread_list" },
				{ id: "read-secret", limit: 50, threadId: "thread-1", type: "thread_read" },
				{ id: "shutdown-secret", type: "host_shutdown" },
			]),
			runtime: runtime({
				async listThreads() {
					throw new Error(`Provider rejected ${runtimeSecret}`);
				},
				async readThread() {
					throw new EmpatraHostProtocolError("workspace_unavailable", `Workspace path included ${protocolSecret}`);
				},
			}),
			write: async frame => {
				output.push(frame);
			},
		});

		const serialized = output.join("");
		expect(serialized).not.toContain(protocolSecret);
		expect(serialized).not.toContain(runtimeSecret);
		expect(output.map(frame => JSON.parse(frame)).find(frame => frame.id === "list-secret")).toMatchObject({
			code: "runtime_error",
			error: "OMP host operation failed",
			success: false,
		});
		expect(output.map(frame => JSON.parse(frame)).find(frame => frame.id === "read-secret")).toMatchObject({
			code: "workspace_unavailable",
			error: "The authorized workspace is unavailable",
			success: false,
		});
	});

	test("rejects duplicate in-flight request ids without dispatching twice", async () => {
		const finish = Promise.withResolvers<void>();
		let starts = 0;
		const output: string[] = [];
		const turn = {
			expectedGeneration: 0,
			id: "duplicate-id",
			message: "Implement",
			threadId: "thread-1",
			turnId: "turn-1",
			type: "turn_start",
		};
		await runEmpatraHostServer({
			input: inputStream([initializeCommand(), turn, turn, { id: "shutdown-1", type: "host_shutdown" }]),
			runtime: runtime({
				async startTurn() {
					starts += 1;
					finish.resolve();
					await finish.promise;
					return { turnId: "turn-1" };
				},
			}),
			write: async frame => {
				output.push(frame);
			},
		});

		const responses = output.map(frame => JSON.parse(frame));
		expect(starts).toBe(1);
		expect(responses.find(frame => frame.code === "duplicate_request")).toBeDefined();
	});
});
