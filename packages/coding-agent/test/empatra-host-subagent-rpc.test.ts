import { describe, expect, test } from "bun:test";

import {
	createEmpatraHostSubagentRpcTransport,
	EMPATRA_HOST_SUBAGENT_CAPABILITY,
	type EmpatraHostSubagentRequestEvent,
} from "../src/modes/empatra-host";

describe("Empatra host subagent RPC transport", () => {
	test("emits a bounded sidecar request and resolves its correlated response", async () => {
		const events: EmpatraHostSubagentRequestEvent[] = [];
		const transport = createEmpatraHostSubagentRpcTransport({
			capabilities: [EMPATRA_HOST_SUBAGENT_CAPABILITY],
			emitEvent: async event => {
				events.push(event);
				transport.handleResponse({
					data: { childId: "child-1", index: 0, status: "running" },
					id: event.requestId,
					success: true,
					type: "subagent_response",
				});
			},
		});

		await expect(transport.broker.spawn(
			{ generation: 2, parentThreadId: "thread-1", parentTurnId: "turn-1" },
			{ agentName: "researcher", assignment: "Проверь контракты" },
		)).resolves.toMatchObject({ childId: "child-1", status: "running" });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: "subagent_request",
			operation: "spawn",
			threadId: "thread-1",
			turnId: "turn-1",
		});
		expect(JSON.stringify(events[0])).not.toMatch(/cwd|session|credential|secret|env/u);
		transport.dispose();
	});

	test("does not construct without negotiated capability", () => {
		expect(() => createEmpatraHostSubagentRpcTransport({ emitEvent: async () => {} })).toThrow("not negotiated");
	});
});
