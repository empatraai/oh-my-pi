import { describe, expect, test } from "bun:test";

import {
	EmpatraHostRegistryError,
	type EmpatraHostThreadHandle,
	EmpatraHostThreadRegistry,
} from "../src/modes/empatra-host";

interface TestThreadHandle extends EmpatraHostThreadHandle {
	disposed: boolean;
}

function handle(threadId: string): TestThreadHandle {
	return {
		disposed: false,
		async dispose() {
			this.disposed = true;
		},
		threadId,
	};
}

describe("Empatra host thread registry", () => {
	test("coalesces concurrent opens without duplicating AgentSession", async () => {
		const registry = new EmpatraHostThreadRegistry<TestThreadHandle>();
		const pending = Promise.withResolvers<TestThreadHandle>();
		let loads = 0;
		const load = () => {
			loads += 1;
			return pending.promise;
		};

		const first = registry.open("thread-1", load);
		const second = registry.open("thread-1", load);
		pending.resolve(handle("thread-1"));
		const [left, right] = await Promise.all([first, second]);

		expect(loads).toBe(1);
		expect(left.handle).toBe(right.handle);
		await registry.dispose();
	});

	test("fences turn start, interrupt, and completion by generation", async () => {
		const registry = new EmpatraHostThreadRegistry<TestThreadHandle>();
		await registry.open("thread-1", async () => handle("thread-1"));

		const activeGeneration = registry.beginTurn("thread-1", "turn-1", 0);
		expect(activeGeneration).toBe(1);
		expect(registry.requireActiveTurn("thread-1", "turn-1", 1).threadId).toBe("thread-1");
		expect(() => registry.requireActiveTurn("thread-1", "turn-1", 0)).toThrow("active generation");
		expect(registry.finishTurn("thread-1", "turn-1", 1)).toBe(2);
		expect(() => registry.finishTurn("thread-1", "turn-1", 1)).toThrow(EmpatraHostRegistryError);
		await registry.dispose();
	});

	test("evicts only idle least-recently-used sessions", async () => {
		const registry = new EmpatraHostThreadRegistry<TestThreadHandle>(2);
		const first = handle("thread-1");
		const second = handle("thread-2");
		const third = handle("thread-3");
		await registry.open(first.threadId, async () => first);
		await registry.open(second.threadId, async () => second);
		registry.get(first.threadId);
		await registry.open(third.threadId, async () => third);

		expect(first.disposed).toBe(false);
		expect(second.disposed).toBe(true);
		expect(third.disposed).toBe(false);
		await registry.dispose();
	});

	test("fails closed and disposes an incoming session when all slots are active", async () => {
		const registry = new EmpatraHostThreadRegistry<TestThreadHandle>(1);
		const active = handle("thread-active");
		const rejected = handle("thread-rejected");
		await registry.open(active.threadId, async () => active);
		registry.beginTurn(active.threadId, "turn-1", 0);

		await expect(registry.open(rejected.threadId, async () => rejected)).rejects.toThrow("active turns");
		expect(rejected.disposed).toBe(true);
		await registry.dispose();
	});
});
