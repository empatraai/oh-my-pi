import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as path from "node:path";

import type { ExtensionUIContext } from "../src/extensibility/extensions/types";
import {
	EmpatraHostAgentRuntime,
	type EmpatraHostEvent,
	type EmpatraHostInitializeCommand,
	type EmpatraHostSession,
} from "../src/modes/empatra-host";
import type { AgentSessionEvent } from "../src/session/agent-session-events";

const temporaryRoots: string[] = [];

class InteractionSession implements EmpatraHostSession {
	ui?: ExtensionUIContext;
	onPrompt?: (ui: ExtensionUIContext) => Promise<void>;

	async abort(): Promise<void> {}
	async compact(): Promise<void> {}
	async dispose(): Promise<void> {}
	async prompt(): Promise<void> {
		if (!this.ui) throw new Error("interaction UI was not installed");
		await this.onPrompt?.(this.ui);
	}
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		if (!hasUI) throw new Error("interaction UI must be enabled");
		this.ui = uiContext;
	}
	async steer(): Promise<void> {}
	subscribe(_listener: (event: AgentSessionEvent) => void): () => void {
		return () => {};
	}
}

async function temporaryHost() {
	const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "empatra-omp-interaction-"));
	temporaryRoots.push(root);
	const workspace = path.join(root, "workspace");
	const sessions = path.join(root, "sessions");
	await mkdir(workspace);
	return { sessions, workspace };
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

async function createRuntime(session: InteractionSession) {
	const host = await temporaryHost();
	const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => session });
	await runtime.initialize(initializeCommand(host.workspace, host.sessions));
	const created = (await runtime.startThread({
		cwd: host.workspace,
		id: "create-1",
		modelId: "managed-model",
		operationId: "operation-1",
		systemPrompt: "Empatra system prompt",
		type: "thread_create",
	})) as { generation: number; threadId: string };
	return { created, runtime };
}

function captureEvents(runtime: EmpatraHostAgentRuntime) {
	const interaction = Promise.withResolvers<Extract<EmpatraHostEvent, { event: "interaction_requested" }>>();
	const completion = Promise.withResolvers<Extract<EmpatraHostEvent, { event: "turn_completed" }>>();
	runtime.setEventSink(async event => {
		if (event.event === "interaction_requested") interaction.resolve(event);
		if (event.event === "turn_completed") completion.resolve(event);
	});
	return { completion: completion.promise, interaction: interaction.promise };
}

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("Empatra host interaction runtime", () => {
	test("round-trips an approval on the exact active turn and rejects forgery and replay", async () => {
		const session = new InteractionSession();
		const { created, runtime } = await createRuntime(session);
		const events = captureEvents(runtime);
		const exactInput = '{"command":"git status"}';
		session.onPrompt = async ui => {
			const selection = await ui.select("Allow tool?", ["Approve", "Deny"], {
				internalApprovalContext: {
					inputDigest: Bun.SHA256.hash(exactInput, "hex"),
					rawInput: exactInput,
					toolCallId: "call-1",
					toolName: "bash",
				},
			});
			if (selection !== "Approve") throw new Error("approval was not granted");
		};
		const started = (await runtime.startTurn({
			expectedGeneration: created.generation,
			id: "start-1",
			message: "Run status",
			threadId: created.threadId,
			turnId: "turn-1",
			type: "turn_start",
		})) as { generation: number };
		const requested = await events.interaction;
		expect(requested).toMatchObject({ generation: started.generation, sequence: 1, turnId: "turn-1" });
		if (requested.request.kind !== "approval") throw new Error("approval request was not emitted");
		expect(requested.request).toMatchObject({
			displayInput: exactInput,
			inputDigest: Bun.SHA256.hash(exactInput, "hex"),
			threadId: created.threadId,
			turnId: "turn-1",
		});

		await expect(
			runtime.respondToInteraction({
				digest: `sha256:${"0".repeat(64)}`,
				expectedGeneration: started.generation,
				id: "forged-1",
				requestId: requested.request.requestId,
				response: { decision: "approve", kind: "approval_response" },
				threadId: created.threadId,
				turnId: "turn-1",
				type: "interaction_respond",
			}),
		).rejects.toMatchObject({ code: "identity_mismatch" });

		await expect(
			runtime.respondToInteraction({
				digest: requested.request.digest,
				expectedGeneration: started.generation,
				id: "approve-1",
				requestId: requested.request.requestId,
				response: { decision: "approve", kind: "approval_response" },
				threadId: created.threadId,
				turnId: "turn-1",
				type: "interaction_respond",
			}),
		).resolves.toMatchObject({ accepted: true });
		expect(await events.completion).toMatchObject({ outcome: "completed", turnId: "turn-1" });
		await expect(
			runtime.respondToInteraction({
				digest: requested.request.digest,
				expectedGeneration: started.generation,
				id: "replay-1",
				requestId: requested.request.requestId,
				response: { decision: "approve", kind: "approval_response" },
				threadId: created.threadId,
				turnId: "turn-1",
				type: "interaction_respond",
			}),
		).rejects.toMatchObject({ code: "stale_turn" });
		await runtime.dispose();
	});

	test("cancels pending user input on interrupt and permits lifecycle deletion afterwards", async () => {
		const session = new InteractionSession();
		const { created, runtime } = await createRuntime(session);
		const events = captureEvents(runtime);
		session.onPrompt = async ui => {
			await ui.editor("Edit", "draft");
		};
		const started = (await runtime.startTurn({
			expectedGeneration: created.generation,
			id: "start-2",
			message: "Ask",
			threadId: created.threadId,
			turnId: "turn-2",
			type: "turn_start",
		})) as { generation: number };
		const requested = await events.interaction;
		expect(requested.request).toMatchObject({ inputKind: "editor", kind: "user_input" });
		await runtime.interruptTurn({
			expectedGeneration: started.generation,
			id: "interrupt-2",
			threadId: created.threadId,
			turnId: "turn-2",
			type: "turn_interrupt",
		});
		expect(await events.completion).toMatchObject({ outcome: "interrupted", turnId: "turn-2" });
		await expect(
			runtime.deleteThread({ id: "delete-2", threadId: created.threadId, type: "thread_delete" }),
		).resolves.toMatchObject({ deleted: true });
		await runtime.dispose();
	});

	test("routes activity and explicit cancellation without accepting a late response", async () => {
		const session = new InteractionSession();
		const { created, runtime } = await createRuntime(session);
		const events = captureEvents(runtime);
		session.onPrompt = async ui => {
			await ui.input("Value");
		};
		const started = (await runtime.startTurn({
			expectedGeneration: created.generation,
			id: "start-3",
			message: "Ask",
			threadId: created.threadId,
			turnId: "turn-3",
			type: "turn_start",
		})) as { generation: number };
		const requested = await events.interaction;
		await expect(
			runtime.noteInteractionActivity({
				digest: requested.request.digest,
				expectedGeneration: started.generation,
				id: "activity-3",
				requestId: requested.request.requestId,
				threadId: created.threadId,
				turnId: "turn-3",
				type: "interaction_activity",
			}),
		).resolves.toEqual({ expiresAt: requested.request.expiresAt, requestId: requested.request.requestId });
		await expect(
			runtime.cancelInteraction({
				digest: requested.request.digest,
				expectedGeneration: started.generation,
				id: "cancel-3",
				requestId: requested.request.requestId,
				threadId: created.threadId,
				turnId: "turn-3",
				type: "interaction_cancel",
			}),
		).resolves.toMatchObject({ cancelled: true });
		expect(await events.completion).toMatchObject({ outcome: "failed", turnId: "turn-3" });
		await expect(
			runtime.respondToInteraction({
				digest: requested.request.digest,
				expectedGeneration: started.generation,
				id: "late-3",
				requestId: requested.request.requestId,
				response: { inputKind: "input", kind: "user_input_response", value: "late" },
				threadId: created.threadId,
				turnId: "turn-3",
				type: "interaction_respond",
			}),
		).rejects.toMatchObject({ code: "stale_turn" });
		await runtime.dispose();
	});
});
