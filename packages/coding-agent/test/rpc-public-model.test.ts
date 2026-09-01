import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { toRpcPublicModel } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

describe("RPC public model serialization", () => {
	test("get_state projection excludes provider credentials without mutating the internal model", () => {
		const authorization = "Bearer runtime-secret";
		const apiKey = "provider-api-key";
		const nestedToken = "nested-transport-token";
		const model = {
			id: "empatra-test",
			identity: { class: "openai", family: "gpt" },
			name: "Empatra Test",
			api: "openai-responses",
			provider: "empatra-gateway",
			baseUrl: `https://runtime-user:runtime-password@example.test/v1?api_key=${apiKey}#${nestedToken}`,
			reasoning: true,
			input: ["text", "image"],
			supportsTools: true,
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.75 },
			contextWindow: 200_000,
			maxTokens: 16_384,
			compat: {
				supportsStore: true,
				extraBody: {
					safeRoutingHint: "preserved",
					nestedToken,
					nested: {
						Authorization: authorization,
						apiKey,
						maxTokens: 4_096,
					},
				},
			},
			headers: {
				Authorization: authorization,
				"X-Api-Key": apiKey,
			},
			apiKey,
			credentials: { token: nestedToken },
		} as unknown as Model;

		const publicModel = toRpcPublicModel(model);
		const response = JSON.stringify({
			type: "response",
			command: "get_state",
			success: true,
			data: { model: publicModel },
		});

		expect(response).not.toContain(authorization);
		expect(response).not.toContain(apiKey);
		expect(response).not.toContain(nestedToken);
		expect(response).not.toContain("headers");
		expect(response).not.toContain("apiKey");
		expect(response).not.toContain("credentials");
		expect(publicModel).toMatchObject({
			id: "empatra-test",
			name: "Empatra Test",
			provider: "empatra-gateway",
			api: "openai-responses",
			baseUrl: "https://example.test/v1",
			reasoning: true,
			input: ["text", "image"],
			supportsTools: true,
			contextWindow: 200_000,
			maxTokens: 16_384,
			compat: {
				supportsStore: true,
				extraBody: {
					safeRoutingHint: "preserved",
					nested: { maxTokens: 4_096 },
				},
			},
		});
		expect(model.headers?.Authorization).toBe(authorization);
		expect((model.compat as Record<string, unknown>).extraBody).toMatchObject({ nestedToken });
	});
});
