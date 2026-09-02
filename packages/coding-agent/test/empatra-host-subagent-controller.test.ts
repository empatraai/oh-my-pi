import { describe, expect, test } from "bun:test";

import {
	EMPATRA_HOST_SUBAGENT_CAPABILITY,
	EmpatraHostSubagentController,
	type EmpatraHostSubagentRunContext,
	type EmpatraHostSubagentRunResult,
	type EmpatraHostSubagentRunner,
} from "../src/modes/empatra-host";
import { EmpatraHostAgentRuntime } from "../src/modes/empatra-host/runtime";

const scope = {
	generation: 1,
	parentThreadId: "thread-parent",
	parentTurnId: "turn-parent",
} as const;

function waitForTick(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

describe("Empatra host subagent controller", () => {
	test("advertises the lifecycle capability only when a runner is injected", async () => {
		const runner: EmpatraHostSubagentRunner = {
			run: async () => ({ output: "", status: "completed" }),
		};
		const withoutRunner = new EmpatraHostAgentRuntime();
		const withRunner = new EmpatraHostAgentRuntime({ subagentRunner: runner });

		expect(withoutRunner.getAdvertisedCapabilities()).not.toContain(EMPATRA_HOST_SUBAGENT_CAPABILITY);
		expect(withRunner.getAdvertisedCapabilities()).toContain(EMPATRA_HOST_SUBAGENT_CAPABILITY);
		await withoutRunner.dispose();
		await withRunner.dispose();
	});

	test("projects runner lifecycle, progress, and bounded result while keeping list scoped", async () => {
		const events: unknown[] = [];
		let received: EmpatraHostSubagentRunContext | undefined;
		const runner: EmpatraHostSubagentRunner = {
			run: async context => {
				received = context;
				context.onProgress("Половина работы");
				return { output: "Готово", status: "completed" } satisfies EmpatraHostSubagentRunResult;
			},
		};
		const controller = new EmpatraHostSubagentController({
			onEvent: event => {
				events.push(event);
			},
			runner,
		});

		const started = await controller.spawn({
			...scope,
			assignment: "Проверь границу",
			id: "spawn-1",
			type: "subagent_spawn",
		});
		await waitForTick();
		expect(controller.capability).toBe(EMPATRA_HOST_SUBAGENT_CAPABILITY);
		expect(received).toMatchObject({
			agentName: "task",
			assignment: "Проверь границу",
			childId: started.childId,
			parentThreadId: scope.parentThreadId,
			parentTurnId: scope.parentTurnId,
		});
		expect(events).toEqual([
			expect.objectContaining({ event: "subagent_lifecycle", status: "running", threadId: scope.parentThreadId }),
			expect.objectContaining({ event: "subagent_progress", progress: "Половина работы" }),
			expect.objectContaining({ event: "subagent_result", output: "Готово", status: "completed" }),
			expect.objectContaining({ event: "subagent_lifecycle", status: "completed" }),
		]);
		expect(await controller.list(scope)).toEqual({ subagents: [] });
		await controller.dispose();
	});

	test("delegates steer and interrupts the exact child, while fencing stale generations", async () => {
		const runContexts: EmpatraHostSubagentRunContext[] = [];
		const steered: string[] = [];
		const interrupted: string[] = [];
		const runner: EmpatraHostSubagentRunner = {
			interrupt: async childId => {
				interrupted.push(childId);
			},
			run: context => {
				runContexts.push(context);
				return new Promise(resolve => {
					context.signal.addEventListener(
						"abort",
						() => resolve({ output: "", status: "aborted" }),
						{ once: true },
					);
				});
			},
			steer: async (childId, message) => {
				steered.push(`${childId}:${message}`);
			},
		};
		const controller = new EmpatraHostSubagentController({ maxPerParent: 1, runner });
		const started = await controller.spawn({
			...scope,
			assignment: "Долгая проверка",
			id: "spawn-2",
			type: "subagent_spawn",
		});
		await waitForTick();
		await controller.steer(scope, started.childId, "Уточни критерий");
		expect(steered).toEqual([`${started.childId}:Уточни критерий`]);
		await expect(
			controller.spawn({ ...scope, assignment: "Второй", id: "spawn-3", type: "subagent_spawn" }),
		).rejects.toMatchObject({ code: "subagent_capacity_exceeded" });
		await controller.interrupt(scope, started.childId);
		await waitForTick();
		expect(interrupted).toEqual([started.childId]);
		await expect(controller.list({ ...scope, generation: 2 })).resolves.toEqual({ subagents: [] });
		await expect(controller.list(scope)).rejects.toMatchObject({ code: "stale_turn" });
		expect(runContexts[0]?.signal.aborted).toBe(true);
		await controller.dispose();
	});
});
