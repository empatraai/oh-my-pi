import { describe, expect, test } from "bun:test";

import {
	computeEmpatraHostAgentCatalogRevision,
	createEmpatraHostAgentCatalog,
	EMPATRA_HOST_MAX_AGENT_CATALOG_ENTRIES,
	parseEmpatraHostAgentCatalog,
	validateEmpatraHostAgentCatalogModels,
} from "../src/modes/empatra-host";

const agents = [
	{
		description: "Проверяет изменения в репозитории",
		developerInstructions: "Сначала изучи diff, затем сообщи проверяемый результат.",
		model: ["managed-model", "@slow"],
		name: "reviewer",
		reasoning: "high" as const,
	},
	{
		description: "Быстрый сбор фактов",
		developerInstructions: "Не изменяй файлы и возвращай краткий отчёт.",
		model: "managed-model",
		name: "scout",
		reasoning: "medium" as const,
	},
];

describe("Empatra host custom-agent catalog", () => {
	test("keeps OMP agent metadata in a stable revisioned catalog", () => {
		const catalog = createEmpatraHostAgentCatalog([...agents].reverse());
		const reordered = createEmpatraHostAgentCatalog(agents);

		expect(catalog).toEqual(reordered);
		expect(catalog.revision).toBe(computeEmpatraHostAgentCatalogRevision(catalog));
		expect(parseEmpatraHostAgentCatalog(catalog)).toEqual(catalog);
	});

	test("preserves ordered model fallback selectors and rejects ambiguous metadata", () => {
		const catalog = createEmpatraHostAgentCatalog([agents[0]!]);
		expect(catalog.agents[0]?.model).toEqual(["managed-model", "@slow"]);
		expect(() =>
			createEmpatraHostAgentCatalog([
				{ ...agents[0]!, name: "../escape" },
			]),
		).toThrow("agent name is invalid");
		expect(() =>
			createEmpatraHostAgentCatalog([
				{ ...agents[0]!, developerInstructions: "unsafe\u0000prompt" },
			]),
		).toThrow("developerInstructions is invalid");
		expect(() =>
			createEmpatraHostAgentCatalog([
				{ ...agents[0]!, model: ["managed-model", "managed-model"] },
			]),
		).toThrow("duplicate selectors");
	});

	test("binds every agent model to the injected catalog and never accepts URLs", () => {
		const catalog = createEmpatraHostAgentCatalog(agents);
		validateEmpatraHostAgentCatalogModels(catalog, new Set(["managed-model"]));
		expect(() =>
			validateEmpatraHostAgentCatalogModels(
				createEmpatraHostAgentCatalog([{ ...agents[0]!, model: "https://provider.invalid/key" }]),
				new Set(["managed-model"]),
			),
		).toThrow("outside the injected model catalog");
	});

	test("rejects stale revisions, unknown fields, duplicate names, and oversized catalogs", () => {
		const catalog = createEmpatraHostAgentCatalog([agents[0]!]);
		expect(() =>
			parseEmpatraHostAgentCatalog({ ...catalog, revision: `sha256:${"0".repeat(64)}` }),
		).toThrow("revision does not match");
		expect(() => parseEmpatraHostAgentCatalog({ ...catalog, extra: true })).toThrow("agent catalog is invalid");
		expect(() => createEmpatraHostAgentCatalog([agents[0]!, agents[0]!])).toThrow("names must be unique");
		expect(() =>
			createEmpatraHostAgentCatalog(
				Array.from({ length: EMPATRA_HOST_MAX_AGENT_CATALOG_ENTRIES + 1 }, (_, index) => ({
					...agents[0]!,
					name: `agent-${index}`,
				})),
			),
		).toThrow("entry limit");
	});
});
