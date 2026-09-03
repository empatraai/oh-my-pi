import { describe, expect, test } from "bun:test";
import { createEmpatraHostExecutionTools } from "../src/modes/empatra-host/execution-tools";
import type { EmpatraHostExecutionBroker, EmpatraHostExecutionRequest } from "../src/modes/empatra-host/execution-broker";

const scope = { generation: 1, threadId: "thread-1", turnId: "turn-1" } as const;

describe("Empatra host execution tools", () => {
	test("delegates read/write/bash through the scoped broker", async () => {
		const requests: EmpatraHostExecutionRequest[] = [];
		const broker: EmpatraHostExecutionBroker = {
			capability: "execution_broker.v1",
			execute: async request => {
				requests.push(request);
				return { operation: request.operation, output: "ok", outputTruncated: false };
			},
		};
		const tools = createEmpatraHostExecutionTools(broker, () => scope);
		await tools[0]!.execute("read-1", { path: "README.md" }, undefined, {} as never);
		await tools[1]!.execute("write-1", { path: "out.txt", content: "hello" }, undefined, {} as never);
		await tools[2]!.execute("bash-1", { command: "printf hello" }, undefined, {} as never);
		expect(requests.map(request => request.operation)).toEqual([
			"filesystem.read",
			"filesystem.write",
			"process.exec",
		]);
		expect(requests[0]).toMatchObject(scope);
		expect(requests[2]).toMatchObject({ args: ["hello"], command: "printf" });
	});

	test("rejects shell operators and missing active scope", async () => {
		const broker: EmpatraHostExecutionBroker = {
			capability: "execution_broker.v1",
			execute: async request => ({ operation: request.operation, output: "ok", outputTruncated: false }),
		};
		const tools = createEmpatraHostExecutionTools(broker, () => scope);
		expect(tools[2]!.execute("bash-1", { command: "echo ok && rm -rf ." }, undefined, {} as never)).rejects.toThrow(
			/one direct command/,
		);
		const inactive = createEmpatraHostExecutionTools(broker, () => undefined);
		expect(inactive[0]!.execute("read-1", { path: "README.md" }, undefined, {} as never)).rejects.toThrow(
			/active turn/,
		);
	});
});
