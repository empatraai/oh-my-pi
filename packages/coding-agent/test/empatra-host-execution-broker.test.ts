import { describe, expect, test } from "bun:test";

import {
	createEmpatraHostExecutionBroker,
	createEmpatraHostExecutionBrokerTransport,
	createFailClosedEmpatraHostExecutionBroker,
	assertEmpatraHostExecutionBrokerCapability,
	EMPATRA_HOST_CAPABILITIES,
	EMPATRA_HOST_EXECUTION_BROKER_CAPABILITY,
	EMPATRA_HOST_EXECUTION_OPERATIONS,
	EmpatraHostProtocolError,
	type EmpatraHostExecutionBrokerRequestEvent,
	parseEmpatraHostExecutionBrokerRequest,
	parseEmpatraHostExecutionBrokerResponse,
	parseEmpatraHostExecutionRequest,
} from "../src/modes/empatra-host";

const validRead = {
	generation: 2,
	maxBytes: 4096,
	operation: "filesystem.read" as const,
	path: "/workspace/src/main.ts",
	threadId: "thread-1",
	turnId: "turn-1",
};

describe("Empatra host execution broker seam", () => {
	test("keeps the capability reserved until a real main-owned adapter is wired", () => {
		expect(EMPATRA_HOST_EXECUTION_BROKER_CAPABILITY).toBe("execution_broker.v1");
		expect(EMPATRA_HOST_CAPABILITIES).not.toContain(EMPATRA_HOST_EXECUTION_BROKER_CAPABILITY);
		expect(EMPATRA_HOST_EXECUTION_OPERATIONS).toEqual([
			"filesystem.read",
			"filesystem.write",
			"filesystem.list",
			"process.exec",
		]);
	});

	test("validates bounded filesystem and argv-only process requests", () => {
		expect(parseEmpatraHostExecutionRequest(validRead)).toEqual(validRead);
		expect(
			parseEmpatraHostExecutionRequest({
				args: ["--version"],
				command: "/usr/bin/git",
				generation: validRead.generation,
				maxOutputBytes: 4096,
				operation: "process.exec",
				threadId: validRead.threadId,
				timeoutMs: 5_000,
				turnId: validRead.turnId,
			}),
		).toMatchObject({ operation: "process.exec", command: "/usr/bin/git" });
	});

	test("parses the reserved request/response DTOs with strict correlation fields", () => {
		const request = parseEmpatraHostExecutionBrokerRequest({
			generation: 2,
			id: "execution-1",
			request: validRead,
			threadId: "thread-1",
			turnId: "turn-1",
			type: "execution_broker_request",
		});
		expect(request.request).toEqual(validRead);
		expect(
			parseEmpatraHostExecutionBrokerResponse({
				error: { code: "approval_denied", message: "Отказано политикой" },
				generation: 2,
				id: request.id,
				operation: "filesystem.read",
				threadId: request.threadId,
				turnId: request.turnId,
				type: "execution_broker_response",
			}),
		).toMatchObject({ error: { code: "approval_denied" }, operation: "filesystem.read" });
		expect(() => parseEmpatraHostExecutionBrokerRequest({ ...request, env: { TOKEN: "secret" } })).toThrow("invalid");
		expect(() =>
			parseEmpatraHostExecutionBrokerResponse({
				generation: 2,
				id: request.id,
				operation: "filesystem.read",
				result: { operation: "process.exec", output: "bad", outputTruncated: false },
				threadId: request.threadId,
				turnId: request.turnId,
				type: "execution_broker_response",
			}),
		).toThrow(EmpatraHostProtocolError);
	});

	test("rejects shell/env smuggling, oversized payloads, and invalid scope", () => {
		expect(() => parseEmpatraHostExecutionRequest({ ...validRead, shell: true })).toThrow("unknown fields");
		expect(() => parseEmpatraHostExecutionRequest({ ...validRead, maxBytes: 1_000_000 })).toThrow("maxBytes");
		expect(() => parseEmpatraHostExecutionRequest({ ...validRead, generation: 0 })).toThrow("generation");
		expect(() =>
			parseEmpatraHostExecutionRequest({
				args: Array.from({ length: 129 }, () => "x"),
				command: "/usr/bin/git",
				generation: validRead.generation,
				maxOutputBytes: 4096,
				operation: "process.exec",
				threadId: validRead.threadId,
				timeoutMs: 5_000,
				turnId: validRead.turnId,
			}),
		).toThrow("args");
	});

	test("fails closed without a main-owned executor", async () => {
		const broker = createFailClosedEmpatraHostExecutionBroker();
		expect(broker.capability).toBe(EMPATRA_HOST_EXECUTION_BROKER_CAPABILITY);
		await expect(broker.execute(validRead)).rejects.toMatchObject({
			code: "execution_broker_unavailable",
		});
	});

	test("does not construct a transport until the main host negotiates its capability", () => {
		expect(() => assertEmpatraHostExecutionBrokerCapability([])).toThrow("not negotiated");
		expect(() =>
			createEmpatraHostExecutionBrokerTransport({
				emitRequest: async () => {},
			}),
		).toThrow("not negotiated");
	});

	test("validates executor identity and result bounds", async () => {
		const calls: unknown[] = [];
		const broker = createEmpatraHostExecutionBroker(async request => {
			calls.push(request);
			return { operation: request.operation, output: "ok", outputTruncated: false };
		});
		await expect(broker.execute(validRead)).resolves.toEqual({
			operation: "filesystem.read",
			output: "ok",
			outputTruncated: false,
		});
		expect(calls).toHaveLength(1);
		const bad = createEmpatraHostExecutionBroker(async _request => ({
			operation: "process.exec",
			output: "bad",
			outputTruncated: false,
		}));
		await expect(bad.execute(validRead)).rejects.toBeInstanceOf(EmpatraHostProtocolError);
	});
});

test("dispatches a bounded broker request as an ordered host event and resolves its response", async () => {
	let emitted: EmpatraHostExecutionBrokerRequestEvent | undefined;
	const transport = createEmpatraHostExecutionBrokerTransport({
		capabilities: [EMPATRA_HOST_EXECUTION_BROKER_CAPABILITY],
		emitRequest: async event => {
			emitted = event;
		},
		nextSequence: () => 7,
	});
	const pending = transport.broker.execute(validRead);
	await Promise.resolve();
	if (!emitted) throw new Error("broker event was not emitted");
	expect(emitted.event).toBe("execution_broker_request");
	expect(emitted.sequence).toBe(7);
	transport.handleResponse({
		generation: emitted.generation,
		id: emitted.id,
		operation: emitted.request.operation,
		result: { operation: "filesystem.read", output: "main-owned", outputTruncated: false },
		threadId: emitted.threadId,
		turnId: emitted.turnId,
		type: "execution_broker_response",
	});
	await expect(pending).resolves.toMatchObject({ output: "main-owned", operation: "filesystem.read" });
	transport.dispose();
});
