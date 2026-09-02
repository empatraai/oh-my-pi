import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import * as path from "node:path";

import {
	digestEmpatraHostAtomicInput,
	digestEmpatraHostImageDescriptors,
	EmpatraHostAgentRuntime,
	EmpatraHostAtomicOperationStore,
	type EmpatraHostEvent,
	type EmpatraHostInitializeCommand,
	type EmpatraHostSession,
	type EmpatraHostSessionFactoryOptions,
} from "../src/modes/empatra-host";
import type { AgentSessionEvent } from "../src/session/agent-session-events";

const temporaryRoots: string[] = [];

async function temporaryHost() {
	const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "empatra-omp-atomic-"));
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
		id: "initialize-atomic",
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
		sessionDirectory,
		type: "host_initialize",
		workspaceRoots: [workspace],
	};
}

class AtomicFakeSession implements EmpatraHostSession {
	readonly prompts: string[] = [];
	listener?: (event: AgentSessionEvent) => void;
	onPrompt?: (message: string) => Promise<void>;

	async abort(): Promise<void> {}
	async compact(): Promise<void> {}
	async dispose(): Promise<void> {}
	async prompt(message: string): Promise<void> {
		this.prompts.push(message);
		await this.onPrompt?.(message);
	}
	async steer(): Promise<void> {}

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

describe("Empatra host atomic create/fork and start", () => {
	test("persists a secret-free receipt, starts once, and rejects digest conflicts", async () => {
		const host = await temporaryHost();
		const sessions: AtomicFakeSession[] = [];
		const factoryOptions: EmpatraHostSessionFactoryOptions[] = [];
		const completed = Promise.withResolvers<EmpatraHostEvent>();
		const runtime = new EmpatraHostAgentRuntime({
			sessionFactory: async options => {
				factoryOptions.push(options);
				const session = new AtomicFakeSession();
				sessions.push(session);
				return session;
			},
		});
		runtime.setEventSink(async event => {
			if (event.event === "turn_completed") completed.resolve(event);
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const command = {
			approvalMode: "yolo" as const,
			cwd: await realpath(host.workspace),
			id: "atomic-create-1",
			message: "SECRET_ATOMIC_MESSAGE",
			modelId: "managed-model",
			operationId: "atomic-operation-1",
			systemPrompt: "SECRET_ATOMIC_SYSTEM",
			turnId: "atomic-turn-1",
			type: "thread_create_and_start" as const,
		};
		const first = (await runtime.startThreadAndTurn(command)) as {
			generation: number;
			operationId: string;
			threadId: string;
			turnId: string;
		};
		expect(first).toMatchObject({ generation: 1, operationId: command.operationId, turnId: command.turnId });
		expect(await completed.promise).toMatchObject({ outcome: "completed", turnId: command.turnId });
		expect(await runtime.startThreadAndTurn({ ...command, id: "atomic-create-repeat" })).toEqual(first);
		expect(sessions[0]?.prompts).toEqual([command.message]);
		expect(factoryOptions[0]?.settings.get("tools.approvalMode")).toBe("yolo");
		expect(
			await runtime.getAtomicOperationStatus({
				id: "atomic-status-1",
				operationId: command.operationId,
				type: "atomic_operation_status",
			}),
		).toMatchObject({
			generation: 1,
			kind: "create_and_start",
			operationId: command.operationId,
			status: "completed",
			threadId: first.threadId,
			turnId: command.turnId,
		});
		expect(
			await runtime.getAtomicOperationStatus({
				id: "atomic-status-missing",
				operationId: "missing-operation",
				type: "atomic_operation_status",
			}),
		).toEqual({ operationId: "missing-operation", status: "missing" });
		await expect(
			runtime.startThreadAndTurn({
				...command,
				approvalMode: "always-ask",
				id: "atomic-create-conflict",
				message: "Different input",
			}),
		).rejects.toMatchObject({ code: "operation_conflict" });

		const metadataPath = path.join(host.sessions, "runtime", "empatra-host-metadata.sqlite3");
		const databaseBytes = Buffer.from(await Bun.file(metadataPath).arrayBuffer());
		expect(databaseBytes.includes(Buffer.from(command.message))).toBe(false);
		expect(databaseBytes.includes(Buffer.from(command.systemPrompt))).toBe(false);
		expect(databaseBytes.includes(Buffer.from("c".repeat(48)))).toBe(false);
		await runtime.dispose();
	});

	test("resumes an accepted pre-dispatch receipt after restart and fails closed once dispatch is uncertain", async () => {
		const host = await temporaryHost();
		const command = {
			cwd: host.workspace,
			id: "atomic-recovery",
			message: "Recover this exact input",
			modelId: "managed-model",
			operationId: "atomic-recovery-operation",
			systemPrompt: "Recovery system",
			turnId: "atomic-recovery-turn",
			type: "thread_create_and_start" as const,
		};
		let runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => new AtomicFakeSession() });
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const created = (await runtime.startThread({ ...command, type: "thread_create" })) as { threadId: string };
		const digest = digestEmpatraHostAtomicInput([
			"empatra.host.create-and-start.v3",
			command.operationId,
			command.cwd,
			command.modelId,
			command.systemPrompt,
			command.message,
			digestEmpatraHostImageDescriptors(undefined),
			command.turnId,
		]);
		const metadataPath = path.join(host.sessions, "runtime", "empatra-host-metadata.sqlite3");
		const store = new EmpatraHostAtomicOperationStore(metadataPath);
		store.accept({
			generation: 1,
			inputSha256: digest,
			kind: "create_and_start",
			operationId: command.operationId,
			threadId: created.threadId,
			turnId: command.turnId,
		});
		store.close();
		await runtime.dispose();

		const recoveredSessions: AtomicFakeSession[] = [];
		const completed = Promise.withResolvers<void>();
		runtime = new EmpatraHostAgentRuntime({
			sessionFactory: async () => {
				const session = new AtomicFakeSession();
				recoveredSessions.push(session);
				return session;
			},
		});
		runtime.setEventSink(async event => {
			if (event.event === "turn_completed") completed.resolve();
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const restoredConfig = (await runtime.readThread({
			id: "read-recovered-config",
			limit: 1,
			threadId: created.threadId,
			type: "thread_read",
		})) as {
			thread: {
				archived: boolean;
				cwd: string;
				id: string;
				modelId: string;
				systemPromptSha256: string;
				title: string | null;
			};
		};
		expect(restoredConfig.thread).toEqual({
			archived: false,
			cwd: await realpath(host.workspace),
			id: created.threadId,
			modelId: command.modelId,
			systemPromptSha256: new Bun.CryptoHasher("sha256").update(command.systemPrompt).digest("hex"),
			title: null,
		});
		await expect(runtime.startThreadAndTurn(command)).resolves.toMatchObject({
			threadId: created.threadId,
			turnId: command.turnId,
		});
		await completed.promise;
		expect(recoveredSessions[0]?.prompts).toEqual([command.message]);
		await runtime.dispose();

		const uncertainCommand = {
			...command,
			id: "atomic-uncertain",
			operationId: "atomic-uncertain-operation",
			turnId: "atomic-uncertain-turn",
		};
		runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => new AtomicFakeSession() });
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const uncertainThread = (await runtime.startThread({ ...uncertainCommand, type: "thread_create" })) as {
			threadId: string;
		};
		const uncertainDigest = digestEmpatraHostAtomicInput([
			"empatra.host.create-and-start.v3",
			uncertainCommand.operationId,
			uncertainCommand.cwd,
			uncertainCommand.modelId,
			uncertainCommand.systemPrompt,
			uncertainCommand.message,
			digestEmpatraHostImageDescriptors(undefined),
			uncertainCommand.turnId,
		]);
		const uncertainStore = new EmpatraHostAtomicOperationStore(metadataPath);
		uncertainStore.accept({
			generation: 1,
			inputSha256: uncertainDigest,
			kind: "create_and_start",
			operationId: uncertainCommand.operationId,
			threadId: uncertainThread.threadId,
			turnId: uncertainCommand.turnId,
		});
		uncertainStore.markDispatching(uncertainCommand.operationId, uncertainDigest);
		uncertainStore.close();
		await runtime.dispose();

		runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => new AtomicFakeSession() });
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		await expect(runtime.startThreadAndTurn(uncertainCommand)).rejects.toMatchObject({
			code: "atomic_operation_uncertain",
		});
		await runtime.dispose();
	});

	test("forks and starts once while preserving the source configuration", async () => {
		const host = await temporaryHost();
		const factoryOptions: EmpatraHostSessionFactoryOptions[] = [];
		const completed = Promise.withResolvers<void>();
		const runtime = new EmpatraHostAgentRuntime({
			sessionFactory: async options => {
				factoryOptions.push(options);
				return new AtomicFakeSession();
			},
		});
		runtime.setEventSink(async event => {
			if (event.event === "turn_completed") completed.resolve();
		});
		await runtime.initialize(initializeCommand(host.workspace, host.sessions));
		const source = (await runtime.startThread({
			cwd: host.workspace,
			id: "fork-source",
			modelId: "managed-model",
			operationId: "fork-source-operation",
			systemPrompt: "Fork source system",
			type: "thread_create",
		})) as { threadId: string };
		const command = {
			id: "fork-atomic",
			message: "Start the fork",
			operationId: "fork-atomic-operation",
			threadId: source.threadId,
			turnId: "fork-atomic-turn",
			type: "thread_fork_and_start" as const,
		};
		const forked = (await runtime.forkThreadAndStart(command)) as { threadId: string; turnId: string };
		await completed.promise;
		expect(forked.threadId).not.toBe(source.threadId);
		expect(forked.turnId).toBe(command.turnId);
		expect(factoryOptions.at(-1)?.systemPrompt).toBe("Fork source system");
		await expect(runtime.forkThreadAndStart({ ...command, id: "fork-atomic-repeat" })).resolves.toEqual(forked);
		await runtime.dispose();
	});
});
