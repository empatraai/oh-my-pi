import { describe, expect, test } from "bun:test";

import {
	computeEmpatraHostToolCatalogRevision,
	EMPATRA_HOST_MAX_FRAME_BYTES,
	EMPATRA_HOST_MAX_HOST_TOOL_RESULT_BYTES,
	EMPATRA_HOST_MAX_IMAGE_BYTES,
	EMPATRA_HOST_PROTOCOL_VERSION,
	type EmpatraHostEvent,
	type EmpatraHostInitializeCommand,
	EmpatraHostProtocolError,
	parseEmpatraHostCommand,
	serializeEmpatraHostFrame,
} from "../src/modes/empatra-host";

const validInitialize: EmpatraHostInitializeCommand = {
	capability: "c".repeat(48),
	gatewayBaseUrl: "http://127.0.0.1:43123/v1",
	id: "initialize-1",
	models: [
		{
			api: "openai-responses",
			contextWindow: 200_000,
			id: "managed-model",
			input: ["text", "image"],
			maxTokens: 32_000,
			name: "Managed Model",
			reasoning: true,
			supportsTools: true,
		},
	],
	protocolVersion: EMPATRA_HOST_PROTOCOL_VERSION,
	sessionDirectory: "/tmp/empatra-omp-sessions",
	skills: [
		{
			baseDir: "/tmp/empatra-omp-sessions/runtime/skill-snapshots/revision/demo",
			description: "Проверка безопасного skill snapshot",
			filePath: "/tmp/empatra-omp-sessions/runtime/skill-snapshots/revision/demo/SKILL.md",
			name: "demo",
			source: "empatra:project",
		},
	],
	type: "host_initialize",
	workspaceRoots: ["/tmp/workspace"],
};

describe("Empatra host protocol", () => {
	test("accepts a strict injected host bootstrap", () => {
		const command = parseEmpatraHostCommand(JSON.stringify(validInitialize));

		expect(command).toEqual(validInitialize);
	});

	test("rejects remote gateways, duplicate models, and excess fields", () => {
		expect(() => parseEmpatraHostCommand(JSON.stringify({ ...validInitialize, protocolVersion: 1 }))).toThrow(
			"host_initialize is invalid",
		);
		expect(() =>
			parseEmpatraHostCommand(JSON.stringify({ ...validInitialize, gatewayBaseUrl: "https://api.example.com/v1" })),
		).toThrow(EmpatraHostProtocolError);
		expect(() =>
			parseEmpatraHostCommand(
				JSON.stringify({ ...validInitialize, models: [...validInitialize.models, ...validInitialize.models] }),
			),
		).toThrow("model ids must be unique");
		expect(() => parseEmpatraHostCommand(JSON.stringify({ ...validInitialize, ambientConfig: true }))).toThrow(
			"host_initialize is invalid",
		);
	});

	test("accepts only strict digest-bound host tool catalog, result, and cancellation frames", () => {
		const tools = [
			{
				description: "Executes a desktop-owned operation",
				name: "desktop_action",
				parameters: { additionalProperties: false, properties: {}, type: "object" },
			},
		];
		const catalogRevision = computeEmpatraHostToolCatalogRevision(tools);
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({ catalogRevision, id: "catalog-1", tools, type: "host_tools_replace" }),
			),
		).toEqual({ catalogRevision, id: "catalog-1", tools, type: "host_tools_replace" });
		const correlation = {
			catalogRevision,
			generation: 4,
			id: "host-call-1",
			threadId: "thread-1",
			turnId: "turn-1",
		};
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({
					...correlation,
					failed: false,
					result: { content: [{ text: "done", type: "text" }] },
					type: "host_tool_result",
				}),
			),
		).toMatchObject({ ...correlation, failed: false, type: "host_tool_result" });
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({ ...correlation, id: "cancel-1", targetId: "host-call-1", type: "host_tool_cancel" }),
			),
		).toEqual({ ...correlation, id: "cancel-1", targetId: "host-call-1", type: "host_tool_cancel" });
		expect(() =>
			parseEmpatraHostCommand(
				JSON.stringify({
					catalogRevision: catalogRevision.toUpperCase(),
					id: "catalog-2",
					tools,
					type: "host_tools_replace",
				}),
			),
		).toThrow("catalogRevision is invalid");
		expect(() =>
			parseEmpatraHostCommand(
				JSON.stringify({
					...correlation,
					failed: false,
					result: { content: [{ text: "x".repeat(EMPATRA_HOST_MAX_HOST_TOOL_RESULT_BYTES), type: "text" }] },
					type: "host_tool_result",
				}),
			),
		).toThrow("exceeds its limit");
	});

	test("validates command identity, generations, and unknown fields", () => {
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({
					expectedGeneration: 2,
					id: "interrupt-1",
					threadId: "thread-1",
					turnId: "turn-1",
					type: "turn_interrupt",
				}),
			),
		).toEqual({
			expectedGeneration: 2,
			id: "interrupt-1",
			threadId: "thread-1",
			turnId: "turn-1",
			type: "turn_interrupt",
		});
		expect(() =>
			parseEmpatraHostCommand(
				JSON.stringify({ id: "read-1", includeSecrets: true, threadId: "thread-1", type: "thread_read" }),
			),
		).toThrow("unknown fields");
	});

	test("accepts strict thread lifecycle commands and list filters", () => {
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({
					archived: true,
					id: "list-1",
					limit: 50,
					offset: 0,
					searchTerm: "Проект",
					type: "thread_list",
				}),
			),
		).toEqual({ archived: true, id: "list-1", limit: 50, offset: 0, searchTerm: "Проект", type: "thread_list" });
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({ id: "rename-1", threadId: "thread-1", title: "Новый заголовок", type: "thread_rename" }),
			),
		).toEqual({ id: "rename-1", threadId: "thread-1", title: "Новый заголовок", type: "thread_rename" });
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({
					cwd: "/tmp/fork",
					id: "fork-1",
					operationId: "operation-fork-1",
					threadId: "thread-1",
					type: "thread_fork",
				}),
			),
		).toEqual({
			cwd: "/tmp/fork",
			id: "fork-1",
			operationId: "operation-fork-1",
			threadId: "thread-1",
			type: "thread_fork",
		});
		for (const type of ["thread_archive", "thread_compact", "thread_unarchive", "thread_delete"] as const) {
			expect(parseEmpatraHostCommand(JSON.stringify({ id: `${type}-1`, threadId: "thread-1", type }))).toEqual({
				id: `${type}-1`,
				threadId: "thread-1",
				type,
			});
		}
		expect(() =>
			parseEmpatraHostCommand(
				JSON.stringify({ archived: "yes", id: "list-2", limit: 50, offset: 0, type: "thread_list" }),
			),
		).toThrow("archived is invalid");
		expect(() =>
			parseEmpatraHostCommand(
				JSON.stringify({ id: "archive-1", reason: "hidden", threadId: "thread-1", type: "thread_archive" }),
			),
		).toThrow("unknown fields");
		expect(() =>
			parseEmpatraHostCommand(
				JSON.stringify({
					id: "fork-invalid",
					includeSecrets: true,
					operationId: "operation-fork-invalid",
					threadId: "thread-1",
					type: "thread_fork",
				}),
			),
		).toThrow("unknown fields");
	});

	test("accepts bounded turn pagination and strict goal CRUD commands", () => {
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({
					cursor: "cursor-1",
					id: "turns-1",
					limit: 50,
					sortDirection: "desc",
					threadId: "thread-1",
					type: "thread_turns",
				}),
			),
		).toEqual({
			cursor: "cursor-1",
			id: "turns-1",
			limit: 50,
			sortDirection: "desc",
			threadId: "thread-1",
			type: "thread_turns",
		});
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({
					id: "goal-set-1",
					objective: "Довести нативный parity до проверки",
					status: "active",
					threadId: "thread-1",
					tokenBudget: 50_000,
					type: "goal_set",
				}),
			),
		).toMatchObject({ id: "goal-set-1", status: "active", tokenBudget: 50_000, type: "goal_set" });
		for (const type of ["goal_get", "goal_clear"] as const) {
			expect(parseEmpatraHostCommand(JSON.stringify({ id: `${type}-1`, threadId: "thread-1", type }))).toEqual({
				id: `${type}-1`,
				threadId: "thread-1",
				type,
			});
		}
		expect(() =>
			parseEmpatraHostCommand(
				JSON.stringify({ id: "turns-wide", limit: 201, threadId: "thread-1", type: "thread_turns" }),
			),
		).toThrow("limit is invalid");
		expect(() =>
			parseEmpatraHostCommand(JSON.stringify({ id: "goal-empty", threadId: "thread-1", type: "goal_set" })),
		).toThrow("patch is empty");
		expect(() =>
			parseEmpatraHostCommand(
				JSON.stringify({ id: "goal-secret", provider: "hidden", threadId: "thread-1", type: "goal_get" }),
			),
		).toThrow("unknown fields");
	});

	test("accepts strict atomic, steer, rollback, and opaque read commands", () => {
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({
					cwd: "/tmp/workspace",
					id: "atomic-create-1",
					message: "Первая строка\nВторая строка",
					modelId: "managed-model",
					operationId: "operation-atomic-1",
					systemPrompt: "System\n\nDeveloper",
					turnId: "turn-atomic-1",
					type: "thread_create_and_start",
				}),
			),
		).toMatchObject({ operationId: "operation-atomic-1", type: "thread_create_and_start" });
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({
					expectedGeneration: 1,
					id: "steer-1",
					message: "Уточнение",
					threadId: "thread-1",
					turnId: "turn-1",
					type: "turn_steer",
				}),
			),
		).toMatchObject({ expectedGeneration: 1, type: "turn_steer" });
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({ id: "rollback-1", threadId: "thread-1", turns: 2, type: "thread_rollback" }),
			),
		).toEqual({ id: "rollback-1", threadId: "thread-1", turns: 2, type: "thread_rollback" });
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({
					cursor: "opaque-cursor",
					id: "read-1",
					limit: 50,
					threadId: "thread-1",
					type: "thread_read",
				}),
			),
		).toEqual({ cursor: "opaque-cursor", id: "read-1", limit: 50, threadId: "thread-1", type: "thread_read" });
		expect(() =>
			parseEmpatraHostCommand(
				JSON.stringify({ id: "read-offset", limit: 50, offset: 0, threadId: "thread-1", type: "thread_read" }),
			),
		).toThrow("unknown fields");
	});

	test("accepts only bounded path-free image descriptors and image-only prompts", () => {
		const image = {
			byteLength: 68,
			detail: "high" as const,
			displayName: "Схема.png",
			mimeType: "image/png" as const,
			sha256: "a".repeat(64),
		};
		const base = {
			expectedGeneration: 0,
			id: "turn-image",
			images: [image],
			message: "",
			threadId: "thread-1",
			turnId: "turn-1",
			type: "turn_start" as const,
		};
		expect(parseEmpatraHostCommand(JSON.stringify(base))).toEqual(base);
		expect(() => parseEmpatraHostCommand(JSON.stringify({ ...base, images: [] }))).toThrow("images is invalid");
		for (const forbidden of [
			{ path: "/tmp/a" },
			{ data: "base64" },
			{ url: "data:image/png;base64,secret" },
			{ base64: "secret" },
		]) {
			expect(() =>
				parseEmpatraHostCommand(JSON.stringify({ ...base, images: [{ ...image, ...forbidden }] })),
			).toThrow("images[0] is invalid");
		}
		expect(() =>
			parseEmpatraHostCommand(JSON.stringify({ ...base, images: [{ ...image, displayName: "/tmp/a.png" }] })),
		).toThrow("images[0] is invalid");
		expect(() =>
			parseEmpatraHostCommand(JSON.stringify({ ...base, images: [{ ...image, sha256: "A".repeat(64) }] })),
		).toThrow("images[0] is invalid");
		expect(() => parseEmpatraHostCommand(JSON.stringify({ ...base, images: [{ ...image, byteLength: 0 }] }))).toThrow(
			"byteLength is invalid",
		);
		expect(() =>
			parseEmpatraHostCommand(JSON.stringify({ ...base, images: Array.from({ length: 17 }, () => image) })),
		).toThrow("images is invalid");
		expect(() =>
			parseEmpatraHostCommand(
				JSON.stringify({
					...base,
					images: Array.from({ length: 4 }, (_, index) => ({
						...image,
						byteLength: EMPATRA_HOST_MAX_IMAGE_BYTES,
						sha256: index.toString(16).repeat(64),
					})),
				}),
			),
		).toThrow("aggregate byte limit");
		expect(() => parseEmpatraHostCommand(JSON.stringify({ ...base, images: undefined }))).toThrow(
			"message is invalid",
		);
	});

	test("accepts only digest-bound active-turn interaction commands", () => {
		const identity = {
			digest: `sha256:${"a".repeat(64)}`,
			expectedGeneration: 3,
			id: "interaction-1",
			requestId: "request-1",
			threadId: "thread-1",
			turnId: "turn-1",
		};
		expect(
			parseEmpatraHostCommand(
				JSON.stringify({
					...identity,
					response: { inputKind: "editor", kind: "user_input_response", value: "edited" },
					type: "interaction_respond",
				}),
			),
		).toEqual({
			...identity,
			response: { inputKind: "editor", kind: "user_input_response", value: "edited" },
			type: "interaction_respond",
		});
		for (const type of ["interaction_activity", "interaction_cancel"] as const) {
			expect(parseEmpatraHostCommand(JSON.stringify({ ...identity, type }))).toEqual({ ...identity, type });
		}
		expect(() =>
			parseEmpatraHostCommand(
				JSON.stringify({
					...identity,
					digest: "controller-secret",
					response: { decision: "approve", kind: "approval_response" },
					type: "interaction_respond",
				}),
			),
		).toThrow("digest is invalid");
		expect(() =>
			parseEmpatraHostCommand(
				JSON.stringify({
					...identity,
					response: { decision: "approve", kind: "approval_response", rawInput: "secret" },
					type: "interaction_respond",
				}),
			),
		).toThrow("interaction response is invalid");
	});

	test("bounds physical input and output frames", () => {
		expect(() => parseEmpatraHostCommand(`{"type":"${"x".repeat(EMPATRA_HOST_MAX_FRAME_BYTES)}"}`)).toThrow(
			"physical frame limit",
		);
		expect(
			serializeEmpatraHostFrame({
				maxFrameBytes: EMPATRA_HOST_MAX_FRAME_BYTES,
				protocolVersion: EMPATRA_HOST_PROTOCOL_VERSION,
				type: "host_ready",
			}),
		).toEndWith("\n");
	});

	test("serializes the strict secret-free tool event contract", () => {
		const event = {
			argumentsText: '{"path":"src/main.ts"}',
			argumentsTruncated: false,
			event: "tool_execution_end",
			failed: false,
			generation: 3,
			resultText: "готово",
			resultTruncated: false,
			sequence: 7,
			threadId: "thread-1",
			toolCallId: "tool-1",
			toolName: "edit",
			turnId: "turn-1",
			type: "host_event",
		} satisfies EmpatraHostEvent;
		const serialized = serializeEmpatraHostFrame(event);
		expect(JSON.parse(serialized)).toEqual(event);
		expect(serialized).not.toContain('"phase"');
		expect(serialized).not.toContain("details");
		expect(serialized).not.toContain("metadata");
	});
});
