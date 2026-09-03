import { describe, expect, test } from "bun:test";

import {
	computeEmpatraHostModelRoutingRevision,
	createEmpatraHostModelRoutingSnapshot,
	EMPATRA_HOST_MODEL_ROUTING_CAPABILITY,
	parseEmpatraHostModelRoutingSnapshot,
	parseEmpatraHostModelRoutingWrite,
	parseEmpatraHostModelRoutingWriteCommand,
	validateEmpatraHostModelRoutingModels,
} from "../src/modes/empatra-host";

const baseWrite = {
		modelRoles: { default: "managed-model", slow: "@default:high" },
	taskAgentModelOverrides: {
		worker: ["managed-model", "@slow"],
	},
	version: 1 as const,
};

describe("Empatra host model-routing contract", () => {
	test("uses a stable versioned revision independent of object key order", () => {
		const reordered = {
			modelRoles: { slow: "@default:high", default: "managed-model" },
			taskAgentModelOverrides: { worker: ["managed-model", "@slow"] },
			version: 1 as const,
		};
		const first = createEmpatraHostModelRoutingSnapshot(baseWrite);
		const second = createEmpatraHostModelRoutingSnapshot(reordered);

		expect(first).toEqual(second);
		expect(first.revision).toBe(computeEmpatraHostModelRoutingRevision(baseWrite));
		expect(first.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	test("parses exact maps and rejects unknown fields, invalid keys, and duplicate selectors", () => {
		expect(parseEmpatraHostModelRoutingWrite(baseWrite)).toEqual(baseWrite);
		expect(() => parseEmpatraHostModelRoutingWrite({ ...baseWrite, credentials: "secret" })).toThrow(
		"model routing settings are invalid",
	);
	expect(() =>
		parseEmpatraHostModelRoutingWrite({
			...baseWrite,
			modelRoles: { "../escape": "managed-model" },
		}),
	).toThrow("modelRoles key is invalid");
	expect(() =>
		parseEmpatraHostModelRoutingWrite({
			...baseWrite,
			taskAgentModelOverrides: { worker: ["managed-model", "managed-model"] },
		}),
	).toThrow("must not contain duplicate selectors");
	expect(() =>
		parseEmpatraHostModelRoutingWrite({
			...baseWrite,
			modelRoles: { constructor: "managed-model" },
		}),
	).toThrow("modelRoles key is invalid");
	});

	test("binds snapshot revisions and write ids to the content and expected revision", () => {
		const snapshot = createEmpatraHostModelRoutingSnapshot(baseWrite);
		expect(parseEmpatraHostModelRoutingSnapshot(snapshot)).toEqual(snapshot);
		expect(() => parseEmpatraHostModelRoutingSnapshot({ ...snapshot, revision: "sha256:" + "0".repeat(64) })).toThrow(
			"does not match its content",
		);
		const command = parseEmpatraHostModelRoutingWriteCommand(
			{
				...baseWrite,
				expectedRevision: snapshot.revision,
				id: "write-1",
				type: "settings_model_routing_write",
			},
			"write-1",
		);
		expect(command.expectedRevision).toBe(snapshot.revision);
		expect(() =>
			parseEmpatraHostModelRoutingWriteCommand(
				{
					...baseWrite,
					expectedRevision: snapshot.revision,
					id: "write-1",
					type: "settings_model_routing_write",
				},
				"other-id",
			),
		).toThrow("settings_model_routing_write is invalid");
	});

	test("allows only injected model ids or bounded role aliases", () => {
		validateEmpatraHostModelRoutingModels(baseWrite, new Set(["managed-model"]));
		expect(EMPATRA_HOST_MODEL_ROUTING_CAPABILITY).toBe("settings.model-routing.v1");
		expect(() =>
			validateEmpatraHostModelRoutingModels(
				{ ...baseWrite, modelRoles: { default: "openai/sk-secret" } },
				new Set(["managed-model"]),
			),
		).toThrow("outside the injected model catalog");
		expect(() =>
			validateEmpatraHostModelRoutingModels(
				{ ...baseWrite, taskAgentModelOverrides: { worker: ["https://evil.example/key"] } },
				new Set(["managed-model"]),
			),
		).toThrow("outside the injected model catalog");
	});
});
