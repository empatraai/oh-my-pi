import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";

import {
	EMPATRA_HOST_USER_MEDIA_ENTRY,
	EmpatraHostAgentRuntime,
	type EmpatraHostImageDescriptor,
	type EmpatraHostInitializeCommand,
	type EmpatraHostSession,
	type EmpatraHostSessionFactoryOptions,
} from "../src/modes/empatra-host";
import type { AgentSessionEvent } from "../src/session/agent-session-events";
import type { SessionManager } from "../src/session/session-manager";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);
const temporaryRoots: string[] = [];

interface VoidDeferred {
	promise: Promise<void>;
	reject(reason?: unknown): void;
	resolve(value?: void | PromiseLike<void>): void;
}

class ImageSession implements EmpatraHostSession {
	readonly prompts: Array<{ images?: ImageContent[]; message: string }> = [];
	readonly steers: Array<{ images?: ImageContent[]; message: string }> = [];
	listener?: (event: AgentSessionEvent) => void;
	promptBarrier?: Promise<void>;
	promptError?: Error;
	steerError?: Error;

	async abort(): Promise<void> {}
	async compact(): Promise<void> {}
	async dispose(): Promise<void> {}
	async prompt(message: string, options?: { images?: ImageContent[] }): Promise<void> {
		this.prompts.push({ ...(options?.images ? { images: options.images } : {}), message });
		if (this.promptError) throw this.promptError;
		await this.promptBarrier;
	}
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		this.steers.push({ ...(images ? { images } : {}), message });
		if (this.steerError) throw this.steerError;
	}
	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listener = listener;
		return () => {
			if (this.listener === listener) this.listener = undefined;
		};
	}
}

class PersistingImageSession extends ImageSession {
	constructor(private readonly manager: SessionManager) {
		super();
	}

	override async prompt(message: string, options?: { images?: ImageContent[] }): Promise<void> {
		this.prompts.push({ ...(options?.images ? { images: options.images } : {}), message });
		if (this.promptError) throw this.promptError;
		this.#append(message, options?.images);
		await this.promptBarrier;
	}

	override async steer(message: string, images?: ImageContent[]): Promise<void> {
		await super.steer(message, images);
		this.#append(message, images);
	}

	#append(message: string, images?: ImageContent[]): void {
		this.manager.appendMessage({
			content: [...(message === "" ? [] : [{ text: message, type: "text" as const }]), ...(images ?? [])],
			role: "user",
			timestamp: Date.now(),
		});
	}
}

async function host() {
	const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "empatra-image-runtime-"));
	temporaryRoots.push(root);
	const sessions = path.join(root, "sessions");
	const workspace = path.join(root, "workspace");
	await mkdir(workspace);
	return { sessions, workspace };
}

function initializeCommand(workspace: string, sessionDirectory: string): EmpatraHostInitializeCommand {
	return {
		capability: "c".repeat(48),
		gatewayBaseUrl: "http://127.0.0.1:43123/v1",
		id: "initialize-images",
		models: [
			{
				api: "openai-responses",
				contextWindow: 200_000,
				id: "vision-model",
				input: ["text", "image"],
				maxTokens: 32_000,
				name: "Vision Model",
				reasoning: true,
				supportsTools: true,
			},
			{
				api: "openai-responses",
				contextWindow: 200_000,
				id: "text-model",
				input: ["text"],
				maxTokens: 32_000,
				name: "Text Model",
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

async function stage(sessionDirectory: string, bytes = TINY_PNG): Promise<EmpatraHostImageDescriptor> {
	const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	const shard = path.join(sessionDirectory, "media-input-v1", "sha256", sha256.slice(0, 2));
	await mkdir(shard, { recursive: true });
	await writeFile(path.join(shard, sha256), bytes);
	return { byteLength: bytes.byteLength, mimeType: "image/png", sha256 };
}

async function waitForCompletion(runtime: EmpatraHostAgentRuntime, action: () => Promise<unknown>): Promise<unknown> {
	const completion = Promise.withResolvers<void>();
	runtime.setEventSink(async event => {
		if (event.event === "turn_completed") completion.resolve();
	});
	const result = await action();
	await completion.promise;
	await Bun.sleep(0);
	return result;
}

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("Empatra host image runtime", () => {
	test("pairs durable steering media with the accepted user message inside the active turn", async () => {
		const directories = await host();
		const sessions: PersistingImageSession[] = [];
		const completion = Promise.withResolvers<void>();
		const runtime = new EmpatraHostAgentRuntime({
			sessionFactory: async input => {
				const session = new PersistingImageSession(input.sessionManager);
				sessions.push(session);
				return session;
			},
		});
		runtime.setEventSink(async event => {
			if (event.event === "turn_completed") completion.resolve();
		});
		await runtime.initialize(initializeCommand(directories.workspace, directories.sessions));
		const created = (await runtime.startThread({
			cwd: directories.workspace,
			id: "steer-media-create",
			modelId: "vision-model",
			operationId: "steer-media-operation",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		const barrier = Promise.withResolvers<void>();
		sessions[0]!.promptBarrier = barrier.promise;
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "steer-media-start",
			message: "Основной запрос",
			threadId: created.threadId,
			turnId: "steer-media-turn",
			type: "turn_start",
		});
		const rejectedImage = { ...(await stage(directories.sessions)), displayName: "Отменено.png" };
		sessions[0]!.steerError = new Error("rejected steer");
		await expect(
			runtime.steerTurn({
				expectedGeneration: 1,
				id: "steer-media-rejected",
				images: [rejectedImage],
				message: "Уточнение",
				threadId: created.threadId,
				turnId: "steer-media-turn",
				type: "turn_steer",
			}),
		).rejects.toThrow("rejected steer");
		sessions[0]!.steerError = undefined;
		const acceptedBytes = Buffer.concat([TINY_PNG, Buffer.from([1])]);
		const image = { ...(await stage(directories.sessions, acceptedBytes)), displayName: "Уточнение.png" };
		await runtime.steerTurn({
			expectedGeneration: 1,
			id: "steer-media",
			images: [image],
			message: "Уточнение",
			threadId: created.threadId,
			turnId: "steer-media-turn",
			type: "turn_steer",
		});
		const active = (await runtime.readThread({
			id: "steer-media-read",
			limit: 10,
			threadId: created.threadId,
			type: "thread_read",
		})) as { messages: Array<{ blocks: Array<Record<string, unknown>> }> };
		expect(active.messages).toHaveLength(2);
		expect(active.messages[1]?.blocks).toEqual([
			{ blockType: "text", text: "Уточнение" },
			expect.objectContaining({ blockType: "image", displayName: "Уточнение.png", sha256: image.sha256 }),
		]);
		barrier.resolve();
		await completion.promise;
		await runtime.dispose();
	});

	test("persists metadata-only image projection across reload, fork, rollback, and atomic replay", async () => {
		const directories = await host();
		const factories: EmpatraHostSessionFactoryOptions[] = [];
		const createRuntime = () =>
			new EmpatraHostAgentRuntime({
				sessionFactory: async input => {
					factories.push(input);
					return new PersistingImageSession(input.sessionManager);
				},
			});
		let runtime = createRuntime();
		await runtime.initialize(initializeCommand(directories.workspace, directories.sessions));
		const durablePng = Buffer.concat([TINY_PNG, Buffer.alloc(2_048)]);
		const image = {
			...(await stage(directories.sessions, durablePng)),
			detail: "high" as const,
			displayName: "/private/Схема.png",
		};
		const command = {
			cwd: directories.workspace,
			id: "durable-create",
			images: [image],
			message: "Изучи схему",
			modelId: "vision-model",
			operationId: "durable-operation",
			systemPrompt: "System",
			turnId: "durable-turn",
			type: "thread_create_and_start" as const,
		};
		const created = (await waitForCompletion(runtime, () => runtime.startThreadAndTurn(command))) as {
			threadId: string;
		};
		await expect(runtime.startThreadAndTurn({ ...command, id: "durable-replay" })).resolves.toMatchObject({
			threadId: created.threadId,
		});
		const firstManager = factories[0]?.sessionManager;
		if (!firstManager) throw new Error("Expected a session manager");
		const sessionFile = firstManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a durable session file");
		const persistedSession = await readFile(sessionFile, "utf8");
		expect(persistedSession).toContain(`blob:sha256:${image.sha256}`);
		expect(persistedSession).not.toContain(durablePng.toString("base64"));
		expect(
			firstManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === EMPATRA_HOST_USER_MEDIA_ENTRY),
		).toHaveLength(1);
		const read = (await runtime.readThread({
			id: "durable-read",
			limit: 10,
			threadId: created.threadId,
			type: "thread_read",
		})) as { messages: Array<{ blocks: Array<Record<string, unknown>> }> };
		expect(read.messages[0]?.blocks).toEqual([
			{ blockType: "text", text: "Изучи схему" },
			expect.objectContaining({
				blockType: "image",
				displayName: "Схема.png",
				heightPixels: 1,
				sha256: image.sha256,
				widthPixels: 1,
			}),
		]);
		expect(JSON.stringify(read.messages)).not.toContain("/private/Схема.png");

		const fork = (await runtime.forkThread({
			id: "durable-fork",
			operationId: "durable-fork-operation",
			threadId: created.threadId,
			type: "thread_fork",
		})) as { threadId: string };
		const forkRead = (await runtime.readThread({
			id: "durable-fork-read",
			limit: 10,
			threadId: fork.threadId,
			type: "thread_read",
		})) as { messages: Array<{ blocks: Array<Record<string, unknown>> }> };
		expect(forkRead.messages[0]?.blocks).toEqual(read.messages[0]?.blocks);
		await runtime.rollbackThread({
			id: "durable-rollback",
			threadId: created.threadId,
			turns: 1,
			type: "thread_rollback",
		});
		expect(
			(await runtime.readThread({
				id: "durable-after-rollback",
				limit: 10,
				threadId: created.threadId,
				type: "thread_read",
			})) as { messages: unknown[] },
		).toMatchObject({ messages: [] });
		await runtime.dispose();

		runtime = createRuntime();
		await runtime.initialize(initializeCommand(directories.workspace, directories.sessions));
		const reloadedFork = (await runtime.readThread({
			id: "durable-reload",
			limit: 10,
			threadId: fork.threadId,
			type: "thread_read",
		})) as { messages: Array<{ blocks: Array<Record<string, unknown>> }> };
		expect(reloadedFork.messages[0]?.blocks).toEqual(read.messages[0]?.blocks);
		await runtime.dispose();
	});

	test("bounds image admission process-wide and releases capacity after interrupt or completion", async () => {
		const directories = await host();
		const sessions: ImageSession[] = [];
		const runtime = new EmpatraHostAgentRuntime({
			sessionFactory: async () => {
				const session = new ImageSession();
				sessions.push(session);
				return session;
			},
		});
		const completions = new Map<string, VoidDeferred>();
		runtime.setEventSink(async event => {
			if (event.event === "turn_completed") completions.get(event.turnId)?.resolve();
		});
		await runtime.initialize(initializeCommand(directories.workspace, directories.sessions));
		const image = await stage(directories.sessions);
		const threads: string[] = [];
		for (let index = 0; index < 3; index += 1) {
			const created = (await runtime.startThread({
				cwd: directories.workspace,
				id: `capacity-create-${index}`,
				modelId: "vision-model",
				operationId: `capacity-create-operation-${index}`,
				systemPrompt: "System",
				type: "thread_create",
			})) as { threadId: string };
			threads.push(created.threadId);
		}
		const barriers = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		sessions[0]!.promptBarrier = barriers[0]!.promise;
		sessions[1]!.promptBarrier = barriers[1]!.promise;
		for (let index = 0; index < 2; index += 1) {
			const turnId = `capacity-turn-${index}`;
			completions.set(turnId, Promise.withResolvers<void>());
			await runtime.startTurn({
				expectedGeneration: 0,
				id: `capacity-start-${index}`,
				images: [image],
				message: "",
				threadId: threads[index]!,
				turnId,
				type: "turn_start",
			});
		}
		await expect(
			runtime.startTurn({
				expectedGeneration: 0,
				id: "capacity-start-rejected",
				images: [image],
				message: "",
				threadId: threads[2]!,
				turnId: "capacity-turn-rejected",
				type: "turn_start",
			}),
		).rejects.toMatchObject({ code: "image_capacity_exceeded" });
		const untouched = (await runtime.readThread({
			id: "capacity-read-rejected",
			limit: 10,
			threadId: threads[2]!,
			type: "thread_read",
		})) as { generation: number; messages: unknown[] };
		expect(untouched).toMatchObject({ generation: 0, messages: [] });

		await runtime.interruptTurn({
			expectedGeneration: 1,
			id: "capacity-interrupt-0",
			threadId: threads[0]!,
			turnId: "capacity-turn-0",
			type: "turn_interrupt",
		});
		const retryCompletion = Promise.withResolvers<void>();
		completions.set("capacity-turn-retry", retryCompletion);
		await expect(
			runtime.startTurn({
				expectedGeneration: 0,
				id: "capacity-start-retry",
				images: [image],
				message: "",
				threadId: threads[2]!,
				turnId: "capacity-turn-retry",
				type: "turn_start",
			}),
		).resolves.toMatchObject({ turnId: "capacity-turn-retry" });
		await retryCompletion.promise;
		barriers[0]!.resolve();
		await completions.get("capacity-turn-0")!.promise;
		barriers[1]!.resolve();
		await completions.get("capacity-turn-1")!.promise;
		await runtime.dispose();
	});

	test("releases image admission after prompt failures", async () => {
		const directories = await host();
		const sessions: ImageSession[] = [];
		const runtime = new EmpatraHostAgentRuntime({
			sessionFactory: async () => {
				const session = new ImageSession();
				sessions.push(session);
				return session;
			},
		});
		await runtime.initialize(initializeCommand(directories.workspace, directories.sessions));
		const image = await stage(directories.sessions);
		const threads: string[] = [];
		for (let index = 0; index < 3; index += 1) {
			const created = (await runtime.startThread({
				cwd: directories.workspace,
				id: `failure-create-${index}`,
				modelId: "vision-model",
				operationId: `failure-create-operation-${index}`,
				systemPrompt: "System",
				type: "thread_create",
			})) as { threadId: string };
			threads.push(created.threadId);
		}
		for (let index = 0; index < 2; index += 1) {
			sessions[index]!.promptError = new Error("provider failed");
			await waitForCompletion(runtime, () =>
				runtime.startTurn({
					expectedGeneration: 0,
					id: `failure-start-${index}`,
					images: [image],
					message: "",
					threadId: threads[index]!,
					turnId: `failure-turn-${index}`,
					type: "turn_start",
				}),
			);
		}
		await expect(
			waitForCompletion(runtime, () =>
				runtime.startTurn({
					expectedGeneration: 0,
					id: "failure-start-after-release",
					images: [image],
					message: "",
					threadId: threads[2]!,
					turnId: "failure-turn-after-release",
					type: "turn_start",
				}),
			),
		).resolves.toMatchObject({ turnId: "failure-turn-after-release" });
		await runtime.dispose();
	});

	test("passes image-only and mixed prompts through the native AgentSession API in order", async () => {
		const directories = await host();
		const sessions: ImageSession[] = [];
		const runtime = new EmpatraHostAgentRuntime({
			sessionFactory: async () => {
				const session = new ImageSession();
				sessions.push(session);
				return session;
			},
		});
		await runtime.initialize(initializeCommand(directories.workspace, directories.sessions));
		const image = await stage(directories.sessions);
		const created = (await runtime.startThread({
			cwd: directories.workspace,
			id: "create-vision",
			modelId: "vision-model",
			operationId: "create-vision-operation",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		await waitForCompletion(runtime, () =>
			runtime.startTurn({
				expectedGeneration: 0,
				id: "turn-image-only",
				images: [image],
				message: "",
				threadId: created.threadId,
				turnId: "turn-image-only",
				type: "turn_start",
			}),
		);
		await waitForCompletion(runtime, () =>
			runtime.startTurn({
				expectedGeneration: 2,
				id: "turn-mixed",
				images: [{ ...image, detail: "low" }],
				message: "Опиши изображение",
				threadId: created.threadId,
				turnId: "turn-mixed",
				type: "turn_start",
			}),
		);
		expect(sessions[0]?.prompts.map(prompt => prompt.message)).toEqual(["", "Опиши изображение"]);
		expect(sessions[0]?.prompts[0]?.images?.[0]?.type).toBe("image");
		expect(sessions[0]?.prompts[1]?.images?.[0]?.detail).toBe("low");
		await runtime.dispose();
	});

	test("validates image steering before handing it to the active session", async () => {
		const directories = await host();
		const session = new ImageSession();
		const barrier = Promise.withResolvers<void>();
		session.promptBarrier = barrier.promise;
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => session });
		await runtime.initialize(initializeCommand(directories.workspace, directories.sessions));
		const image = await stage(directories.sessions);
		const created = (await runtime.startThread({
			cwd: directories.workspace,
			id: "create-steer",
			modelId: "vision-model",
			operationId: "create-steer-operation",
			systemPrompt: "System",
			type: "thread_create",
		})) as { threadId: string };
		await runtime.startTurn({
			expectedGeneration: 0,
			id: "start-steer",
			message: "Начни",
			threadId: created.threadId,
			turnId: "turn-steer",
			type: "turn_start",
		});
		await runtime.steerTurn({
			expectedGeneration: 1,
			id: "steer-image",
			images: [image],
			message: "Учти это",
			threadId: created.threadId,
			turnId: "turn-steer",
			type: "turn_steer",
		});
		await runtime.steerTurn({
			expectedGeneration: 1,
			id: "steer-image-second",
			images: [image],
			message: "И это тоже",
			threadId: created.threadId,
			turnId: "turn-steer",
			type: "turn_steer",
		});
		await expect(
			runtime.steerTurn({
				expectedGeneration: 1,
				id: "steer-image-capacity",
				images: [image],
				message: "Лишнее изображение",
				threadId: created.threadId,
				turnId: "turn-steer",
				type: "turn_steer",
			}),
		).rejects.toMatchObject({ code: "image_capacity_exceeded" });
		expect(session.steers.map(steer => steer.message)).toEqual(["Учти это", "И это тоже"]);
		expect(session.steers.every(steer => steer.images?.length === 1)).toBe(true);
		barrier.resolve();
		await runtime.dispose();
	});

	test("rejects invalid or unsupported images before turn history and generation mutation", async () => {
		const directories = await host();
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => new ImageSession() });
		await runtime.initialize(initializeCommand(directories.workspace, directories.sessions));
		for (const modelId of ["vision-model", "text-model"] as const) {
			const created = (await runtime.startThread({
				cwd: directories.workspace,
				id: `create-${modelId}`,
				modelId,
				operationId: `create-${modelId}-operation`,
				systemPrompt: "System",
				type: "thread_create",
			})) as { threadId: string };
			const missing = {
				byteLength: TINY_PNG.byteLength,
				mimeType: "image/png" as const,
				sha256: "f".repeat(64),
			};
			await expect(
				runtime.startTurn({
					expectedGeneration: 0,
					id: `invalid-${modelId}`,
					images: [missing],
					message: "",
					threadId: created.threadId,
					turnId: `invalid-${modelId}`,
					type: "turn_start",
				}),
			).rejects.toMatchObject({
				code: modelId === "text-model" ? "model_input_unsupported" : "image_input_invalid",
			});
			const read = (await runtime.readThread({
				id: `read-${modelId}`,
				limit: 10,
				threadId: created.threadId,
				type: "thread_read",
			})) as { generation: number; messages: unknown[] };
			const turns = (await runtime.listThreadTurns({
				id: `turns-${modelId}`,
				limit: 10,
				threadId: created.threadId,
				type: "thread_turns",
			})) as { data: unknown[] };
			expect(read.generation).toBe(0);
			expect(read.messages).toEqual([]);
			expect(turns.data).toEqual([]);
		}
		await runtime.dispose();
	});

	test("binds ordered image descriptors into atomic create-and-start replay identity", async () => {
		const directories = await host();
		const sessions: ImageSession[] = [];
		const runtime = new EmpatraHostAgentRuntime({
			sessionFactory: async () => {
				const session = new ImageSession();
				sessions.push(session);
				return session;
			},
		});
		await runtime.initialize(initializeCommand(directories.workspace, directories.sessions));
		const image = await stage(directories.sessions);
		const command = {
			cwd: directories.workspace,
			id: "atomic-image",
			images: [image],
			message: "",
			modelId: "vision-model",
			operationId: "atomic-image-operation",
			systemPrompt: "System",
			turnId: "atomic-image-turn",
			type: "thread_create_and_start" as const,
		};
		const first = await waitForCompletion(runtime, () => runtime.startThreadAndTurn(command));
		await rm(path.join(directories.sessions, "media-input-v1"), { force: true, recursive: true });
		await expect(runtime.startThreadAndTurn({ ...command, id: "atomic-image-replay" })).resolves.toEqual(first);
		await expect(
			runtime.startThreadAndTurn({
				...command,
				id: "atomic-image-conflict",
				images: [{ ...image, detail: "high" }],
			}),
		).rejects.toMatchObject({ code: "operation_conflict" });
		expect(sessions[0]?.prompts).toHaveLength(1);
		const forkImage = await stage(directories.sessions);
		const created = first as { threadId: string };
		await waitForCompletion(runtime, () =>
			runtime.forkThreadAndStart({
				id: "atomic-image-fork",
				images: [{ ...forkImage, detail: "auto" }],
				message: "Сравни изображение",
				operationId: "atomic-image-fork-operation",
				threadId: created.threadId,
				turnId: "atomic-image-fork-turn",
				type: "thread_fork_and_start",
			}),
		);
		expect(sessions.at(-1)?.prompts[0]?.images?.[0]?.detail).toBe("auto");
		await runtime.dispose();
	});

	test("preflights atomic create and fork images before creating a thread or receipt", async () => {
		const directories = await host();
		const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => new ImageSession() });
		await runtime.initialize(initializeCommand(directories.workspace, directories.sessions));
		const missing = {
			byteLength: TINY_PNG.byteLength,
			mimeType: "image/png" as const,
			sha256: "e".repeat(64),
		};
		const createCommand = {
			cwd: directories.workspace,
			id: "invalid-atomic-create",
			images: [missing],
			message: "",
			modelId: "vision-model",
			operationId: "invalid-atomic-create-operation",
			systemPrompt: "System",
			turnId: "invalid-atomic-create-turn",
			type: "thread_create_and_start" as const,
		};
		await expect(runtime.startThreadAndTurn(createCommand)).rejects.toMatchObject({ code: "image_input_invalid" });
		const empty = (await runtime.listThreads({
			id: "list-after-invalid-create",
			limit: 10,
			offset: 0,
			type: "thread_list",
		})) as { threads: unknown[] };
		expect(empty.threads).toEqual([]);
		const created = (await waitForCompletion(runtime, () =>
			runtime.startThreadAndTurn({
				...createCommand,
				id: "valid-atomic-create-retry",
				images: undefined,
				message: "Создай тред",
			}),
		)) as { threadId: string };

		const forkCommand = {
			id: "invalid-atomic-fork",
			images: [missing],
			message: "",
			operationId: "invalid-atomic-fork-operation",
			threadId: created.threadId,
			turnId: "invalid-atomic-fork-turn",
			type: "thread_fork_and_start" as const,
		};
		await expect(runtime.forkThreadAndStart(forkCommand)).rejects.toMatchObject({ code: "image_input_invalid" });
		const afterInvalidFork = (await runtime.listThreads({
			id: "list-after-invalid-fork",
			limit: 10,
			offset: 0,
			type: "thread_list",
		})) as { threads: unknown[] };
		expect(afterInvalidFork.threads).toHaveLength(1);
		await expect(
			waitForCompletion(runtime, () =>
				runtime.forkThreadAndStart({
					...forkCommand,
					id: "valid-atomic-fork-retry",
					images: undefined,
					message: "Создай форк",
				}),
			),
		).resolves.toMatchObject({ turnId: forkCommand.turnId });
		await runtime.dispose();
	});
});
