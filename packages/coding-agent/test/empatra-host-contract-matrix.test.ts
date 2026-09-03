import { expect, test } from "bun:test";

import {
	computeEmpatraHostToolCatalogRevision,
	EMPATRA_HOST_CAPABILITIES,
	type EmpatraHostCommand,
	type EmpatraHostInitializeCommand,
	type EmpatraHostRuntime,
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

function initialize(): EmpatraHostInitializeCommand {
	return {
		capability: "c".repeat(48),
		gatewayBaseUrl: "http://127.0.0.1:43123/v1",
		id: "matrix-initialize",
		models: [
			{
				api: "openai-responses",
				contextWindow: 200_000,
				id: "managed-model",
				input: ["text"],
				maxTokens: 32_000,
				name: "Managed Model",
				reasoning: true,
				supportsTools: true,
			},
		],
		protocolVersion: 6,
		sessionDirectory: "/tmp/empatra-omp-contract-matrix",
		type: "host_initialize",
		workspaceRoots: ["/tmp/workspace"],
	};
}

function runtime(calls: string[]): EmpatraHostRuntime {
	const called = (name: string) => async (command: EmpatraHostCommand) => {
		calls.push(`${name}:${command.type}`);
		return { commandType: command.type };
	};
	return {
		archiveThread: called("archive"),
		clearThreadGoal: called("goal-clear"),
		compactThread: called("compact"),
		deleteThread: called("delete"),
		dispose: async () => undefined,
		getAtomicOperationStatus: called("atomic-status"),
		getModelRouting: called("model-routing-read"),
		initialize: async () => ({ initialized: true }),
		handleExecutionBrokerResponse: command => calls.push(`execution:${command.type}`),
		handleHostToolCancel: command => calls.push(`tool-cancel:${command.type}`),
		handleHostToolResult: command => calls.push(`tool-result:${command.type}`),
		noteInteractionActivity: called("interaction-activity"),
		cancelInteraction: called("interaction-cancel"),
		respondToInteraction: called("interaction-respond"),
		resolvePlan: called("plan-resolution"),
		forkThread: called("fork"),
		forkThreadAndStart: called("fork-start"),
		getThreadGoal: called("goal-get"),
		interruptTurn: called("interrupt"),
		listThreads: called("list"),
		listThreadTurns: called("turns"),
		readThread: called("read"),
		renameThread: called("rename"),
		rollbackThread: called("rollback"),
		setEventSink: () => undefined,
		setHostToolSink: () => undefined,
		replaceHostTools: called("tools-replace"),
		setThreadGoal: called("goal-set"),
		startThread: called("create"),
		startThreadAndTurn: called("create-start"),
		startTurn: called("turn-start"),
		steerTurn: called("steer"),
		updateModelRouting: called("model-routing-write"),
		unarchiveThread: called("unarchive"),
	};
}

test("Studio v6 host command matrix remains dispatchable through the OMP boundary", async () => {
	const calls: string[] = [];
	const revision = computeEmpatraHostToolCatalogRevision([
		{ description: "Desktop operation", name: "desktop_action", parameters: { type: "object" } },
	]);
	const identity = {
		digest: `sha256:${"a".repeat(64)}`,
		expectedGeneration: 1,
		requestId: "interaction-request",
		threadId: "thread-1",
		turnId: "turn-1",
	};
	const commands: readonly EmpatraHostCommand[] = [
		initialize(),
		{
			id: "create",
			cwd: "/tmp/workspace",
			modelId: "managed-model",
			operationId: "op-create",
			systemPrompt: "System",
			type: "thread_create",
		},
		{
			id: "create-start",
			cwd: "/tmp/workspace",
			message: "Start",
			modelId: "managed-model",
			operationId: "op-create-start",
			systemPrompt: "System",
			turnId: "turn-create-start",
			type: "thread_create_and_start",
		},
		{ id: "fork", operationId: "op-fork", threadId: "thread-1", type: "thread_fork" },
		{
			id: "fork-start",
			message: "Start fork",
			operationId: "op-fork-start",
			threadId: "thread-1",
			turnId: "turn-fork-start",
			type: "thread_fork_and_start",
		},
		{ id: "rollback", threadId: "thread-1", turns: 1, type: "thread_rollback" },
		{ id: "compact", threadId: "thread-1", type: "thread_compact" },
		{ id: "archive", threadId: "thread-1", type: "thread_archive" },
		{ id: "unarchive", threadId: "thread-1", type: "thread_unarchive" },
		{ id: "delete", threadId: "thread-1", type: "thread_delete" },
		{ id: "rename", threadId: "thread-1", title: "Проект", type: "thread_rename" },
		{ archived: false, id: "list", limit: 20, offset: 0, type: "thread_list" },
		{ id: "read", limit: 20, threadId: "thread-1", type: "thread_read" },
		{ id: "turns", limit: 20, threadId: "thread-1", type: "thread_turns" },
		{ id: "atomic-status", operationId: "op-create", type: "atomic_operation_status" },
		{ id: "goal-get", threadId: "thread-1", type: "goal_get" },
		{ id: "goal-set", objective: "Цель", threadId: "thread-1", type: "goal_set" },
		{ id: "goal-clear", threadId: "thread-1", type: "goal_clear" },
		{
			expectedGeneration: 0,
			id: "turn-start",
			message: "Продолжи",
			threadId: "thread-1",
			turnId: "turn-1",
			type: "turn_start",
		},
		{ expectedGeneration: 1, id: "interrupt", threadId: "thread-1", turnId: "turn-1", type: "turn_interrupt" },
		{
			expectedGeneration: 1,
			id: "steer",
			message: "Уточнение",
			threadId: "thread-1",
			turnId: "turn-1",
			type: "turn_steer",
		},
		{ ...identity, id: "interaction-activity", turnId: "turn-activity", type: "interaction_activity" },
		{ ...identity, id: "interaction-cancel", turnId: "turn-cancel", type: "interaction_cancel" },
		{
			...identity,
			id: "interaction-respond",
			response: { decision: "approve", kind: "approval_response" },
			turnId: "turn-respond",
			type: "interaction_respond",
		},
		{ action: "approve", ...identity, id: "plan-resolution", turnId: "turn-plan", type: "plan_resolution" },
		{
			catalogRevision: revision,
			id: "tools-replace",
			tools: [{ description: "Desktop operation", name: "desktop_action", parameters: { type: "object" } }],
			type: "host_tools_replace",
		},
		{
			catalogRevision: revision,
			failed: false,
			generation: 1,
			id: "tool-result",
			result: { content: [{ text: "done", type: "text" }] },
			threadId: "thread-1",
			turnId: "turn-1",
			type: "host_tool_result",
		},
		{
			catalogRevision: revision,
			generation: 1,
			id: "tool-cancel",
			targetId: "tool-result",
			threadId: "thread-1",
			turnId: "turn-1",
			type: "host_tool_cancel",
		},
		{
			generation: 1,
			id: "execution",
			operation: "filesystem.read",
			result: { operation: "filesystem.read", output: "ok", outputTruncated: false },
			threadId: "thread-1",
			turnId: "turn-1",
			type: "execution_broker_response",
		},
		{ id: "matrix-shutdown", type: "host_shutdown" },
	];
	const output: string[] = [];
	await runEmpatraHostServer({
		input: inputStream(commands),
		runtime: runtime(calls),
		write: async frame => {
			output.push(frame);
		},
	});

	const frames = output.map(frame => JSON.parse(frame) as Record<string, unknown>);
	for (const command of commands.slice(1, -1)) {
		if (
			command.type === "host_tool_result" ||
			command.type === "host_tool_cancel" ||
			command.type === "execution_broker_response"
		)
			continue;
		expect(frames.find(frame => frame.id === command.id)).toMatchObject({ id: command.id, success: true });
	}
	expect(frames.find(frame => frame.id === "matrix-shutdown")).toMatchObject({ success: true });
	expect(frames[0]).toMatchObject({ capabilities: EMPATRA_HOST_CAPABILITIES, protocolVersion: 6, type: "host_ready" });
	for (const type of [
		"thread_create",
		"thread_create_and_start",
		"thread_fork",
		"thread_fork_and_start",
		"thread_rollback",
		"thread_compact",
		"thread_archive",
		"thread_unarchive",
		"thread_delete",
		"thread_rename",
		"thread_list",
		"thread_read",
		"thread_turns",
		"atomic_operation_status",
		"goal_get",
		"goal_set",
		"goal_clear",
		"turn_start",
		"turn_interrupt",
		"turn_steer",
		"interaction_activity",
		"interaction_cancel",
		"interaction_respond",
		"plan_resolution",
		"host_tools_replace",
	])
		expect(calls).toContainEqual(expect.stringContaining(`:${type}`));
	expect(calls).toContain("tool-result:host_tool_result");
	expect(calls).toContain("tool-cancel:host_tool_cancel");
	expect(calls).toContain("execution:execution_broker_response");
});

test("host command matrix does not permit accidental ambient fields", async () => {
	const output: string[] = [];
	await runEmpatraHostServer({
		input: inputStream([{ ...initialize(), ambientConfig: true }]),
		runtime: runtime([]),
		write: async frame => {
			output.push(frame);
		},
	});
	expect(output.map(frame => JSON.parse(frame))).toContainEqual(
		expect.objectContaining({ code: "invalid_request", id: null, success: false }),
	);
});
