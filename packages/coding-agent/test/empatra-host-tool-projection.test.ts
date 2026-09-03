import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import {
	EMPATRA_HOST_MAX_TOOL_ARGUMENT_BYTES,
	parseEmpatraHostPersistedToolEvent,
	projectEmpatraHostToolEvent,
} from "../src/modes/empatra-host";
import type { AgentSessionEvent } from "../src/session/agent-session-events";

const encoder = new TextEncoder();

describe("Empatra host tool projection", () => {
	test("redacts credentials, headers, provider metadata, and paths outside the workspace", () => {
		const workspace = "/workspace/project";
		const projected = projectEmpatraHostToolEvent(
			{
				args: {
					command:
						"curl https://user:password@example.com -H 'Authorization: Bearer SECRET_BEARER' /etc/passwd C:\\Users\\outside\\secret.txt",
					path: path.join(workspace, "src", "main.ts"),
					providerPayload: { token: "SECRET_TOKEN" },
				},
				toolCallId: "call-1",
				toolName: "bash",
				type: "tool_execution_start",
			} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>,
			{ workspaceRoots: [workspace] },
		);
		if (projected.payload.phase !== "start") throw new Error("Expected start projection");
		expect(projected.payload.argumentsText).toContain("src/main.ts");
		expect(projected.payload.argumentsText).toContain("[REDACTED]");
		expect(projected.payload.argumentsText).toContain("[OUTSIDE_WORKSPACE]");
		for (const secret of ["password@example.com", "SECRET_BEARER", "SECRET_TOKEN", "/etc/passwd", "C:\\\\Users"]) {
			expect(projected.payload.argumentsText).not.toContain(secret);
		}
	});

	test("bounds escaped argument text and marks truncation explicitly", () => {
		const projected = projectEmpatraHostToolEvent(
			{
				args: { text: "\n".repeat(40_000) },
				toolCallId: "call-large",
				toolName: "write",
				type: "tool_execution_start",
			} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>,
			{ workspaceRoots: ["/workspace"] },
		);
		if (projected.payload.phase !== "start") throw new Error("Expected start projection");
		expect(projected.payload.argumentsTruncated).toBe(true);
		expect(encoder.encode(JSON.stringify(projected.payload.argumentsText)).byteLength).toBeLessThanOrEqual(
			EMPATRA_HOST_MAX_TOOL_ARGUMENT_BYTES,
		);
	});

	test("keeps a terminal frame below 64 KiB when both arguments and result are large", () => {
		const start = projectEmpatraHostToolEvent(
			{
				args: { text: "a".repeat(40_000) },
				toolCallId: "call-combined",
				toolName: "bash",
				type: "tool_execution_start",
			} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>,
			{ workspaceRoots: ["/workspace"] },
		);
		if (start.payload.phase !== "start") throw new Error("Expected start projection");
		const end = projectEmpatraHostToolEvent(
			{
				isError: false,
				result: { content: [{ text: "r".repeat(100_000), type: "text" }] },
				toolCallId: "call-combined",
				toolName: "bash",
				type: "tool_execution_end",
			} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
			{ startPayload: start.payload, workspaceRoots: ["/workspace"] },
		);
		if (end.payload.phase !== "end") throw new Error("Expected end projection");
		const bytes = encoder.encode(
			JSON.stringify({
				argumentsText: end.payload.argumentsText,
				argumentsTruncated: end.payload.argumentsTruncated,
				event: "tool_execution_end",
				failed: end.payload.failed,
				generation: 1,
				resultText: end.payload.resultText,
				resultTruncated: end.payload.resultTruncated,
				sequence: 2,
				threadId: "thread-1",
				toolCallId: end.payload.toolCallId,
				toolName: end.payload.toolName,
				turnId: "turn-1",
				type: "host_event",
			}),
		).byteLength;
		expect(end.payload.resultTruncated).toBe(true);
		expect(bytes).toBeLessThanOrEqual(64 * 1024);
	});

	test("uses allowlisted snapshots without projecting raw details or metadata", () => {
		const projected = projectEmpatraHostToolEvent(
			{
				args: {},
				partialResult: {
					content: [{ text: "provider-visible text", type: "text" }],
					details: {
						diff: "+const token = 'sk-abcdefghijklmnopqrstuvwxyz';",
						metadata: { authorization: "SECRET_METADATA" },
						path: "/workspace/project/src/main.ts",
					},
					providerMetadata: { usage: { cost: 42 } },
				},
				toolCallId: "call-change",
				toolName: "edit",
				type: "tool_execution_update",
			} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
			{ previousOutputText: "", workspaceRoots: ["/workspace/project"] },
		);
		if (projected.payload.phase !== "update") throw new Error("Expected update projection");
		expect(projected.payload.update).toMatchObject({
			changes: [{ diff: "+const token=[REDACTED];", path: "src/main.ts" }],
			type: "changes_snapshot",
		});
		const serialized = JSON.stringify(projected);
		for (const secret of ["SECRET_METADATA", "providerMetadata", "usage", "cost", "sk-abcdefghijklmnopqrstuvwxyz"]) {
			expect(serialized).not.toContain(secret);
		}
	});

	test("preserves a bounded rename destination in move snapshots", () => {
		const projected = projectEmpatraHostToolEvent(
			{
				partialResult: {
					content: [],
					details: {
						perFileResults: [{
							diff: "",
							op: "move",
							path: "src/new.ts",
							sourcePath: "src/old.ts",
						}],
					},
				},
				toolCallId: "call-move",
				toolName: "apply_patch",
				type: "tool_execution_update",
			} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
			{ previousOutputText: "", workspaceRoots: ["/workspace/project"] },
		);
		if (projected.payload.phase !== "update" || projected.payload.update.type !== "changes_snapshot") {
			throw new Error("Expected move changes snapshot");
		}
		expect(projected.payload.update.changes).toEqual([{
			diff: "",
			diffTruncated: false,
			kind: "move",
			movePath: "src/new.ts",
			path: "src/old.ts",
		}]);
	});

	test("rejects forged durable records containing raw secrets", () => {
		expect(
			parseEmpatraHostPersistedToolEvent({
				generation: 1,
				payload: {
					argumentsText: '{"token":"SECRET_FORGED"}',
					argumentsTruncated: false,
					phase: "start",
					toolCallId: "call-forged",
					toolName: "bash",
				},
				sequence: 1,
				turnId: "turn-forged",
				version: 1,
			}),
		).toBeUndefined();
	});
});
