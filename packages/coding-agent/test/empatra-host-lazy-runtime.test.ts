import { describe, expect, test } from "bun:test";

import { LazyEmpatraHostRuntime } from "../src/modes/empatra-host/lazy-runtime";
import type {
	EmpatraHostEvent,
	EmpatraHostInitializeCommand,
	EmpatraHostToolOutboundFrame,
} from "../src/modes/empatra-host/protocol";
import type { EmpatraHostRuntime } from "../src/modes/empatra-host/server";
import {
	EMPATRA_HOST_SUBAGENT_CAPABILITY,
	type EmpatraHostSubagentRunner,
} from "../src/modes/empatra-host/subagent-broker";
import {
	type EmpatraHostResourcesBrokerTransport,
} from "../src/modes/empatra-host/resources";
import { EMPATRA_HOST_RESOURCES_CAPABILITY } from "../src/modes/empatra-host/protocol";

const initializeCommand: EmpatraHostInitializeCommand = {
	capability: "c".repeat(48),
	gatewayBaseUrl: "http://127.0.0.1:43123/v1",
	id: "initialize",
	models: [],
	protocolVersion: 6,
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

	test("passes an injected runner through the lazy boundary without serializing it", async () => {
		const runner: EmpatraHostSubagentRunner = {
			run: async () => ({ output: "", status: "completed" }),
		};
		let receivedRunner: EmpatraHostSubagentRunner | undefined;
		const runtime = {
			dispose: async () => undefined,
			initialize: async () => ({ modelCount: 0, workspaceRootCount: 1 }),
			setEventSink: () => undefined,
			setHostToolSink: () => undefined,
		} as unknown as EmpatraHostRuntime;
		const lazy = new LazyEmpatraHostRuntime(
			async options => {
				receivedRunner = options.subagentRunner;
				return runtime;
			},
			{ subagentRunner: runner },
		);

		await lazy.initialize(initializeCommand);
		expect(receivedRunner).toBe(runner);
	});

	test("advertises an injected subagent capability before lazy initialization", () => {
		const runner: EmpatraHostSubagentRunner = {
			run: async () => ({ output: "", status: "completed" }),
		};
		const injected = new LazyEmpatraHostRuntime(async () => {
			throw new Error("runtime must stay lazy");
		}, { subagentRunner: runner });
		const defaultRuntime = new LazyEmpatraHostRuntime(async () => {
			throw new Error("runtime must stay lazy");
		});

		expect(injected.getAdvertisedCapabilities()).toContain(EMPATRA_HOST_SUBAGENT_CAPABILITY);
		expect(defaultRuntime.getAdvertisedCapabilities()).not.toContain(EMPATRA_HOST_SUBAGENT_CAPABILITY);
	});

	test("forwards an explicitly injected resources transport without serializing it", async () => {
		const resourcesTransport = {
			broker: { capability: EMPATRA_HOST_RESOURCES_CAPABILITY },
			handleResponse: () => undefined,
			dispose: () => undefined,
		} as unknown as EmpatraHostResourcesBrokerTransport;
		let receivedTransport: EmpatraHostResourcesBrokerTransport | undefined;
		const runtime = {
			dispose: async () => undefined,
			initialize: async () => ({ modelCount: 0, workspaceRootCount: 1 }),
			setEventSink: () => undefined,
			setHostToolSink: () => undefined,
			handleResourcesResponse: () => undefined,
		} as unknown as EmpatraHostRuntime;
		const lazy = new LazyEmpatraHostRuntime(
			async options => {
				receivedTransport = options.resourcesTransport;
				return runtime;
			},
			{ resourcesTransport },
		);

		expect(lazy.getAdvertisedCapabilities()).toContain(EMPATRA_HOST_RESOURCES_CAPABILITY);
		await lazy.initialize(initializeCommand);
		expect(receivedTransport).toBe(resourcesTransport);
	});
});
