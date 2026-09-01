import { describe, expect, test } from "bun:test";

import { LazyEmpatraHostRuntime } from "../src/modes/empatra-host/lazy-runtime";
import type {
	EmpatraHostEvent,
	EmpatraHostInitializeCommand,
	EmpatraHostToolOutboundFrame,
} from "../src/modes/empatra-host/protocol";
import type { EmpatraHostRuntime } from "../src/modes/empatra-host/server";

const initializeCommand: EmpatraHostInitializeCommand = {
	capability: "c".repeat(48),
	gatewayBaseUrl: "http://127.0.0.1:43123/v1",
	id: "initialize",
	models: [],
	protocolVersion: 4,
	sessionDirectory: "/tmp/empatra-host-sessions",
	type: "host_initialize",
	workspaceRoots: ["/tmp"],
};

describe("LazyEmpatraHostRuntime", () => {
	test("defers runtime loading until initialization and preserves server sinks", async () => {
		let factoryCalls = 0;
		let receivedEventSink: ((event: EmpatraHostEvent) => Promise<void>) | undefined;
		let receivedHostToolSink: ((frame: EmpatraHostToolOutboundFrame) => Promise<void>) | undefined;
		const runtime = {
			dispose: async () => undefined,
			initialize: async () => ({ modelCount: 0, workspaceRootCount: 1 }),
			setEventSink: (sink: (event: EmpatraHostEvent) => Promise<void>) => {
				receivedEventSink = sink;
			},
			setHostToolSink: (sink: (frame: EmpatraHostToolOutboundFrame) => Promise<void>) => {
				receivedHostToolSink = sink;
			},
		} as unknown as EmpatraHostRuntime;
		const lazy = new LazyEmpatraHostRuntime(async () => {
			factoryCalls += 1;
			return runtime;
		});
		const eventSink = async (_event: EmpatraHostEvent) => undefined;
		const hostToolSink = async (_frame: EmpatraHostToolOutboundFrame) => undefined;

		lazy.setEventSink(eventSink);
		lazy.setHostToolSink(hostToolSink);
		await lazy.dispose();
		expect(factoryCalls).toBe(0);

		await expect(lazy.initialize(initializeCommand)).resolves.toEqual({ modelCount: 0, workspaceRootCount: 1 });
		expect(factoryCalls).toBe(1);
		expect(receivedEventSink).toBe(eventSink);
		expect(receivedHostToolSink).toBe(hostToolSink);
	});
});
