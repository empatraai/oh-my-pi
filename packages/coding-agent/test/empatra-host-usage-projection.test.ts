import { describe, expect, test } from "bun:test";

import {
	normalizeEmpatraHostTokenUsage,
	projectEmpatraHostContextUsage,
} from "../src/modes/empatra-host/usage-projection";
import type { SessionEntry } from "../src/session/session-entries";

function turnMarker(id: string, parentId: string | null, turnId: string): SessionEntry {
	return {
		customType: "empatra.host.turn.v1",
		data: { phase: "started", startedAt: 1, turnId, version: 1 },
		id,
		parentId,
		timestamp: "2026-09-02T00:00:00.000Z",
		type: "custom",
	};
}

function assistantEntry(
	id: string,
	parentId: string,
	usage: Record<string, unknown>,
	completedAt: number,
	stopReason: "aborted" | "error" | "stop" = "stop",
): SessionEntry {
	return {
		id,
		message: {
			api: "openai-responses",
			completedAt,
			content: [{ text: "ok", type: "text" }],
			model: "SECRET_MODEL",
			provider: "SECRET_PROVIDER",
			providerPayload: { authorization: "SECRET_PAYLOAD" },
			responseId: "SECRET_RESPONSE_ID",
			role: "assistant",
			stopReason,
			timestamp: completedAt - 10,
			usage,
		},
		parentId,
		timestamp: new Date(completedAt).toISOString(),
		type: "message",
	} as unknown as SessionEntry;
}

describe("Empatra host usage projection", () => {
	test("normalizes only bounded conversation token fields", () => {
		expect(
			normalizeEmpatraHostTokenUsage({
				cacheRead: 3,
				cacheWrite: 2,
				cost: { total: 999 },
				input: 10,
				output: 7,
				providerResponseId: "SECRET",
				reasoningTokens: 4,
				totalTokens: 22,
			}),
		).toEqual({
			cachedInputTokens: 3,
			inputTokens: 15,
			outputTokens: 7,
			reasoningOutputTokens: 4,
			totalTokens: 22,
		});
		expect(() =>
			normalizeEmpatraHostTokenUsage({
				cacheRead: 0,
				cacheWrite: 0,
				input: 1,
				output: 1,
				reasoningTokens: 2,
				totalTokens: 2,
			}),
		).toThrow("totals are inconsistent");
		expect(() =>
			normalizeEmpatraHostTokenUsage({
				cacheRead: 0,
				cacheWrite: 0,
				input: 1,
				output: 1,
				totalTokens: 3,
			}),
		).toThrow("totals are inconsistent");
		expect(() =>
			normalizeEmpatraHostTokenUsage({
				cacheRead: 1,
				cacheWrite: 1,
				input: Number.MAX_SAFE_INTEGER,
				output: 0,
				totalTokens: Number.MAX_SAFE_INTEGER,
			}),
		).toThrow("overflowed");
	});

	test("excludes valid provider orchestration overhead from conversation context", () => {
		expect(
			normalizeEmpatraHostTokenUsage({
				cacheRead: 181_248,
				cacheWrite: 0,
				input: 5_517,
				orchestration: { cacheRead: 100, input: 5_000, output: 529 },
				output: 29,
				reasoningTokens: 12,
				totalTokens: 192_423,
			}),
		).toEqual({
			cachedInputTokens: 181_248,
			inputTokens: 186_765,
			outputTokens: 29,
			reasoningOutputTokens: 12,
			totalTokens: 186_794,
		});
		expect(() =>
			normalizeEmpatraHostTokenUsage({
				cacheRead: 0,
				cacheWrite: 0,
				input: 10,
				orchestration: { input: 5 },
				output: 2,
				totalTokens: 12,
			}),
		).toThrow("totals are inconsistent");
	});

	test("uses authoritative contextTokens without leaking provider billing metadata", () => {
		const normalized = normalizeEmpatraHostTokenUsage({
			cacheRead: 10,
			cacheWrite: 0,
			contextTokens: 80,
			cost: { total: 999 },
			input: 20,
			orchestration: { input: 7 },
			output: 5,
			providerResponseId: "SECRET",
			totalTokens: 42,
		});
		expect(normalized).toEqual({
			cachedInputTokens: 10,
			inputTokens: 75,
			outputTokens: 5,
			reasoningOutputTokens: 0,
			totalTokens: 80,
		});
		expect(JSON.stringify(normalized)).not.toContain("SECRET");
		expect(() =>
			normalizeEmpatraHostTokenUsage({
				cacheRead: 0,
				cacheWrite: 0,
				contextTokens: Number.MAX_SAFE_INTEGER + 1,
				input: 1,
				output: 0,
				totalTokens: 1,
			}),
		).toThrow("contextTokens is invalid");
	});

	test("recomputes last and total usage from the selected durable branch", () => {
		const firstMarker = turnMarker("turn-marker-1", null, "turn-1");
		const first = assistantEntry(
			"assistant-1",
			firstMarker.id,
			{
				cacheRead: 2,
				cacheWrite: 3,
				cost: { total: 77 },
				input: 10,
				output: 5,
				reasoningTokens: 1,
				totalTokens: 20,
			},
			100,
		);
		const secondMarker = turnMarker("turn-marker-2", first.id, "turn-2");
		const second = assistantEntry(
			"assistant-2",
			secondMarker.id,
			{ cacheRead: 1, cacheWrite: 0, input: 4, output: 2, totalTokens: 7 },
			200,
		);

		const rolledBack = projectEmpatraHostContextUsage([firstMarker, first], 200_000);
		expect(rolledBack).toEqual({
			modelContextWindow: 200_000,
			observedAtMs: 100,
			tokenUsage: {
				last: {
					cachedInputTokens: 2,
					inputTokens: 15,
					outputTokens: 5,
					reasoningOutputTokens: 1,
					totalTokens: 20,
				},
				total: {
					cachedInputTokens: 2,
					inputTokens: 15,
					outputTokens: 5,
					reasoningOutputTokens: 1,
					totalTokens: 20,
				},
			},
			turnId: "turn-1",
		});
		const current = projectEmpatraHostContextUsage([firstMarker, first, secondMarker, second], 200_000);
		expect(current).toMatchObject({
			observedAtMs: 200,
			tokenUsage: {
				last: {
					cachedInputTokens: 1,
					inputTokens: 5,
					outputTokens: 2,
					reasoningOutputTokens: 0,
					totalTokens: 7,
				},
				total: {
					cachedInputTokens: 3,
					inputTokens: 20,
					outputTokens: 7,
					reasoningOutputTokens: 1,
					totalTokens: 27,
				},
			},
			turnId: "turn-2",
		});
		const serialized = JSON.stringify(current);
		for (const secret of ["SECRET_MODEL", "SECRET_PROVIDER", "SECRET_PAYLOAD", "SECRET_RESPONSE_ID", '"cost"']) {
			expect(serialized).not.toContain(secret);
		}
	});

	test("skips aborted and errored assistant usage like transcript compaction", () => {
		const marker = turnMarker("turn-marker-1", null, "turn-1");
		const good = assistantEntry(
			"assistant-good",
			marker.id,
			{ cacheRead: 0, cacheWrite: 0, input: 8, output: 2, totalTokens: 10 },
			100,
		);
		const aborted = assistantEntry(
			"assistant-aborted",
			good.id,
			{ cacheRead: -1, cacheWrite: 0, input: 0, output: 0, totalTokens: 0 },
			200,
			"aborted",
		);
		const errored = assistantEntry(
			"assistant-error",
			aborted.id,
			{ cacheRead: 0, cacheWrite: 0, input: "invalid", output: 0, totalTokens: 0 },
			300,
			"error",
		);

		expect(projectEmpatraHostContextUsage([marker, good, aborted, errored], 200_000)).toMatchObject({
			observedAtMs: 100,
			tokenUsage: {
				last: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
				total: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
			},
			turnId: "turn-1",
		});
	});

	test("allows per-message last usage to decrease while branch total grows monotonically", () => {
		const marker = turnMarker("turn-marker-1", null, "turn-1");
		const first = assistantEntry(
			"assistant-1",
			marker.id,
			{ cacheRead: 2, cacheWrite: 0, input: 90, output: 8, totalTokens: 100 },
			100,
		);
		const second = assistantEntry(
			"assistant-2",
			first.id,
			{ cacheRead: 0, cacheWrite: 0, input: 8, output: 2, totalTokens: 10 },
			200,
		);
		const afterFirst = projectEmpatraHostContextUsage([marker, first], 200_000);
		const afterSecond = projectEmpatraHostContextUsage([marker, first, second], 200_000);

		expect(afterFirst.tokenUsage.last.totalTokens).toBe(100);
		expect(afterFirst.tokenUsage.total.totalTokens).toBe(100);
		expect(afterSecond.tokenUsage.last.totalTokens).toBe(10);
		expect(afterSecond.tokenUsage.total.totalTokens).toBe(110);
	});

	test("returns a stable zero snapshot before the first assistant message", () => {
		expect(projectEmpatraHostContextUsage([], 64_000)).toEqual({
			modelContextWindow: 64_000,
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
	});
});
