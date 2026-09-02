import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	computeEmpatraHostToolCatalogRevision,
	EMPATRA_HOST_MAX_FRAME_BYTES,
	EMPATRA_HOST_THREAD_READ_TARGET_BYTES,
	EMPATRA_HOST_TOOL_ENTRY,
	EMPATRA_HOST_TOOL_ENTRY_VERSION,
	EmpatraHostAgentRuntime,
	type EmpatraHostEvent,
	type EmpatraHostInitializeCommand,
	type EmpatraHostPersistedToolEvent,
	EmpatraHostProtocolError,
	type EmpatraHostSession,
	type EmpatraHostSessionFactoryOptions,
	type EmpatraHostToolCallFrame,
	serializeEmpatraHostFrame,
} from "../src/modes/empatra-host";
import type { AgentSessionEvent } from "../src/session/agent-session-events";

const temporaryRoots: string[] = [];

async function temporaryHost() {
	const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "empatra-omp-host-"));
	temporaryRoots.push(root);
	const workspace = path.join(root, "workspace");
	const sessions = path.join(root, "sessions");
	await mkdir(workspace);
	return { root, sessions, workspace };
}

function initializeCommand(workspace: string, sessionDirectory: string): EmpatraHostInitializeCommand {
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
		protocolVersion: 5,
		sessionDirectory,
		type: "host_initialize",
		workspaceRoots: [workspace],
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	usage: Partial<AssistantMessage["usage"]> = {},
): AssistantMessage {
	return {
		api: "openai-responses",
		completedAt: 1_000,
		content,
		model: "SECRET_UPSTREAM_MODEL",
		provider: "empatra-gateway",
		responseId: "SECRET_RESPONSE_ID",
		role: "assistant",
		stopReason: "stop",
		timestamp: 900,
		usage: {
			cacheRead: 0,
			cacheWrite: 0,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
			input: 0,
			output: 0,
			totalTokens: 0,
			...usage,
		},
	};
}

class FakeSession implements EmpatraHostSession {
	compacted = 0;
	disposed = 0;
	listener?: (event: AgentSessionEvent) => void;
	onAbort?: () => void;
	onCompact?: () => Promise<void>;
	onPrompt?: () => Promise<void>;
	onSteer?: (message: string) => Promise<void>;
	rpcTools: AgentTool[] = [];
	nativeToolNames: string[] = [];

	async abort(): Promise<void> {
		this.onAbort?.();
	}

	async compact(): Promise<void> {
		await this.onCompact?.();
		this.compacted += 1;
	}

	async dispose(): Promise<void> {
		this.disposed += 1;
	}

	async prompt(): Promise<void> {
		await this.onPrompt?.();
	}

	getAllToolNames(): string[] {
		return [...this.nativeToolNames, ...this.rpcTools.map(tool => tool.name)];
	}

	async refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		this.rpcTools = [...rpcTools];
	}

	async steer(message: string): Promise<void> {
		await this.onSteer?.(message);
	}

	emit(event: AgentSessionEvent): void {
		this.listener?.(event);
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listener = listener;
		return () => {
			if (this.listener === listener) this.listener = undefined;
		};
	}
}

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("Empatra host AgentSession runtime", () => {
	test("holds exclusive process authority for a private session CAS until dispose", async () => {
		const host = await temporaryHost();
		const first = new EmpatraHostAgentRuntime({ sessionFactory: async () => new FakeSession() });
		const competing = new EmpatraHostAgentRuntime({ sessionFactory: async () => new FakeSession() });
		await first.initialize(initializeCommand(host.workspace, host.sessions));
		await expect(competing.initialize(initializeCommand(host.workspace, host.sessions))).rejects.toMatchObject({
			code: "runtime_error",
		});
		await first.dispose();

		const successor = new EmpatraHostAgentRuntime({ sessionFactory: async () => new FakeSession() });
		await successor.initialize(initializeCommand(host.workspace, host.sessions));
		await successor.dispose();
	});

	test("releases private CAS authority after a host process is killed", async () => {
		const host = await temporaryHost();
		const command = initializeCommand(host.workspace, host.sessions);
		const runtimeModule = new URL("../src/modes/empatra-host/runtime.ts", import.meta.url).href;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { EmpatraHostAgentRuntime } from ${JSON.stringify(runtimeModule)};
const runtime = new EmpatraHostAgentRuntime();
await runtime.initialize(${JSON.stringify(command)});
console.log("READY");
await new Promise(() => {});`,
			],
			{ stderr: "pipe", stdout: "pipe" },
		);
		try {
			const reader = child.stdout.getReader();
			const decoder = new TextDecoder();
			let output = "";
			while (!output.includes("READY")) {
				const chunk = await reader.read();
				if (chunk.done) {
					const stderr = await new Response(child.stderr).text();
					throw new Error(`Authority child exited before readiness: ${stderr}`);
				}
				output += decoder.decode(chunk.value, { stream: true });
			}
			reader.releaseLock();

			const competing = new EmpatraHostAgentRuntime();
			await expect(competing.initialize(command)).rejects.toMatchObject({ code: "runtime_error" });
			child.kill(9);
			await child.exited;

			const recovered = new EmpatraHostAgentRuntime();
			await recovered.initialize(command);
			await recovered.dispose();
		} finally {
			if (child.exitCode === null) {
				child.kill(9);
				await child.exited;
			}
		}
	}, 10_000);

	test("constructs and disposes a real isolated OMP AgentSession without contacting a provider", async () => {
		const host = await temporaryHost();
		const runtime = new EmpatraHostAgentRuntime();
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-real-session",
			modelId: "managed-model",
			operationId: "operation-real-session",
			systemPrompt: "Empatra system prompt",
			type: "thread_create",
		})) as { generation: number; threadId: string };
		expect(created.generation).toBe(0);
		expect(created.threadId).toBeString();
		await runtime.dispose();
	});

	test("passes only private materialized skills into injected OMP sessions", async () => {
		const host = await temporaryHost();
		const skillRoot = path.join(host.sessions, "runtime", "skill-snapshots", "revision", "review");
		await mkdir(skillRoot, { recursive: true });
		await writeFile(path.join(skillRoot, "SKILL.md"), "# Review\n", "utf8");
		const received: EmpatraHostSessionFactoryOptions[] = [];
		const runtime = new EmpatraHostAgentRuntime({
			sessionFactory: async input => {
				received.push(input);
				return new FakeSession();
			},
		});
		await runtime.initialize({
			...initializeCommand(host.workspace, host.sessions),
			skills: [
				{
					baseDir: skillRoot,
					description: "Review workflow",
					filePath: path.join(skillRoot, "SKILL.md"),
					name: "review",
					source: "empatra:repo",
				},
			],
		});
		await runtime.startThread({
			cwd: host.workspace,
			id: "create-skill-session",
			modelId: "managed-model",
			operationId: "operation-skill-session",
			systemPrompt: "Empatra system prompt",
			type: "thread_create",
		});
		expect(received).toHaveLength(1);
		expect(received[0]?.skills).toEqual([
			expect.objectContaining({
				name: "review",
				source: "empatra:repo",
			}),
		]);
		expect(received[0]?.skills[0]?.filePath).toBe(path.join(await realpath(skillRoot), "SKILL.md"));
		await runtime.dispose();
	});

	test("rejects a skill descriptor that escapes private session storage", async () => {
		const host = await temporaryHost();
		const outsideRoot = path.join(host.root, "outside-skill");
		await mkdir(outsideRoot, { recursive: true });
		await writeFile(path.join(outsideRoot, "SKILL.md"), "# Outside\n", "utf8");
		const runtime = new EmpatraHostAgentRuntime();
		await expect(
			runtime.initialize({
				...initializeCommand(host.workspace, host.sessions),
				skills: [
					{
						baseDir: outsideRoot,
						description: "must be rejected",
						filePath: path.join(outsideRoot, "SKILL.md"),
						name: "outside",
						source: "empatra:repo",
					},
				],
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
		await runtime.dispose();
	});

	test("creates an injected OMP session once and durably reuses its operation id", async () => {
		const host = await temporaryHost();
		const options: EmpatraHostSessionFactoryOptions[] = [];
		const runtime = new EmpatraHostAgentRuntime({
			sessionFactory: async input => {
				options.push(input);
				return new FakeSession();
			},
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const create = {
			cwd: host.workspace,
			id: "create-1",
			modelId: "managed-model",
			operationId: "operation-1",
			systemPrompt: "Empatra system prompt",
			type: "thread_create" as const,
		};
		const first = (await runtime.startThread(create)) as { generation: number; threadId: string };
		const second = (await runtime.startThread({ ...create, id: "create-2" })) as {
			generation: number;
			threadId: string;
		};

		expect(second).toEqual(first);
		expect(options).toHaveLength(1);
		expect(options[0]?.capability).toBe("c".repeat(48));
		expect(options[0]?.model).toMatchObject({
			api: "openai-responses",
			baseUrl: "http://127.0.0.1:43123/v1",
			id: "managed-model",
			provider: "empatra-gateway",
		});
		expect(options[0]?.settings.get("tools.approvalMode")).toBe("always-ask");

		const catalog = (await runtime.listThreads({ id: "list-1", limit: 50, offset: 0, type: "thread_list" })) as {
			nextOffset: number | null;
			threads: Array<{ id: string }>;
		};
		expect(catalog.nextOffset).toBeNull();
		expect(catalog.threads.map(thread => thread.id)).toEqual([first.threadId]);

		const snapshot = (await runtime.readThread({
			id: "read-1",
			limit: 50,
			threadId: first.threadId,
			type: "thread_read",
		})) as {
			contextUsage: unknown;
			messages: unknown[];
			thread: { id: string; modelId: string; systemPromptSha256: string };
		};
		expect(snapshot.messages).toEqual([]);
		expect(snapshot.contextUsage).toEqual({
			modelContextWindow: 200_000,
			observedAtMs: null,
			tokenUsage: {
				last: {
					cachedInputTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 0,
				},
				total: {
					cachedInputTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 0,
				},
			},
			turnId: null,
		});
		expect(snapshot.thread).toMatchObject({
			id: first.threadId,
			modelId: "managed-model",
			systemPromptSha256: new Bun.CryptoHasher("sha256").update(create.systemPrompt).digest("hex"),
		});
		await runtime.dispose();
	});

	test("atomically refreshes native host tools and correlates old and new catalog revisions within one turn", async () => {
		const host = await temporaryHost();
		const session = new FakeSession();
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => session });
		const calls: EmpatraHostToolCallFrame[] = [];
		const firstDispatched = Promise.withResolvers<void>();
		const allowSecond = Promise.withResolvers<void>();
		const secondDispatched = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		runtime.setEventSink(async event => {
			if (event.event === "turn_completed") completed.resolve();
		});
		runtime.setHostToolSink(async frame => {
			if (frame.type !== "host_tool_call") return;
			calls.push(frame);
			if (calls.length === 1) firstDispatched.resolve();
			else secondDispatched.resolve();
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-host-tools",
			modelId: "managed-model",
			operationId: "operation-host-tools",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		const firstTools = [
			{
				description: "First desktop operation",
				name: "desktop_first",
				parameters: { additionalProperties: false, properties: {}, type: "object" },
			},
		];
		const firstRevision = computeEmpatraHostToolCatalogRevision(firstTools);
		await runtime.replaceHostTools({
			catalogRevision: firstRevision,
			id: "catalog-first",
			tools: firstTools,
			type: "host_tools_replace",
		});
		expect(session.rpcTools.map(tool => tool.name)).toEqual(["desktop_first"]);
		await expect(
			runtime.replaceHostTools({
				catalogRevision: `sha256:${"0".repeat(64)}`,
				id: "catalog-forged",
				tools: [{ ...firstTools[0]!, name: "forged_tool" }],
				type: "host_tools_replace",
			}),
		).rejects.toMatchObject({ code: "host_tool_catalog_mismatch" });
		expect(session.rpcTools.map(tool => tool.name)).toEqual(["desktop_first"]);

		session.onPrompt = async () => {
			const first = session.rpcTools[0];
			if (!first) throw new Error("First host tool is missing");
			const firstResult = first.execute("provider-call-first", { localSecret: "RAW_FIRST" });
			await allowSecond.promise;
			const second = session.rpcTools[0];
			if (!second) throw new Error("Second host tool is missing");
			const secondResult = second.execute("provider-call-second", { localSecret: "RAW_SECOND" });
			await Promise.all([firstResult, secondResult]);
		};
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "turn-host-tools",
			message: "Use both host tools",
			threadId: created.threadId,
			turnId: "turn-host-tools",
			type: "turn_start",
		});
		await firstDispatched.promise;
		const secondTools = [
			{
				description: "Second desktop operation",
				name: "desktop_second",
				parameters: { additionalProperties: false, properties: {}, type: "object" },
			},
		];
		const secondRevision = computeEmpatraHostToolCatalogRevision(secondTools);
		await runtime.replaceHostTools({
			catalogRevision: secondRevision,
			id: "catalog-second",
			tools: secondTools,
			type: "host_tools_replace",
		});
		const firstCall = calls[0];
		if (!firstCall) throw new Error("First host call is missing");
		runtime.handleHostToolResult({
			catalogRevision: firstRevision,
			failed: false,
			generation: 1,
			id: firstCall.id,
			result: { content: [{ text: "first done", type: "text" }] },
			threadId: created.threadId,
			turnId: "turn-host-tools",
			type: "host_tool_result",
		});
		allowSecond.resolve();
		await secondDispatched.promise;
		const secondCall = calls[1];
		if (!secondCall) throw new Error("Second host call is missing");
		expect(calls.map(call => [call.toolName, call.catalogRevision])).toEqual([
			["desktop_first", firstRevision],
			["desktop_second", secondRevision],
		]);
		runtime.handleHostToolResult({
			catalogRevision: secondRevision,
			failed: false,
			generation: 1,
			id: secondCall.id,
			result: { content: [{ text: "second done", type: "text" }] },
			threadId: created.threadId,
			turnId: "turn-host-tools",
			type: "host_tool_result",
		});
		await completed.promise;
		session.nativeToolNames.push("session_native");
		const collidingTools = [{ ...secondTools[0]!, name: "session_native" }];
		await expect(
			runtime.replaceHostTools({
				catalogRevision: computeEmpatraHostToolCatalogRevision(collidingTools),
				id: "catalog-native-collision",
				tools: collidingTools,
				type: "host_tools_replace",
			}),
		).rejects.toMatchObject({ code: "host_tool_catalog_invalid" });
		expect(session.rpcTools.map(tool => tool.name)).toEqual(["desktop_second"]);
		await runtime.dispose();
	});

	test("recovers a safely persisted host tool left open by a crashed runtime as failed", async () => {
		const host = await temporaryHost();
		const managers: EmpatraHostSessionFactoryOptions[] = [];
		const createRuntime = () =>
			new EmpatraHostAgentRuntime({
				sessionFactory: async options => {
					managers.push(options);
					return new FakeSession();
				},
			});
		let runtime = createRuntime();
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-crashed-tool",
			modelId: "managed-model",
			operationId: "operation-crashed-tool",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		const manager = managers[0]?.sessionManager;
		if (!manager) throw new Error("Session manager is missing");
		manager.appendCustomEntry(EMPATRA_HOST_TOOL_ENTRY, {
			generation: 1,
			payload: {
				argumentsText: '{"path":"src/main.ts"}',
				argumentsTruncated: false,
				phase: "start",
				toolCallId: "crashed-tool-call",
				toolName: "desktop_action",
			},
			sequence: 1,
			turnId: "crashed-turn",
			version: EMPATRA_HOST_TOOL_ENTRY_VERSION,
		} satisfies EmpatraHostPersistedToolEvent);
		await manager.flush();
		const sessionPath = manager.getSessionFile();
		await runtime.dispose();

		runtime = createRuntime();
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const snapshot = (await runtime.readThread({
			id: "read-crashed-tool",
			limit: 50,
			threadId: created.threadId,
			type: "thread_read",
		})) as { messages: Array<{ blocks: Array<Record<string, unknown>> }> };
		expect(snapshot.messages.at(-1)?.blocks).toEqual([
			{
				blockType: "tool_call",
				failed: true,
				hasResult: true,
				id: "crashed-tool-call",
				toolArgumentsText: '{"path":"src/main.ts"}',
				toolArgumentsTruncated: false,
				toolName: "desktop_action",
				toolResultText: "Tool execution was interrupted before completion",
				toolResultTruncated: false,
			},
		]);
		if (!sessionPath) throw new Error("Session file is missing");
		const persisted = await Bun.file(sessionPath).text();
		expect(persisted).not.toContain("provider");
		expect(persisted).not.toContain("auth");
		await runtime.dispose();
	});

	test("persists goal CRUD with mutation idempotency and no provider payload", async () => {
		const host = await temporaryHost();
		const sessionOptions: EmpatraHostSessionFactoryOptions[] = [];
		const createRuntime = () =>
			new EmpatraHostAgentRuntime({
				sessionFactory: async input => {
					sessionOptions.push(input);
					return new FakeSession();
				},
			});
		let runtime = createRuntime();
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-goal",
			modelId: "managed-model",
			operationId: "operation-goal",
			systemPrompt: "System prompt must not enter goal metadata",
			type: "thread_create",
		})) as { threadId: string };

		expect(
			await runtime.getThreadGoal({ id: "goal-get-empty", threadId: created.threadId, type: "goal_get" }),
		).toEqual({ goal: null });
		const command = {
			id: "goal-set-1",
			objective: "Завершить нативный parity",
			threadId: created.threadId,
			tokenBudget: 25_000,
			type: "goal_set" as const,
		};
		const first = (await runtime.setThreadGoal(command)) as { goal: { createdAt: number; updatedAt: number } };
		const repeated = (await runtime.setThreadGoal(command)) as { goal: { createdAt: number; updatedAt: number } };
		expect(repeated.goal.updatedAt).toBe(first.goal.updatedAt);
		await expect(runtime.setThreadGoal({ ...command, objective: "Другой ввод" })).rejects.toMatchObject({
			code: "operation_conflict",
		});
		await runtime.setThreadGoal({
			id: "goal-pause-1",
			objective: null,
			status: "paused",
			threadId: created.threadId,
			type: "goal_set",
		});
		const sessionPath = sessionOptions[0]?.sessionManager.getSessionFile();
		if (!sessionPath) throw new Error("Goal session was not persisted");
		const goalMetadata = (await Bun.file(sessionPath).text())
			.split("\n")
			.filter(line => line.includes("empatra.host.thread-goal.v1"))
			.join("\n");
		expect(goalMetadata).not.toContain("System prompt must not enter goal metadata");
		expect(goalMetadata).not.toContain("empatra-gateway");
		expect(goalMetadata).not.toContain("cccccccc");
		await runtime.dispose();

		sessionOptions.length = 0;
		runtime = createRuntime();
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const restored = (await runtime.getThreadGoal({
			id: "goal-get-restored",
			threadId: created.threadId,
			type: "goal_get",
		})) as { goal: { objective: string; status: string; threadId: string; tokenBudget: number | null } | null };
		expect(restored.goal).toMatchObject({
			objective: "Завершить нативный parity",
			status: "paused",
			threadId: created.threadId,
			tokenBudget: 25_000,
		});
		const cleared = await runtime.clearThreadGoal({
			id: "goal-clear-1",
			threadId: created.threadId,
			type: "goal_clear",
		});
		expect(cleared).toEqual({ cleared: true });
		expect(
			await runtime.clearThreadGoal({ id: "goal-clear-1", threadId: created.threadId, type: "goal_clear" }),
		).toEqual({ cleared: true });
		expect(
			await runtime.clearThreadGoal({ id: "goal-clear-2", threadId: created.threadId, type: "goal_clear" }),
		).toEqual({ cleared: false });
		await runtime.dispose();
	});

	test("reconstructs durable turn summaries with bounded stale-safe cursors", async () => {
		const host = await temporaryHost();
		const completed = new Map<string, { resolve: () => void }>();
		const createRuntime = () =>
			new EmpatraHostAgentRuntime({
				sessionFactory: async () => new FakeSession(),
			});
		let runtime = createRuntime();
		runtime.setEventSink(async event => {
			if (event.event === "turn_completed") completed.get(event.turnId)?.resolve();
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-turn-history",
			modelId: "managed-model",
			operationId: "operation-turn-history",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		for (let index = 1; index <= 3; index++) {
			const turnId = `turn-${index}`;
			const signal = Promise.withResolvers<void>();
			completed.set(turnId, signal);
			await runtime.startTurn({
				expectedGeneration: (index - 1) * 2,
				id: `start-${index}`,
				message: `Prompt ${index}`,
				threadId: created.threadId,
				turnId,
				type: "turn_start",
			});
			await signal.promise;
		}

		const firstPage = (await runtime.listThreadTurns({
			id: "turns-page-1",
			limit: 2,
			sortDirection: "desc",
			threadId: created.threadId,
			type: "thread_turns",
		})) as {
			backwardsCursor: string | null;
			data: Array<{ id: string; status: string }>;
			nextCursor: string | null;
			snapshotRevision: string;
		};
		expect(firstPage.data).toEqual([
			expect.objectContaining({ id: "turn-3", status: "completed" }),
			expect.objectContaining({ id: "turn-2", status: "completed" }),
		]);
		expect(firstPage.backwardsCursor).toBeNull();
		expect(firstPage.nextCursor).toBeString();
		if (!firstPage.nextCursor) throw new Error("Expected a second turn page");
		const secondPage = (await runtime.listThreadTurns({
			cursor: firstPage.nextCursor,
			id: "turns-page-2",
			limit: 2,
			sortDirection: "desc",
			threadId: created.threadId,
			type: "thread_turns",
		})) as {
			backwardsCursor: string | null;
			data: Array<{ id: string }>;
			nextCursor: string | null;
			snapshotRevision: string;
		};
		expect(secondPage.data.map(turn => turn.id)).toEqual(["turn-1"]);
		expect(secondPage.backwardsCursor).toBeString();
		expect(secondPage.nextCursor).toBeNull();
		expect(firstPage.snapshotRevision).toMatch(/^[a-f0-9]{64}$/u);
		expect(secondPage.snapshotRevision).toBe(firstPage.snapshotRevision);
		await runtime.setThreadGoal({
			id: "goal-invalidates-cursor",
			objective: "Mutate authoritative branch",
			threadId: created.threadId,
			type: "goal_set",
		});
		await expect(
			runtime.listThreadTurns({
				cursor: firstPage.nextCursor,
				id: "turns-stale",
				limit: 2,
				sortDirection: "desc",
				threadId: created.threadId,
				type: "thread_turns",
			}),
		).rejects.toMatchObject({ code: "stale_cursor" });
		await runtime.dispose();

		runtime = createRuntime();
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const restored = (await runtime.listThreadTurns({
			id: "turns-restored",
			limit: 10,
			sortDirection: "asc",
			threadId: created.threadId,
			type: "thread_turns",
		})) as { data: Array<{ id: string }> };
		expect(restored.data.map(turn => turn.id)).toEqual(["turn-1", "turn-2", "turn-3"]);
		await runtime.dispose();
	});

	test("anchors thread read cursors to the immutable snapshot leaf", async () => {
		const host = await temporaryHost();
		const options: EmpatraHostSessionFactoryOptions[] = [];
		const runtime = new EmpatraHostAgentRuntime({
			sessionFactory: async input => {
				options.push(input);
				return new FakeSession();
			},
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-read-cursor",
			modelId: "managed-model",
			operationId: "operation-read-cursor",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		const manager = options[0]?.sessionManager;
		if (!manager) throw new Error("Expected a session manager");
		manager.appendMessage({ content: "first", role: "user", timestamp: Date.now() });
		manager.appendMessage({ content: "second", role: "user", timestamp: Date.now() + 1 });
		await manager.flush();
		const first = (await runtime.readThread({
			id: "read-cursor-first",
			limit: 1,
			threadId: created.threadId,
			type: "thread_read",
		})) as {
			messages: Array<{ blocks: Array<{ text: string }> }>;
			nextCursor: string | null;
			snapshotRevision: string;
		};
		expect(first.messages[0]?.blocks[0]?.text).toBe("first");
		expect(first.nextCursor).toBeString();
		expect(first.snapshotRevision).toMatch(/^[a-f0-9]{64}$/u);
		if (!first.nextCursor) throw new Error("Expected an opaque read cursor");
		const second = (await runtime.readThread({
			cursor: first.nextCursor,
			id: "read-cursor-second",
			limit: 1,
			threadId: created.threadId,
			type: "thread_read",
		})) as {
			messages: Array<{ blocks: Array<{ text: string }> }>;
			nextCursor: string | null;
			snapshotRevision: string;
		};
		expect(second.messages[0]?.blocks[0]?.text).toBe("second");
		expect(second.nextCursor).toBeNull();
		expect(second.snapshotRevision).toBe(first.snapshotRevision);
		const turnsBeforeMutation = (await runtime.listThreadTurns({
			id: "turns-before-read-mutation",
			limit: 10,
			threadId: created.threadId,
			type: "thread_turns",
		})) as { snapshotRevision: string };
		expect(turnsBeforeMutation.snapshotRevision).toBe(first.snapshotRevision);

		const stalePage = (await runtime.readThread({
			id: "read-cursor-stale-source",
			limit: 1,
			threadId: created.threadId,
			type: "thread_read",
		})) as { nextCursor: string | null };
		if (!stalePage.nextCursor) throw new Error("Expected a cursor to invalidate");
		manager.appendMessage({ content: "concurrent mutation", role: "user", timestamp: Date.now() + 2 });
		await manager.flush();
		const turnsAfterMutation = (await runtime.listThreadTurns({
			id: "turns-after-read-mutation",
			limit: 10,
			threadId: created.threadId,
			type: "thread_turns",
		})) as { snapshotRevision: string };
		expect(turnsAfterMutation.snapshotRevision).not.toBe(first.snapshotRevision);
		await expect(
			runtime.readThread({
				cursor: stalePage.nextCursor,
				id: "read-cursor-stale",
				limit: 1,
				threadId: created.threadId,
				type: "thread_read",
			}),
		).rejects.toMatchObject({ code: "stale_cursor" });
		await runtime.dispose();
	});

	test("keeps thread read pages below the response byte budget while advancing the cursor", async () => {
		const host = await temporaryHost();
		let options: EmpatraHostSessionFactoryOptions | undefined;
		const runtime = new EmpatraHostAgentRuntime({
			sessionFactory: async input => {
				options = input;
				return new FakeSession();
			},
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-byte-budget",
			modelId: "managed-model",
			operationId: "operation-byte-budget",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		if (!options) throw new Error("Expected session factory options");
		for (let index = 0; index < 6; index += 1) {
			options.sessionManager.appendMessage({
				content: `${index}:${"я".repeat(110_000)}`,
				role: "user",
				timestamp: Date.now() + index,
			});
		}
		await options.sessionManager.flush();
		const collected: string[] = [];
		let cursor: string | undefined;
		do {
			const page = (await runtime.readThread({
				...(cursor ? { cursor } : {}),
				id: `read-byte-budget-${collected.length}`,
				limit: 50,
				threadId: created.threadId,
				type: "thread_read",
			})) as {
				messages: Array<{ blocks: Array<{ text: string }> }>;
				nextCursor: string | null;
			};
			expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
				EMPATRA_HOST_THREAD_READ_TARGET_BYTES,
			);
			expect(
				new TextEncoder().encode(
					serializeEmpatraHostFrame({
						data: page,
						id: "server-byte-budget",
						success: true,
						type: "host_response",
					}),
				).byteLength,
			).toBeLessThanOrEqual(EMPATRA_HOST_MAX_FRAME_BYTES);
			expect(page.messages.length).toBeGreaterThan(0);
			collected.push(...page.messages.map(message => message.blocks[0]!.text.slice(0, 1)));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(collected).toEqual(["0", "1", "2", "3", "4", "5"]);
		await runtime.dispose();
	});

	test("recomputes durable usage after fork and rollback from each selected branch", async () => {
		const host = await temporaryHost();
		const turnCounts = new Map<string, number>();
		const completions = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
		const runtime = new EmpatraHostAgentRuntime({
			sessionFactory: async input => {
				const session = new FakeSession();
				session.onPrompt = async () => {
					const turn = (turnCounts.get(input.sessionManager.getSessionId()) ?? 0) + 1;
					turnCounts.set(input.sessionManager.getSessionId(), turn);
					input.sessionManager.appendMessage({
						content: `request-${turn}`,
						role: "user",
						timestamp: turn * 1_000,
					});
					const message = assistantMessage([{ text: `response-${turn}`, type: "text" }], {
						cacheRead: turn,
						input: turn * 2,
						output: turn,
						totalTokens: turn * 4,
					});
					message.completedAt = turn * 1_000 + 100;
					input.sessionManager.appendMessage(message);
				};
				return session;
			},
		});
		runtime.setEventSink(async event => {
			if (event.event === "turn_completed") completions.get(event.turnId)?.resolve();
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-usage-branches",
			modelId: "managed-model",
			operationId: "operation-usage-branches",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		for (const [turnId, expectedGeneration] of [
			["turn-usage-1", 0],
			["turn-usage-2", 2],
		] as const) {
			const completion = Promise.withResolvers<void>();
			completions.set(turnId, completion);
			await runtime.startTurn({
				expectedGeneration,
				id: `start-${turnId}`,
				message: turnId,
				threadId: created.threadId,
				turnId,
				type: "turn_start",
			});
			await completion.promise;
		}
		const readUsage = async (threadId: string) => {
			const snapshot = (await runtime.readThread({
				id: `read-${crypto.randomUUID()}`,
				limit: 50,
				threadId,
				type: "thread_read",
			})) as { contextUsage: { tokenUsage: { total: unknown }; turnId: string | null } };
			return snapshot.contextUsage;
		};
		const before = await readUsage(created.threadId);
		expect(before).toMatchObject({
			tokenUsage: {
				total: {
					cachedInputTokens: 3,
					inputTokens: 9,
					outputTokens: 3,
					reasoningOutputTokens: 0,
					totalTokens: 12,
				},
			},
			turnId: "turn-usage-2",
		});
		const forked = (await runtime.forkThread({
			id: "fork-usage-branches",
			operationId: "operation-fork-usage-branches",
			threadId: created.threadId,
			type: "thread_fork",
		})) as { threadId: string };
		expect(await readUsage(forked.threadId)).toEqual(before);
		await runtime.rollbackThread({
			id: "rollback-usage-branches",
			threadId: created.threadId,
			turns: 1,
			type: "thread_rollback",
		});
		expect(await readUsage(created.threadId)).toMatchObject({
			tokenUsage: {
				total: {
					cachedInputTokens: 1,
					inputTokens: 3,
					outputTokens: 1,
					reasoningOutputTokens: 0,
					totalTokens: 4,
				},
			},
			turnId: "turn-usage-1",
		});
		await runtime.dispose();
	});

	test("forks a durable session and its artifacts exactly once per operation id", async () => {
		const host = await temporaryHost();
		const sessions: EmpatraHostSessionFactoryOptions[] = [];
		const createRuntime = () =>
			new EmpatraHostAgentRuntime({
				sessionFactory: async input => {
					sessions.push(input);
					return new FakeSession();
				},
			});
		let runtime = createRuntime();
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const source = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-fork-source",
			modelId: "managed-model",
			operationId: "operation-fork-source",
			systemPrompt: "Forked system prompt",
			type: "thread_create",
		})) as { threadId: string };
		const sourcePath = sessions[0]?.sessionManager.getSessionFile();
		expect(sourcePath).toBeString();
		if (!sourcePath) throw new Error("Source session was not persisted");
		const sourceArtifact = path.join(sourcePath.slice(0, -".jsonl".length), "nested", "evidence.txt");
		await Bun.write(sourceArtifact, "artifact survives fork");
		const command = {
			id: "fork-1",
			operationId: "operation-fork-1",
			threadId: source.threadId,
			type: "thread_fork" as const,
		};
		const [first, repeated] = (await Promise.all([
			runtime.forkThread(command),
			runtime.forkThread({ ...command, id: "fork-2" }),
		])) as Array<{ generation: number; threadId: string }>;

		expect(repeated).toEqual(first);
		expect(first.threadId).not.toBe(source.threadId);
		expect(sessions).toHaveLength(2);
		const forkPath = sessions[1]?.sessionManager.getSessionFile();
		expect(forkPath).toBeString();
		if (!forkPath) throw new Error("Forked session was not persisted");
		expect(await Bun.file(path.join(forkPath.slice(0, -".jsonl".length), "nested", "evidence.txt")).text()).toBe(
			"artifact survives fork",
		);
		await runtime.dispose();

		sessions.length = 0;
		runtime = createRuntime();
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		await expect(runtime.forkThread({ ...command, id: "fork-after-restart" })).resolves.toEqual(first);
		expect(sessions).toHaveLength(1);
		await runtime.dispose();
	});

	test("serializes compaction and rejects it while a turn is active", async () => {
		const host = await temporaryHost();
		const fake = new FakeSession();
		const prompt = Promise.withResolvers<void>();
		const turnCompleted = Promise.withResolvers<void>();
		fake.onPrompt = async () => prompt.promise;
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => fake });
		runtime.setEventSink(async event => {
			if (event.event === "turn_completed") turnCompleted.resolve();
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-compact",
			modelId: "managed-model",
			operationId: "operation-compact",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "turn-compact",
			message: "Keep running",
			threadId: created.threadId,
			turnId: "turn-compact",
			type: "turn_start",
		});
		await expect(
			runtime.compactThread({ id: "compact-active", threadId: created.threadId, type: "thread_compact" }),
		).rejects.toMatchObject({ code: "turn_active" });
		prompt.resolve();
		await turnCompleted.promise;
		await expect(
			runtime.compactThread({ id: "compact-idle", threadId: created.threadId, type: "thread_compact" }),
		).resolves.toMatchObject({ compacted: true, generation: 2, threadId: created.threadId });
		expect(fake.compacted).toBe(1);
		await runtime.dispose();
	});

	test("projects turn failures without provider error details", async () => {
		const host = await temporaryHost();
		const secret = "SECRET_SENTINEL_turn_failure";
		const fake = new FakeSession();
		const completed = Promise.withResolvers<EmpatraHostEvent>();
		fake.onPrompt = async () => {
			throw new Error(`Upstream included ${secret}`);
		};
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => fake });
		runtime.setEventSink(async event => {
			if (event.event === "turn_completed") completed.resolve(event);
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-secret",
			modelId: "managed-model",
			operationId: "operation-secret",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "turn-secret",
			message: "Fail safely",
			threadId: created.threadId,
			turnId: "turn-secret",
			type: "turn_start",
		});
		const event = await completed.promise;
		expect(JSON.stringify(event)).not.toContain(secret);
		expect(event).toMatchObject({
			error: { code: "turn_failed", message: "OMP turn failed" },
			event: "turn_completed",
			outcome: "failed",
		});
		await runtime.dispose();
	});

	test("persists rename, archive, unarchive, search, and artifact-aware delete lifecycle", async () => {
		const host = await temporaryHost();
		const createRuntime = () =>
			new EmpatraHostAgentRuntime({
				sessionFactory: async () => new FakeSession(),
			});
		let runtime = createRuntime();
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const first = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-lifecycle-1",
			modelId: "managed-model",
			operationId: "operation-lifecycle-1",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		const second = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-lifecycle-2",
			modelId: "managed-model",
			operationId: "operation-lifecycle-2",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };

		await runtime.renameThread({
			id: "rename-lifecycle-1",
			threadId: first.threadId,
			title: "Проект Север",
			type: "thread_rename",
		});
		await expect(
			runtime.archiveThread({ id: "archive-lifecycle-1", threadId: first.threadId, type: "thread_archive" }),
		).resolves.toMatchObject({ archived: true, changed: true });

		const active = (await runtime.listThreads({ id: "list-active", limit: 50, offset: 0, type: "thread_list" })) as {
			threads: Array<{ archived: boolean; id: string }>;
		};
		expect(active.threads).toEqual([expect.objectContaining({ archived: false, id: second.threadId })]);
		const archived = (await runtime.listThreads({
			archived: true,
			id: "list-archived",
			limit: 50,
			offset: 0,
			searchTerm: "север",
			type: "thread_list",
		})) as { threads: Array<{ archived: boolean; id: string; title: string | null }> };
		expect(archived.threads).toEqual([
			expect.objectContaining({ archived: true, id: first.threadId, title: "Проект Север" }),
		]);
		await runtime.dispose();

		runtime = createRuntime();
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const restored = (await runtime.listThreads({
			archived: true,
			id: "list-restored",
			limit: 50,
			offset: 0,
			type: "thread_list",
		})) as { threads: Array<{ id: string }> };
		expect(restored.threads.map(thread => thread.id)).toEqual([first.threadId]);
		await runtime.unarchiveThread({
			id: "unarchive-lifecycle-1",
			threadId: first.threadId,
			type: "thread_unarchive",
		});
		const restoredActive = (await runtime.listThreads({
			id: "list-restored-active",
			limit: 50,
			offset: 0,
			type: "thread_list",
		})) as { threads: Array<{ id: string }> };
		expect(new Set(restoredActive.threads.map(thread => thread.id))).toEqual(
			new Set([first.threadId, second.threadId]),
		);

		await runtime.deleteThread({ id: "delete-lifecycle-1", threadId: first.threadId, type: "thread_delete" });
		await expect(
			runtime.readThread({
				id: "read-deleted",
				limit: 50,
				threadId: first.threadId,
				type: "thread_read",
			}),
		).rejects.toMatchObject({ code: "thread_not_found" });
		await runtime.dispose();
	});

	test("rejects a cwd outside the initialized workspace and an uninjected model", async () => {
		const host = await temporaryHost();
		const outside = path.join(host.root, "outside");
		await mkdir(outside);
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => new FakeSession() });
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));

		await expect(
			runtime.startThread({
				cwd: outside,
				id: "create-outside",
				modelId: "managed-model",
				operationId: "operation-outside",
				systemPrompt: "System",
				type: "thread_create",
			}),
		).rejects.toMatchObject({ code: "workspace_denied" });
		await expect(
			runtime.startThread({
				cwd: host.workspace,
				id: "create-model",
				modelId: "ambient-model",
				operationId: "operation-model",
				systemPrompt: "System",
				type: "thread_create",
			}),
		).rejects.toMatchObject({ code: "model_not_found" });
		await runtime.dispose();
	});

	test("keeps generation fencing consistent across a running turn and interrupt", async () => {
		const host = await temporaryHost();
		const turn = Promise.withResolvers<void>();
		const events: EmpatraHostEvent[] = [];
		const completed = Promise.withResolvers<{
			event: string;
			generation: number;
			outcome: string;
			turnId: string;
		}>();
		const session = new FakeSession();
		session.onPrompt = () => turn.promise;
		session.onAbort = () => turn.resolve();
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => session });
		runtime.setEventSink(async event => {
			events.push(event);
			if (event.event === "turn_completed") completed.resolve(event);
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-1",
			modelId: "managed-model",
			operationId: "operation-1",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		const accepted = await runtime.startTurn({
			expectedGeneration: 0,
			id: "turn-start-1",
			message: "Implement",
			threadId: created.threadId,
			turnId: "turn-1",
			type: "turn_start",
		});
		expect(accepted).toMatchObject({ generation: 1, turnId: "turn-1" });
		await expect(
			runtime.archiveThread({ id: "archive-running", threadId: created.threadId, type: "thread_archive" }),
		).rejects.toMatchObject({ code: "turn_active" });
		session.emit({ message: { role: "assistant" }, type: "message_start" } as AgentSessionEvent);
		session.emit({
			assistantMessageEvent: { contentIndex: 0, delta: "Готово", type: "text_delta" },
			type: "message_update",
		} as AgentSessionEvent);
		await runtime.interruptTurn({
			expectedGeneration: 1,
			id: "turn-interrupt-1",
			threadId: created.threadId,
			turnId: "turn-1",
			type: "turn_interrupt",
		});
		expect(await completed.promise).toMatchObject({
			event: "turn_completed",
			generation: 2,
			outcome: "interrupted",
			turnId: "turn-1",
		});
		expect(events[0]).toEqual({
			contentIndex: 0,
			delta: "Готово",
			event: "turn_output",
			generation: 1,
			kind: "text_delta",
			messageIndex: 0,
			sequence: 1,
			threadId: created.threadId,
			turnId: "turn-1",
			type: "host_event",
		});
		await runtime.dispose();
	});

	test("streams bounded reasoning identity and secret-free cumulative usage before terminal", async () => {
		const host = await temporaryHost();
		const prompt = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const events: EmpatraHostEvent[] = [];
		const session = new FakeSession();
		session.onPrompt = () => prompt.promise;
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => session });
		runtime.setEventSink(async event => {
			events.push(event);
			if (event.event === "turn_completed") completed.resolve();
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-usage",
			modelId: "managed-model",
			operationId: "operation-usage",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "start-usage",
			message: "Think",
			threadId: created.threadId,
			turnId: "turn-usage",
			type: "turn_start",
		});
		const message = assistantMessage(
			[
				{ data: "SECRET_REDACTED_THINKING", type: "redactedThinking" },
				{ thinking: "Проверяю", type: "thinking" },
				{ text: "Готово", type: "text" },
			],
			{ cacheRead: 3, cacheWrite: 2, input: 10, output: 7, reasoningTokens: 4, totalTokens: 22 },
		);
		session.emit({ message, type: "message_start" });
		session.emit({
			assistantMessageEvent: { contentIndex: 1, delta: "Проверяю", partial: message, type: "thinking_delta" },
			message,
			type: "message_update",
		});
		session.emit({ message, type: "message_end" });
		const secondMessage = assistantMessage([{ text: "Готово", type: "text" }], {
			input: 1,
			output: 2,
			totalTokens: 3,
		});
		secondMessage.completedAt = 2_000;
		session.emit({ message: secondMessage, type: "message_start" });
		session.emit({
			assistantMessageEvent: { contentIndex: 0, delta: "Готово", partial: secondMessage, type: "text_delta" },
			message: secondMessage,
			type: "message_update",
		});
		session.emit({ message: secondMessage, type: "message_end" });
		prompt.resolve();
		await completed.promise;

		expect(events.map(event => event.event)).toEqual([
			"turn_output",
			"turn_usage_updated",
			"turn_output",
			"turn_usage_updated",
			"turn_completed",
		]);
		expect(events[0]).toMatchObject({
			contentIndex: 0,
			delta: "Проверяю",
			kind: "thinking_delta",
			messageIndex: 0,
			sequence: 1,
		});
		expect(events[1]).toEqual({
			contextUsage: {
				modelContextWindow: 200_000,
				observedAtMs: 1_000,
				tokenUsage: {
					last: {
						cachedInputTokens: 3,
						inputTokens: 15,
						outputTokens: 7,
						reasoningOutputTokens: 4,
						totalTokens: 22,
					},
					total: {
						cachedInputTokens: 3,
						inputTokens: 15,
						outputTokens: 7,
						reasoningOutputTokens: 4,
						totalTokens: 22,
					},
				},
				turnId: "turn-usage",
			},
			event: "turn_usage_updated",
			generation: 1,
			messageIndex: 0,
			sequence: 2,
			threadId: created.threadId,
			turnId: "turn-usage",
			type: "host_event",
		});
		expect(events[2]).toMatchObject({
			contentIndex: 0,
			delta: "Готово",
			kind: "text_delta",
			messageIndex: 1,
			sequence: 3,
		});
		expect(events[3]).toMatchObject({
			contextUsage: {
				observedAtMs: 2_000,
				tokenUsage: {
					last: {
						cachedInputTokens: 0,
						inputTokens: 1,
						outputTokens: 2,
						reasoningOutputTokens: 0,
						totalTokens: 3,
					},
					total: {
						cachedInputTokens: 3,
						inputTokens: 16,
						outputTokens: 9,
						reasoningOutputTokens: 4,
						totalTokens: 25,
					},
				},
			},
			event: "turn_usage_updated",
			messageIndex: 1,
			sequence: 4,
		});
		const serialized = JSON.stringify(events);
		for (const secret of ["SECRET_REDACTED_THINKING", "SECRET_UPSTREAM_MODEL", "SECRET_RESPONSE_ID"]) {
			expect(serialized).not.toContain(secret);
		}
		await runtime.dispose();
	});

	test("does not project aborted or errored assistant usage into the live product stream", async () => {
		const host = await temporaryHost();
		const prompt = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const events: EmpatraHostEvent[] = [];
		const session = new FakeSession();
		session.onPrompt = () => prompt.promise;
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => session });
		runtime.setEventSink(async event => {
			events.push(event);
			if (event.event === "turn_completed") completed.resolve();
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-untrusted-usage",
			modelId: "managed-model",
			operationId: "operation-untrusted-usage",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "start-untrusted-usage",
			message: "Try",
			threadId: created.threadId,
			turnId: "turn-untrusted-usage",
			type: "turn_start",
		});
		for (const stopReason of ["aborted", "error"] as const) {
			const message = assistantMessage([{ text: "partial", type: "text" }], {
				input: 10,
				output: 20,
				totalTokens: 30,
			});
			message.stopReason = stopReason;
			session.emit({ message, type: "message_start" });
			session.emit({ message, type: "message_end" });
		}
		prompt.resolve();
		await completed.promise;

		expect(events.filter(event => event.event === "turn_usage_updated")).toEqual([]);
		expect(events.at(-1)).toMatchObject({
			event: "turn_completed",
			outcome: "completed",
			turnId: "turn-untrusted-usage",
		});
		await runtime.dispose();
	});

	test("fails closed on unbounded assistant content identity", async () => {
		const host = await temporaryHost();
		const prompt = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<EmpatraHostEvent>();
		const events: EmpatraHostEvent[] = [];
		const session = new FakeSession();
		session.onPrompt = () => prompt.promise;
		session.onAbort = () => prompt.resolve();
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => session });
		runtime.setEventSink(async event => {
			events.push(event);
			if (event.event === "turn_completed") completed.resolve(event);
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-usage-bounds",
			modelId: "managed-model",
			operationId: "operation-usage-bounds",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "start-usage-bounds",
			message: "Think",
			threadId: created.threadId,
			turnId: "turn-usage-bounds",
			type: "turn_start",
		});
		const message = assistantMessage([{ thinking: "hidden", type: "thinking" }]);
		session.emit({ message, type: "message_start" });
		session.emit({
			assistantMessageEvent: { contentIndex: 4096, delta: "forged", partial: message, type: "thinking_delta" },
			message,
			type: "message_update",
		});
		expect(await completed.promise).toMatchObject({ event: "turn_completed", outcome: "failed" });
		expect(events).toHaveLength(1);
		await runtime.dispose();
	});

	test("caps assistant usage updates at 256 per turn", async () => {
		const host = await temporaryHost();
		const prompt = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<EmpatraHostEvent>();
		const events: EmpatraHostEvent[] = [];
		const session = new FakeSession();
		session.onPrompt = () => prompt.promise;
		session.onAbort = () => prompt.resolve();
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => session });
		runtime.setEventSink(async event => {
			events.push(event);
			if (event.event === "turn_completed") completed.resolve(event);
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-usage-cap",
			modelId: "managed-model",
			operationId: "operation-usage-cap",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "start-usage-cap",
			message: "Loop",
			threadId: created.threadId,
			turnId: "turn-usage-cap",
			type: "turn_start",
		});
		const message = assistantMessage([]);
		for (let index = 0; index < 256; index += 1) {
			session.emit({ message, type: "message_start" });
			session.emit({ message, type: "message_end" });
		}
		session.emit({ message, type: "message_start" });
		expect(await completed.promise).toMatchObject({ event: "turn_completed", outcome: "failed" });
		expect(events.filter(event => event.event === "turn_usage_updated")).toHaveLength(256);
		expect(events.filter(event => event.event === "turn_usage_updated").at(-1)).toMatchObject({
			messageIndex: 255,
			sequence: 256,
		});
		await runtime.dispose();
	});

	test("steers only the exact active generation and serializes completion behind accepted steering", async () => {
		const host = await temporaryHost();
		const prompt = Promise.withResolvers<void>();
		const steer = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const messages: string[] = [];
		const session = new FakeSession();
		session.onPrompt = () => prompt.promise;
		session.onSteer = async message => {
			messages.push(message);
			await steer.promise;
		};
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => session });
		runtime.setEventSink(async event => {
			if (event.event === "turn_completed") completed.resolve();
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-steer",
			modelId: "managed-model",
			operationId: "operation-steer",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "start-steer",
			message: "Initial",
			threadId: created.threadId,
			turnId: "turn-steer",
			type: "turn_start",
		});
		await expect(
			runtime.steerTurn({
				expectedGeneration: 0,
				id: "steer-stale",
				message: "Stale",
				threadId: created.threadId,
				turnId: "turn-steer",
				type: "turn_steer",
			}),
		).rejects.toMatchObject({ code: "stale_turn" });
		const accepted = runtime.steerTurn({
			expectedGeneration: 1,
			id: "steer-active",
			message: "Apply this correction",
			threadId: created.threadId,
			turnId: "turn-steer",
			type: "turn_steer",
		});
		await Bun.sleep(0);
		prompt.resolve();
		await Bun.sleep(0);
		let completedEarly = false;
		void completed.promise.then(() => {
			completedEarly = true;
		});
		await Bun.sleep(0);
		expect(completedEarly).toBe(false);
		steer.resolve();
		await expect(accepted).resolves.toMatchObject({ generation: 1, steered: true });
		await completed.promise;
		expect(messages).toEqual(["Apply this correction"]);
		await expect(
			runtime.steerTurn({
				expectedGeneration: 1,
				id: "steer-completed",
				message: "Too late",
				threadId: created.threadId,
				turnId: "turn-steer",
				type: "turn_steer",
			}),
		).rejects.toMatchObject({ code: "stale_turn" });
		await runtime.dispose();
	});

	test("delivers every queued frame before the terminal event while finish waits for the thread lock", async () => {
		const host = await temporaryHost();
		const prompt = Promise.withResolvers<void>();
		const steerEntered = Promise.withResolvers<void>();
		const steerRelease = Promise.withResolvers<void>();
		const outputStarted = Promise.withResolvers<void>();
		const outputRelease = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const order: string[] = [];
		const session = new FakeSession();
		session.onPrompt = () => prompt.promise;
		session.onSteer = async () => {
			steerEntered.resolve();
			await steerRelease.promise;
		};
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => session });
		runtime.setEventSink(async event => {
			if (event.event === "turn_output") {
				order.push("output:start");
				outputStarted.resolve();
				await outputRelease.promise;
				order.push("output:end");
				return;
			}
			if (event.event === "turn_completed") {
				order.push("completed");
				completed.resolve();
			}
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-terminal-order",
			modelId: "managed-model",
			operationId: "operation-terminal-order",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "start-terminal-order",
			message: "Initial",
			threadId: created.threadId,
			turnId: "turn-terminal-order",
			type: "turn_start",
		});
		const steering = runtime.steerTurn({
			expectedGeneration: 1,
			id: "steer-terminal-order",
			message: "Hold the thread lock",
			threadId: created.threadId,
			turnId: "turn-terminal-order",
			type: "turn_steer",
		});
		await steerEntered.promise;
		prompt.resolve();
		await Bun.sleep(0);
		session.emit({ message: { role: "assistant" }, type: "message_start" } as AgentSessionEvent);
		session.emit({
			assistantMessageEvent: { contentIndex: 0, delta: "queued", type: "text_delta" },
			type: "message_update",
		} as AgentSessionEvent);
		await outputStarted.promise;
		steerRelease.resolve();
		await steering;
		await Bun.sleep(0);
		expect(order).toEqual(["output:start"]);
		outputRelease.resolve();
		await completed.promise;
		expect(order).toEqual(["output:start", "output:end", "completed"]);
		await runtime.dispose();
	});

	test("projects parallel tools live and restores the same secret-free durable tool blocks", async () => {
		const host = await temporaryHost();
		const prompt = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const events: EmpatraHostEvent[] = [];
		const session = new FakeSession();
		session.onPrompt = () => prompt.promise;
		let runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => session });
		runtime.setEventSink(async event => {
			events.push(event);
			if (event.event === "turn_completed") completed.resolve();
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-tool-projection",
			modelId: "managed-model",
			operationId: "operation-tool-projection",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "start-tool-projection",
			message: "Use tools",
			threadId: created.threadId,
			turnId: "turn-tools",
			type: "turn_start",
		});
		session.emit({
			args: {
				path: path.join(host.workspace, "src", "main.ts"),
				providerPayload: { authorization: "SECRET_ARGUMENT" },
			},
			toolCallId: "tool-a",
			toolName: "edit",
			type: "tool_execution_start",
		} as AgentSessionEvent);
		session.emit({
			args: { command: "echo safe", token: "SECRET_SECOND_ARGUMENT" },
			toolCallId: "tool-b",
			toolName: "bash",
			type: "tool_execution_start",
		} as AgentSessionEvent);
		session.emit({
			args: {},
			isError: false,
			result: {
				content: [{ text: "second done", type: "text" }],
				details: { auth: "SECRET_END_DETAILS" },
				providerMetadata: { usage: { cost: 99 } },
			},
			toolCallId: "tool-b",
			toolName: "bash",
			type: "tool_execution_end",
		} as AgentSessionEvent);
		session.emit({
			args: {},
			partialResult: {
				content: [{ text: "ignored when a diff is available", type: "text" }],
				details: {
					diff: "+const token = 'sk-abcdefghijklmnopqrstuvwxyz';",
					metadata: { authorization: "SECRET_UPDATE_METADATA" },
					path: path.join(host.workspace, "src", "main.ts"),
				},
			},
			toolCallId: "tool-a",
			toolName: "edit",
			type: "tool_execution_update",
		} as AgentSessionEvent);
		session.emit({
			args: {},
			isError: false,
			result: {
				content: [{ text: "Authorization: Bearer SECRET_RESULT", type: "text" }],
				details: { metadata: "SECRET_RESULT_DETAILS" },
			},
			toolCallId: "tool-a",
			toolName: "edit",
			type: "tool_execution_end",
		} as AgentSessionEvent);
		prompt.resolve();
		await completed.promise;
		const eventCountAtTerminal = events.length;
		session.emit({
			args: { token: "STALE_SECRET" },
			toolCallId: "stale-after-terminal",
			toolName: "bash",
			type: "tool_execution_start",
		} as AgentSessionEvent);
		await Bun.sleep(0);
		expect(events).toHaveLength(eventCountAtTerminal);

		const toolEvents = events.filter(event => event.event.startsWith("tool_execution_"));
		expect(toolEvents.map(event => (event.event === "turn_completed" ? -1 : event.sequence))).toEqual([
			1, 2, 3, 4, 5,
		]);
		expect(toolEvents.map(event => event.event)).toEqual([
			"tool_execution_start",
			"tool_execution_start",
			"tool_execution_end",
			"tool_execution_update",
			"tool_execution_end",
		]);
		expect(events.at(-1)?.event).toBe("turn_completed");
		const serializedEvents = JSON.stringify(events);
		for (const secret of [
			"SECRET_ARGUMENT",
			"SECRET_SECOND_ARGUMENT",
			"SECRET_END_DETAILS",
			"SECRET_UPDATE_METADATA",
			"SECRET_RESULT",
			"SECRET_RESULT_DETAILS",
			"providerMetadata",
			"usage",
			"cost",
		]) {
			expect(serializedEvents).not.toContain(secret);
		}
		expect(serializedEvents).not.toContain('"phase"');

		const read = async () =>
			(await runtime.readThread({
				id: `read-tools-${crypto.randomUUID()}`,
				limit: 50,
				threadId: created.threadId,
				type: "thread_read",
			})) as { messages: Array<{ blocks: Array<{ blockType: string; id?: string }>; id: string }> };
		const liveSnapshot = await read();
		const liveToolBlocks = liveSnapshot.messages.filter(message => message.blocks[0]?.blockType === "tool_call");
		expect(liveToolBlocks.map(message => message.id)).toEqual(["tool:turn-tools:tool-b", "tool:turn-tools:tool-a"]);
		await runtime.dispose();

		runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => new FakeSession() });
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const restoredSnapshot = await read();
		const restoredToolBlocks = restoredSnapshot.messages.filter(
			message => message.blocks[0]?.blockType === "tool_call",
		);
		expect(restoredToolBlocks).toEqual(liveToolBlocks);
		expect(JSON.stringify(restoredToolBlocks)).not.toContain("SECRET_");
		await runtime.dispose();
	});

	test("closes a duplicate-start lifecycle before the failed terminal frame", async () => {
		const host = await temporaryHost();
		const prompt = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const order: string[] = [];
		const session = new FakeSession();
		session.onPrompt = () => prompt.promise;
		session.onAbort = () => prompt.resolve();
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => session });
		runtime.setEventSink(async event => {
			order.push(event.event);
			if (event.event === "turn_completed") {
				expect(event.outcome).toBe("failed");
				completed.resolve();
			}
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-duplicate-tool",
			modelId: "managed-model",
			operationId: "operation-duplicate-tool",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "start-duplicate-tool",
			message: "Use tool",
			threadId: created.threadId,
			turnId: "turn-duplicate-tool",
			type: "turn_start",
		});
		const start = {
			args: { command: "echo safe" },
			toolCallId: "tool-duplicate",
			toolName: "bash",
			type: "tool_execution_start",
		} as AgentSessionEvent;
		session.emit(start);
		session.emit(start);
		await completed.promise;
		expect(order).toEqual(["tool_execution_start", "tool_execution_end", "turn_completed"]);
		await runtime.dispose();
	});

	test("fails closed on update-before-start and emits no forged tool frame", async () => {
		const host = await temporaryHost();
		const prompt = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<EmpatraHostEvent>();
		const events: EmpatraHostEvent[] = [];
		const session = new FakeSession();
		session.onPrompt = () => prompt.promise;
		session.onAbort = () => prompt.resolve();
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => session });
		runtime.setEventSink(async event => {
			events.push(event);
			if (event.event === "turn_completed") completed.resolve(event);
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-invalid-tool",
			modelId: "managed-model",
			operationId: "operation-invalid-tool",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "start-invalid-tool",
			message: "Use tool",
			threadId: created.threadId,
			turnId: "turn-invalid-tool",
			type: "turn_start",
		});
		session.emit({
			args: {},
			partialResult: { content: [{ text: "forged", type: "text" }] },
			toolCallId: "tool-forged",
			toolName: "bash",
			type: "tool_execution_update",
		} as AgentSessionEvent);
		expect(await completed.promise).toMatchObject({ event: "turn_completed", outcome: "failed" });
		expect(events.some(event => event.event.startsWith("tool_execution_"))).toBe(false);
		await runtime.dispose();
	});

	test("rolls back complete turns by moving the active leaf and preserves the abandoned tree", async () => {
		const host = await temporaryHost();
		const factoryOptions: EmpatraHostSessionFactoryOptions[] = [];
		const completions = new Map<
			string,
			{ promise: Promise<void>; reject: (reason?: unknown) => void; resolve: () => void }
		>();
		const createRuntime = () => {
			const runtime = new EmpatraHostAgentRuntime({
				sessionFactory: async input => {
					factoryOptions.push(input);
					const session = new FakeSession();
					session.onPrompt = async () => {
						input.sessionManager.appendMessage({
							content: `message-${input.sessionManager.getEntries().length}`,
							role: "user",
							timestamp: Date.now(),
						});
					};
					return session;
				},
			});
			runtime.setEventSink(async event => {
				if (event.event === "turn_completed") completions.get(event.turnId)?.resolve();
			});
			return runtime;
		};
		let runtime = createRuntime();
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({
			cwd: host.workspace,
			id: "create-rollback",
			modelId: "managed-model",
			operationId: "operation-rollback",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		for (let index = 1; index <= 3; index++) {
			const turnId = `rollback-turn-${index}`;
			const completed = Promise.withResolvers<void>();
			completions.set(turnId, completed);
			await runtime.startTurn({
				expectedGeneration: (index - 1) * 2,
				id: `start-${turnId}`,
				message: `Prompt ${index}`,
				threadId: created.threadId,
				turnId,
				type: "turn_start",
			});
			await completed.promise;
		}
		const readBeforeRollback = (await runtime.readThread({
			id: "read-before-rollback",
			limit: 1,
			threadId: created.threadId,
			type: "thread_read",
		})) as { nextCursor: string | null };
		if (!readBeforeRollback.nextCursor) throw new Error("Expected rollback to invalidate a read cursor");
		const rolledBack = (await runtime.rollbackThread({
			id: "rollback-two",
			threadId: created.threadId,
			turns: 2,
			type: "thread_rollback",
		})) as { generation: number; rolledBackTurnIds: string[]; threadId: string };
		expect(rolledBack).toEqual({
			generation: 7,
			rolledBackTurnIds: ["rollback-turn-2", "rollback-turn-3"],
			threadId: created.threadId,
		});
		const activeTurns = (await runtime.listThreadTurns({
			id: "turns-after-rollback",
			limit: 10,
			sortDirection: "asc",
			threadId: created.threadId,
			type: "thread_turns",
		})) as { data: Array<{ id: string }> };
		expect(activeTurns.data.map(turn => turn.id)).toEqual(["rollback-turn-1"]);
		await expect(
			runtime.readThread({
				cursor: readBeforeRollback.nextCursor,
				id: "read-after-rollback-with-stale-cursor",
				limit: 1,
				threadId: created.threadId,
				type: "thread_read",
			}),
		).rejects.toMatchObject({ code: "stale_cursor" });
		const allEntries = factoryOptions[0]?.sessionManager.getEntries() ?? [];
		expect(
			allEntries.filter(entry => entry.type === "custom" && entry.customType === "empatra.host.turn.v1"),
		).toHaveLength(6);
		expect(
			allEntries.find(
				entry =>
					entry.type === "branch_summary" &&
					typeof entry.details === "object" &&
					entry.details !== null &&
					"kind" in entry.details &&
					entry.details.kind === "empatra.host.thread-rollback.v1",
			),
		).toBeDefined();
		await runtime.dispose();

		factoryOptions.length = 0;
		runtime = createRuntime();
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const restored = (await runtime.listThreadTurns({
			id: "turns-after-rollback-restart",
			limit: 10,
			threadId: created.threadId,
			type: "thread_turns",
		})) as { data: Array<{ id: string }> };
		expect(restored.data.map(turn => turn.id)).toEqual(["rollback-turn-1"]);
		await runtime.dispose();
	});

	test("fails closed when initialization roots do not exist", async () => {
		const host = await temporaryHost();
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => new FakeSession() });
		await expect(
			runtime.initialize(initializeCommand(path.join(host.root, "missing"), host.sessions)),
		).rejects.toBeInstanceOf(EmpatraHostProtocolError);
	});
});
