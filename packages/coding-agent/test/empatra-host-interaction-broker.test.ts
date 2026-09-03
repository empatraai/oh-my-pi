import { describe, expect, test } from "bun:test";

import type { ExtensionUIContext } from "../src/extensibility/extensions/types";
import {
	createEmpatraHostInteractionUIContext,
	EMPATRA_HOST_MAX_PENDING_INTERACTIONS,
	EMPATRA_HOST_MAX_PENDING_INTERACTIONS_PER_THREAD,
	EmpatraHostInteractionBroker,
	EmpatraHostInteractionError,
	type EmpatraHostInteractionRequest,
} from "../src/modes/empatra-host/interaction-broker";

function interactionScope(threadId: string) {
	return { generation: 1, threadId, turnId: "turn-1" } as const;
}

function sequentialIds(prefix = "request"): () => string {
	let next = 0;
	return () => `${prefix}-${++next}`;
}

function responseIdentity(request: EmpatraHostInteractionRequest) {
	return { digest: request.digest, requestId: request.requestId };
}

describe("EmpatraHostInteractionBroker", () => {
	test("projects tool approval metadata into an exact digest-bound request", async () => {
		let emitted: EmpatraHostInteractionRequest | undefined;
		const broker = new EmpatraHostInteractionBroker({
			createRequestId: sequentialIds(),
			emitRequest: request => {
				emitted = request;
			},
			now: () => 1_000,
		});

		const selection = broker.select(interactionScope("thread-1"), "Allow tool?", ["Approve", "Deny"], {
			internalApprovalContext: {
				inputDigest: Bun.SHA256.hash('{"command":"pwd"}', "hex"),
				rawInput: '{"command":"pwd"}',
				toolCallId: "call-1",
				toolName: "bash",
			},
		});
		if (emitted?.kind !== "approval") throw new Error("approval request was not emitted");
		expect(emitted).toMatchObject({
			createdAt: 1_000,
			expiresAt: 301_000,
			prompt: "Allow tool?",
			displayInput: '{"command":"pwd"}',
			generation: 1,
			inputDigest: Bun.SHA256.hash('{"command":"pwd"}', "hex"),
			requestId: "request-1",
			threadId: "thread-1",
			toolCallId: "call-1",
			toolName: "bash",
			turnId: "turn-1",
		});
		expect(emitted.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

		expect(
			broker.resolveResponse({
				...responseIdentity(emitted),
				decision: "approve",
				kind: "approval_response",
			}),
		).toEqual({ accepted: true });
		expect(broker.pendingCount).toBe(0);
		await expect(selection).resolves.toBe("Approve");
		expect(
			broker.resolveResponse({
				...responseIdentity(emitted),
				decision: "deny",
				kind: "approval_response",
			}),
		).toEqual({ accepted: false, code: "not_pending" });
	});

	test("fails closed on digest mismatch, invalid payload, and late responses", async () => {
		const requests: EmpatraHostInteractionRequest[] = [];
		const broker = new EmpatraHostInteractionBroker({
			createRequestId: sequentialIds(),
			emitRequest: request => {
				requests.push(request);
			},
		});
		const first = broker.confirm(interactionScope("thread-1"), "Confirm", "Continue?");
		const firstRequest = requests[0];
		if (!firstRequest) throw new Error("confirm request was not emitted");
		expect(
			broker.resolveResponse({
				digest: "sha256:secret-controller-value",
				inputKind: "confirm",
				kind: "user_input_response",
				requestId: firstRequest.requestId,
				value: true,
			}),
		).toEqual({ accepted: false, code: "identity_mismatch" });
		expect(broker.pendingCount).toBe(1);

		expect(
			broker.resolveResponse({
				...responseIdentity(firstRequest),
				inputKind: "confirm",
				kind: "user_input_response",
				value: true,
			}),
		).toEqual({ accepted: true });
		await expect(first).resolves.toBe(true);

		const second = broker.confirm(interactionScope("thread-1"), "Confirm", "Continue?");
		const secondRequest = requests[1];
		if (!secondRequest) throw new Error("second confirm request was not emitted");
		expect(
			broker.resolveResponse({
				...responseIdentity(secondRequest),
				extra: "not accepted",
				inputKind: "confirm",
				kind: "user_input_response",
				value: true,
			}),
		).toEqual({ accepted: false, code: "invalid_response" });
		expect(broker.pendingCount).toBe(1);
		broker.cancelThread("thread-1");
		await expect(second).rejects.toBeInstanceOf(EmpatraHostInteractionError);
	});

	test("validates select responses and preserves the rest of the supplied UI context", async () => {
		let emitted: EmpatraHostInteractionRequest | undefined;
		const broker = new EmpatraHostInteractionBroker({
			createRequestId: sequentialIds(),
			emitRequest: request => {
				emitted = request;
			},
		});
		const base = {
			notify: () => undefined,
		} as unknown as ExtensionUIContext;
		const context = createEmpatraHostInteractionUIContext({
			base,
			broker,
			getScope: () => interactionScope("thread-7"),
		});

		const selected = context.select("Mode", [{ label: "Safe", description: "Recommended" }, "Fast"]);
		if (emitted?.kind !== "user_input" || emitted.inputKind !== "select") {
			throw new Error("select request was not emitted");
		}
		expect(emitted.options).toEqual([{ description: "Recommended", label: "Safe" }, { label: "Fast" }]);
		expect(() => context.notify("safe")).not.toThrow();
		expect(
			broker.resolveResponse({
				...responseIdentity(emitted),
				inputKind: "select",
				kind: "user_input_response",
				value: "Safe",
			}),
		).toEqual({ accepted: true });
		await expect(selected).resolves.toBe("Safe");
	});

	test("round-trips editor and strictly validates rich ask results", async () => {
		const requests: EmpatraHostInteractionRequest[] = [];
		const broker = new EmpatraHostInteractionBroker({
			createRequestId: sequentialIds(),
			emitRequest: request => {
				requests.push(request);
			},
		});
		const context = createEmpatraHostInteractionUIContext({
			broker,
			getScope: () => interactionScope("thread-rich"),
		});
		const edited = context.editor("Edit", "draft", undefined, { promptStyle: true });
		const editorRequest = requests[0];
		if (editorRequest?.kind !== "user_input" || editorRequest.inputKind !== "editor") {
			throw new Error("editor request was not emitted");
		}
		expect(editorRequest).toMatchObject({ prefill: "draft", promptStyle: true, title: "Edit" });
		expect(
			broker.resolveResponse({
				...responseIdentity(editorRequest),
				inputKind: "editor",
				kind: "user_input_response",
				value: "edited",
			}),
		).toEqual({ accepted: true });
		await expect(edited).resolves.toBe("edited");

		const questions = [
			{
				id: "choice",
				multi: false,
				options: [{ label: "Safe" }, { label: "Fast" }],
				question: "Mode?",
			},
		];
		const answer = context.askDialog?.(questions);
		const askRequest = requests[1];
		if (!answer || askRequest?.kind !== "user_input" || askRequest.inputKind !== "ask_dialog") {
			throw new Error("ask request was not emitted");
		}
		expect(
			broker.resolveResponse({
				...responseIdentity(askRequest),
				inputKind: "ask_dialog",
				kind: "user_input_response",
				value: {
					kind: "submit",
					results: [
						{
							customInput: { injected: true },
							id: "choice",
							multi: false,
							options: ["Safe", "Fast"],
							question: "Mode?",
							selectedOptions: ["Safe"],
						},
					],
				},
			}),
		).toEqual({ accepted: false, code: "invalid_response" });
		expect(broker.pendingCount).toBe(1);
		const validValue = {
			kind: "submit" as const,
			results: [
				{
					id: "choice",
					multi: false,
					options: ["Safe", "Fast"],
					question: "Mode?",
					selectedOptions: ["Safe"],
				},
			],
		};
		expect(
			broker.resolveResponse({
				...responseIdentity(askRequest),
				inputKind: "ask_dialog",
				kind: "user_input_response",
				value: validValue,
			}),
		).toEqual({ accepted: true });
		await expect(answer).resolves.toEqual(validValue);
	});

	test("binds stateful base methods and rejects oversized approval displays", async () => {
		class StatefulBase {
			#notifications = 0;
			notify(): void {
				this.#notifications += 1;
			}
			count(): number {
				return this.#notifications;
			}
		}
		const stateful = new StatefulBase();
		const broker = new EmpatraHostInteractionBroker({ emitRequest: () => undefined });
		const context = createEmpatraHostInteractionUIContext({
			base: stateful as unknown as ExtensionUIContext,
			broker,
			getScope: () => interactionScope("thread-stateful"),
		});
		context.notify("safe");
		expect(stateful.count()).toBe(1);
		await expect(
			context.select("Allow?", ["Approve", "Deny"], {
				internalApprovalContext: {
					inputDigest: "a".repeat(64),
					rawInput: "x".repeat(16 * 1024 + 1),
					toolCallId: "call-large",
					toolName: "bash",
				},
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
		expect(broker.pendingCount).toBe(0);
	});

	test("removes resolvers before completion and supports cancel, abort, timeout, and activity reset", async () => {
		const requests: EmpatraHostInteractionRequest[] = [];
		let timeoutStarts = 0;
		let timeoutResets = 0;
		let timeouts = 0;
		const expired: EmpatraHostInteractionRequest[] = [];
		const broker = new EmpatraHostInteractionBroker({
			createRequestId: sequentialIds(),
			defaultTimeoutMs: 20,
			emitRequest: request => {
				requests.push(request);
			},
			emitTimeout: request => {
				expired.push(request);
			},
		});

		const cancelled = broker.input(interactionScope("thread-1"), "Value");
		const cancelRequest = requests[0];
		if (!cancelRequest) throw new Error("input request was not emitted");
		expect(broker.cancel(cancelRequest.requestId, cancelRequest.digest)).toEqual({ accepted: true });
		await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });

		const controller = new AbortController();
		const aborted = broker.input(interactionScope("thread-1"), "Value", undefined, { signal: controller.signal });
		controller.abort("controller-secret");
		await expect(aborted).rejects.toEqual(
			expect.objectContaining({ code: "aborted", message: "OMP host interaction was aborted" }),
		);

		const timedOut = broker.input(interactionScope("thread-1"), "Value", undefined, {
			onTimeout: () => {
				timeouts += 1;
			},
			onTimeoutReset: () => {
				timeoutResets += 1;
			},
			onTimeoutStart: () => {
				timeoutStarts += 1;
			},
		});
		const timeoutRequest = requests[2];
		if (!timeoutRequest) throw new Error("timeout request was not emitted");
		await Bun.sleep(10);
		expect(broker.noteActivity(timeoutRequest.requestId, timeoutRequest.digest)).toEqual({
			accepted: true,
			expiresAt: timeoutRequest.expiresAt,
		});
		await expect(timedOut).rejects.toMatchObject({ code: "timeout" });
		expect({ timeoutResets, timeoutStarts, timeouts }).toEqual({ timeoutResets: 1, timeoutStarts: 1, timeouts: 1 });
		expect(expired).toEqual([timeoutRequest]);
		expect(broker.pendingCount).toBe(0);
	});

	test("enforces per-thread and host-wide pending limits", async () => {
		const broker = new EmpatraHostInteractionBroker({
			createRequestId: sequentialIds("capacity"),
			emitRequest: () => undefined,
		});
		const outcomes: Promise<unknown>[] = [];
		for (let index = 0; index < EMPATRA_HOST_MAX_PENDING_INTERACTIONS_PER_THREAD; index += 1) {
			outcomes.push(broker.input(interactionScope("thread-limited"), `Input ${index}`).catch(error => error));
		}
		await expect(broker.input(interactionScope("thread-limited"), "Overflow")).rejects.toMatchObject({
			code: "thread_capacity",
		});
		broker.cancelThread("thread-limited");
		await Promise.all(outcomes);

		for (let index = 0; index < EMPATRA_HOST_MAX_PENDING_INTERACTIONS; index += 1) {
			outcomes.push(broker.input(interactionScope(`thread-${index}`), "Input").catch(error => error));
		}
		await expect(broker.input(interactionScope("thread-overflow"), "Overflow")).rejects.toMatchObject({
			code: "host_capacity",
		});
		broker.dispose();
		await Promise.all(outcomes);
		expect(broker.pendingCount).toBe(0);
	});

	test("rejects safely when the request sink fails", async () => {
		const broker = new EmpatraHostInteractionBroker({
			emitRequest: () => {
				throw new Error("transport-secret");
			},
		});
		await expect(broker.confirm(interactionScope("thread-1"), "Confirm", "Continue?")).rejects.toEqual(
			expect.objectContaining({ code: "delivery_failed", message: "OMP host interaction delivery failed" }),
		);
		expect(broker.pendingCount).toBe(0);
	});
});
