import { describe, expect, test } from "bun:test";

import {
	EMPATRA_HOST_USER_MEDIA_ENTRY,
	parseEmpatraHostUserMediaMarker,
	projectThreadMessages,
} from "../src/modes/empatra-host";
import type { SessionEntry } from "../src/session/session-entries";

function messageEntry(
	id: string,
	parentId: string | null,
	role: "assistant" | "toolResult" | "user",
	text: string,
	synthetic = false,
): SessionEntry {
	return {
		id,
		message: {
			content: [{ text, type: "text" }],
			role,
			...(role === "user" && synthetic ? { synthetic: true } : {}),
		},
		parentId,
		timestamp: "2026-09-01T00:00:00.000Z",
		type: "message",
	} as unknown as SessionEntry;
}

function startedMarker(id: string, parentId: string | null, turnId: string, startedAt: number): SessionEntry {
	return {
		customType: "empatra.host.turn.v1",
		data: { phase: "started", startedAt, turnId, version: 1 },
		id,
		parentId,
		timestamp: new Date(startedAt).toISOString(),
		type: "custom",
	};
}

function completedMarker(
	id: string,
	parentId: string | null,
	turnId: string,
	completedAt: number,
	outcome: "completed" | "failed" | "interrupted" = "completed",
): SessionEntry {
	return {
		customType: "empatra.host.turn.v1",
		data: { completedAt, outcome, phase: "completed", turnId, version: 1 },
		id,
		parentId,
		timestamp: new Date(completedAt).toISOString(),
		type: "custom",
	};
}

function mediaMarker(
	id: string,
	parentId: string | null,
	turnId: string,
	message: string,
	overrides: Record<string, unknown> = {},
): SessionEntry {
	return {
		customType: EMPATRA_HOST_USER_MEDIA_ENTRY,
		data: {
			images: [
				{
					byteLength: 68,
					detail: "high",
					displayName: "Схема.png",
					heightPixels: 1,
					mimeType: "image/png",
					sha256: "a".repeat(64),
					widthPixels: 1,
				},
			],
			messageSha256: new Bun.CryptoHasher("sha256").update(message).digest("hex"),
			turnId,
			version: 1,
			...overrides,
		},
		id,
		parentId,
		timestamp: "2026-09-01T00:00:00.000Z",
		type: "custom",
	};
}

describe("Empatra host thread projection", () => {
	test("projects mixed and image-only user media from paired metadata without exposing image bytes", () => {
		const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		const mixed = {
			...messageEntry("user-mixed", "media-mixed", "user", "Опиши"),
			message: {
				content: [
					{ text: "Опиши", type: "text" },
					{ data: base64, mimeType: "image/png", type: "image" },
				],
				role: "user",
			},
		} as SessionEntry;
		const imageOnly = {
			...messageEntry("user-image", "media-image", "user", ""),
			message: { content: [{ data: base64, mimeType: "image/png", type: "image" }], role: "user" },
		} as SessionEntry;
		const projected = projectThreadMessages([
			startedMarker("start", null, "turn-1", 100),
			mediaMarker("media-mixed", "start", "turn-1", "Опиши"),
			mixed,
			mediaMarker("media-image", "user-mixed", "turn-1", ""),
			imageOnly,
		]);
		expect(projected[0]?.blocks).toEqual([
			{ blockType: "text", text: "Опиши" },
			{
				blockType: "image",
				byteLength: 68,
				detail: "high",
				displayName: "Схема.png",
				heightPixels: 1,
				mimeType: "image/png",
				sha256: "a".repeat(64),
				widthPixels: 1,
			},
		]);
		expect(projected[1]?.blocks).toEqual([expect.objectContaining({ blockType: "image", displayName: "Схема.png" })]);
		expect(JSON.stringify(projected)).not.toContain(base64);
	});

	test("keeps text readable for unmatched, corrupt, or missing hydrated media and falls back safely for legacy images", () => {
		const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		const corrupt = mediaMarker("corrupt", "start", "turn-1", "Текст", { secretPath: "/private/a.png" });
		expect(parseEmpatraHostUserMediaMarker(corrupt)).toBeUndefined();
		const excessivePixels = mediaMarker("pixels", "start", "turn-1", "Текст") as Extract<
			SessionEntry,
			{ type: "custom" }
		>;
		const excessiveData = excessivePixels.data as { images: Array<Record<string, unknown>> };
		excessiveData.images[0] = { ...excessiveData.images[0], heightPixels: 10_000, widthPixels: 10_000 };
		expect(parseEmpatraHostUserMediaMarker(excessivePixels)).toBeUndefined();
		const projected = projectThreadMessages([
			startedMarker("start", null, "turn-1", 100),
			corrupt,
			mediaMarker("unmatched", "corrupt", "turn-1", "Другой текст"),
			{
				...messageEntry("missing", "unmatched", "user", "Текст"),
				message: {
					content: [
						{ text: "Текст", type: "text" },
						{ data: `blob:sha256:${"b".repeat(64)}`, mimeType: "image/png", type: "image" },
					],
					role: "user",
				},
			} as SessionEntry,
			{
				...messageEntry("legacy", "missing", "user", "Legacy"),
				message: {
					content: [
						{ text: "Legacy", type: "text" },
						{ data: base64, mimeType: "image/png", type: "image" },
					],
					role: "user",
				},
			} as SessionEntry,
		]);
		expect(projected[0]?.blocks).toEqual([{ blockType: "text", text: "Текст" }]);
		expect(projected[1]?.blocks).toEqual([
			{ blockType: "text", text: "Legacy" },
			expect.objectContaining({ blockType: "image", heightPixels: 1, widthPixels: 1 }),
		]);
		expect(JSON.stringify(projected)).not.toContain("/private/a.png");
	});
	test("keeps durable message identity while excluding provider and tool internals", () => {
		const entries = [
			{
				id: "message-1",
				message: {
					api: "openai-responses",
					content: [
						{ text: "Ответ", type: "text" },
						{ thinking: "Проверяю", type: "thinking" },
						{ arguments: { apiKey: "SECRET_TOOL_ARGUMENT" }, id: "tool-1", name: "read", type: "toolCall" },
					],
					model: "SECRET_UPSTREAM_MODEL",
					provider: "SECRET_PROVIDER",
					providerPayload: { authorization: "SECRET_HEADER" },
					responseId: "SECRET_RESPONSE_ID",
					role: "assistant",
					stopReason: "stop",
					usage: { cost: { total: 42 } },
				},
				parentId: null,
				timestamp: "2026-09-01T00:00:00.000Z",
				type: "message",
			},
			{
				id: "tool-result-1",
				message: { content: [{ text: "SECRET_TOOL_RESULT", type: "text" }], role: "toolResult" },
				parentId: "message-1",
				timestamp: "2026-09-01T00:00:01.000Z",
				type: "message",
			},
		] as unknown as SessionEntry[];

		const projected = projectThreadMessages(entries);
		expect(projected).toEqual([
			{
				blocks: [
					{ blockType: "text", text: "Ответ" },
					{ blockType: "reasoning", text: "Проверяю" },
				],
				id: "message-1",
				parentId: null,
				role: "assistant",
				timestamp: "2026-09-01T00:00:00.000Z",
			},
		]);
		const serialized = JSON.stringify(projected);
		for (const secret of [
			"SECRET_TOOL_ARGUMENT",
			"SECRET_UPSTREAM_MODEL",
			"SECRET_PROVIDER",
			"SECRET_HEADER",
			"SECRET_RESPONSE_ID",
			"SECRET_TOOL_RESULT",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	test("reconstructs stable tool blocks only from bounded safe custom entries", () => {
		const entries = [
			{
				customType: "empatra.host.tool.v1",
				data: {
					generation: 1,
					payload: {
						argumentsText: '{"path":"src/main.ts","token":"[REDACTED]"}',
						argumentsTruncated: false,
						phase: "start",
						toolCallId: "call-1",
						toolName: "read",
					},
					sequence: 2,
					turnId: "turn-1",
					version: 1,
				},
				id: "safe-start",
				parentId: null,
				timestamp: "2026-09-01T00:00:00.000Z",
				type: "custom",
			},
			{
				customType: "empatra.host.tool.v1",
				data: {
					generation: 1,
					payload: {
						phase: "update",
						toolCallId: "call-1",
						toolName: "read",
						update: {
							changes: [{
								diff: "@@ -1 +1 @@\\n-old\\n+new",
								diffTruncated: false,
								kind: "modify",
								path: "src/main.ts",
							}],
							changesTruncated: false,
							type: "changes_snapshot",
						},
					},
					sequence: 3,
					turnId: "turn-1",
					version: 1,
				},
				id: "safe-update",
				parentId: "safe-start",
				timestamp: "2026-09-01T00:00:00.500Z",
				type: "custom",
			},
			{
				customType: "empatra.host.tool.v1",
				data: {
					generation: 1,
					payload: {
						argumentsText: '{"path":"src/main.ts","token":"[REDACTED]"}',
						argumentsTruncated: false,
						failed: false,
						phase: "end",
						resultText: "готово",
						resultTruncated: false,
						toolCallId: "call-1",
						toolName: "read",
					},
				sequence: 4,
					turnId: "turn-1",
					version: 1,
				},
				id: "safe-end",
				parentId: "safe-start",
				timestamp: "2026-09-01T00:00:01.000Z",
				type: "custom",
			},
		] as SessionEntry[];

		expect(projectThreadMessages(entries)).toEqual([
			{
				blocks: [
					{
						blockType: "tool_call",
						failed: false,
						hasResult: true,
						id: "call-1",
						toolArgumentsText: '{"path":"src/main.ts","token":"[REDACTED]"}',
						toolArgumentsTruncated: false,
						toolName: "read",
						toolResultText: "готово",
						toolResultTruncated: false,
						changes: [{
							diff: "@@ -1 +1 @@\\n-old\\n+new",
							diffTruncated: false,
							kind: "modify",
							path: "src/main.ts",
						}],
						changesTruncated: false,
					},
				],
				id: "tool:turn-1:call-1",
				parentId: "safe-start",
				role: "assistant",
				timestamp: "2026-09-01T00:00:01.000Z",
				turnId: "turn-1",
			},
		]);
	});

	test("preserves marker turn identity across multiple completed turns", () => {
		const entries = [
			startedMarker("start-1", null, "turn-1", 100),
			messageEntry("user-1", "start-1", "user", "Первый вопрос"),
			messageEntry("assistant-1", "user-1", "assistant", "Первый ответ"),
			completedMarker("end-1", "assistant-1", "turn-1", 200),
			startedMarker("start-2", "end-1", "turn-2", 300),
			messageEntry("user-2", "start-2", "user", "Второй вопрос"),
			messageEntry("assistant-2", "user-2", "assistant", "Второй ответ"),
			completedMarker("end-2", "assistant-2", "turn-2", 400),
		];

		expect(projectThreadMessages(entries).map(message => [message.id, message.turnId])).toEqual([
			["user-1", "turn-1"],
			["assistant-1", "turn-1"],
			["user-2", "turn-2"],
			["assistant-2", "turn-2"],
		]);
	});

	test("keeps running and implicitly interrupted marker boundaries distinct", () => {
		const entries = [
			startedMarker("start-1", null, "turn-1", 100),
			messageEntry("user-1", "start-1", "user", "Незавершённый вопрос"),
			startedMarker("start-2", "user-1", "turn-2", 200),
			messageEntry("user-2", "start-2", "user", "Текущий вопрос"),
			messageEntry("assistant-2", "user-2", "assistant", "Текущий ответ"),
		];

		expect(projectThreadMessages(entries).map(message => [message.id, message.turnId])).toEqual([
			["user-1", "turn-1"],
			["user-2", "turn-2"],
			["assistant-2", "turn-2"],
		]);
	});

	test("keeps tool messages private while binding safe tool blocks to the marker turn", () => {
		const entries = [
			startedMarker("start", null, "turn-1", 100),
			messageEntry("user", "start", "user", "Прочитай файл"),
			{
				customType: "empatra.host.tool.v1",
				data: {
					generation: 1,
					payload: {
						argumentsText: '{"path":"README.md"}',
						argumentsTruncated: false,
						phase: "start",
						toolCallId: "call-1",
						toolName: "read",
					},
					sequence: 1,
					turnId: "turn-1",
					version: 1,
				},
				id: "tool-start",
				parentId: "user",
				timestamp: "2026-09-01T00:00:00.000Z",
				type: "custom",
			},
			messageEntry("provider-tool-result", "tool-start", "toolResult", "PRIVATE_PROVIDER_RESULT"),
			{
				customType: "empatra.host.tool.v1",
				data: {
					generation: 1,
					payload: {
						argumentsText: '{"path":"README.md"}',
						argumentsTruncated: false,
						failed: false,
						phase: "end",
						resultText: "готово",
						resultTruncated: false,
						toolCallId: "call-1",
						toolName: "read",
					},
					sequence: 2,
					turnId: "turn-1",
					version: 1,
				},
				id: "tool-end",
				parentId: "provider-tool-result",
				timestamp: "2026-09-01T00:00:01.000Z",
				type: "custom",
			},
		] as SessionEntry[];

		const projected = projectThreadMessages(entries);
		expect(projected.map(message => [message.id, message.turnId])).toEqual([
			["user", "turn-1"],
			["tool:turn-1:call-1", "turn-1"],
		]);
		expect(JSON.stringify(projected)).not.toContain("PRIVATE_PROVIDER_RESULT");
	});

	test("preserves legacy user-entry turn ids before marker history", () => {
		const entries = [
			messageEntry("legacy-user-1", null, "user", "Первый"),
			messageEntry("legacy-synthetic", "legacy-user-1", "user", "Системное продолжение", true),
			messageEntry("legacy-assistant-1", "legacy-synthetic", "assistant", "Ответ"),
			messageEntry("legacy-user-2", "legacy-assistant-1", "user", "Второй"),
			messageEntry("legacy-assistant-2", "legacy-user-2", "assistant", "Ответ"),
			startedMarker("start", "legacy-assistant-2", "turn-3", 300),
			messageEntry("current-user", "start", "user", "Третий"),
		];

		expect(projectThreadMessages(entries).map(message => [message.id, message.turnId])).toEqual([
			["legacy-user-1", "legacy-user-1"],
			["legacy-synthetic", "legacy-user-1"],
			["legacy-assistant-1", "legacy-user-1"],
			["legacy-user-2", "legacy-user-2"],
			["legacy-assistant-2", "legacy-user-2"],
			["current-user", "turn-3"],
		]);
	});

	test("fails closed on corrupt or mismatched marker scopes", () => {
		const start = startedMarker("start", null, "turn-1", 100);
		const corrupt = startedMarker("corrupt", null, "turn-1", 100) as Extract<SessionEntry, { type: "custom" }>;
		const mismatchedTool = {
			customType: "empatra.host.tool.v1",
			data: {
				generation: 1,
				payload: {
					argumentsText: "{}",
					argumentsTruncated: false,
					phase: "start",
					toolCallId: "call-1",
					toolName: "read",
				},
				sequence: 1,
				turnId: "turn-other",
				version: 1,
			},
			id: "tool-start",
			parentId: "start",
			timestamp: "2026-09-01T00:00:00.000Z",
			type: "custom",
		} as SessionEntry;
		expect(() => projectThreadMessages([start, completedMarker("end", "start", "turn-other", 200)])).toThrow(
			"matching start marker",
		);
		expect(() =>
			projectThreadMessages([
				start,
				completedMarker("end", "start", "turn-1", 200),
				messageEntry("orphan", "end", "assistant", "Поздний ответ"),
			]),
		).toThrow("outside a turn marker");
		expect(() => projectThreadMessages([start, startedMarker("duplicate", "start", "turn-1", 200)])).toThrow(
			"start is duplicated",
		);
		expect(() => projectThreadMessages([start, mismatchedTool])).toThrow("outside its turn marker");
		expect(() =>
			projectThreadMessages([
				{
					...corrupt,
					data: { extra: true, phase: "started", startedAt: 100, turnId: "turn-1", version: 1 },
				},
			]),
		).toThrow("turn marker is invalid");
	});
});
