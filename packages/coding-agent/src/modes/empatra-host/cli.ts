import { claimRpcInput } from "../rpc/rpc-input";
import { LazyEmpatraHostRuntime, type EmpatraHostRuntimeFactoryOptions } from "./lazy-runtime";
import { EMPATRA_HOST_MCP_OAUTH_CAPABILITY, EMPATRA_HOST_RESOURCES_CAPABILITY, serializeEmpatraHostFrame } from "./protocol";
import {
	createEmpatraHostMcpOAuthBrokerTransport,
	EMPATRA_HOST_MCP_OAUTH_RPC_OPT_IN_ENV,
	EMPATRA_HOST_MCP_OAUTH_RPC_OPT_IN_VALUE,
} from "./mcp-oauth-broker";
import { runEmpatraHostServer } from "./server";
import {
	createEmpatraHostResourcesBrokerTransport,
	EMPATRA_HOST_RESOURCES_RPC_OPT_IN_ENV,
	EMPATRA_HOST_RESOURCES_RPC_OPT_IN_VALUE,
} from "./resources";
import {
	createEmpatraHostSubagentRpcTransport,
	EMPATRA_HOST_SUBAGENT_CAPABILITY,
	EMPATRA_HOST_SUBAGENT_RPC_OPT_IN_ENV,
	EMPATRA_HOST_SUBAGENT_RPC_OPT_IN_VALUE,
} from "./subagent-broker";

export function isEmpatraHostSubagentRpcOptedIn(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return environment[EMPATRA_HOST_SUBAGENT_RPC_OPT_IN_ENV] === EMPATRA_HOST_SUBAGENT_RPC_OPT_IN_VALUE;
}

export function isEmpatraHostResourcesRpcOptedIn(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return environment[EMPATRA_HOST_RESOURCES_RPC_OPT_IN_ENV] === EMPATRA_HOST_RESOURCES_RPC_OPT_IN_VALUE;
}

export function isEmpatraHostMcpOAuthRpcOptedIn(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return environment[EMPATRA_HOST_MCP_OAUTH_RPC_OPT_IN_ENV] === EMPATRA_HOST_MCP_OAUTH_RPC_OPT_IN_VALUE;
}

/**
 * Run the framed OMP host. A runner may only be injected by an embedding
 * Electron main process; no executable, cwd, environment, or credential is
 * accepted through this CLI boundary.
 */
export async function runEmpatraHostCli(options: EmpatraHostRuntimeFactoryOptions = {}): Promise<void> {
	const writer = Bun.stdout.writer();
	// Keep all sidecar frames behind one queue. The server has its own bounded
	// queue, but RPC events originate outside that queue and must not race a
	// response on stdout.
	let writeTail = Promise.resolve();
	const write = (frame: string): Promise<void> => {
		const next = writeTail.then(async () => {
			writer.write(frame);
			await writer.flush();
		});
		writeTail = next.catch(() => undefined);
		return next;
	};
	const transport = options.subagentRunner
		? undefined
		: options.subagentRpcTransport ?? (
			!isEmpatraHostSubagentRpcOptedIn()
				? undefined
				: createEmpatraHostSubagentRpcTransport({
				capabilities: [EMPATRA_HOST_SUBAGENT_CAPABILITY],
				emitEvent: async event => write(serializeEmpatraHostFrame(event)),
				})
		);
	const resourcesTransport = options.resourcesTransport ?? (
		!isEmpatraHostResourcesRpcOptedIn()
			? undefined
			: createEmpatraHostResourcesBrokerTransport({
				capabilities: [EMPATRA_HOST_RESOURCES_CAPABILITY],
				emitRequest: async event => write(serializeEmpatraHostFrame(event)),
			})
	);
	const mcpOAuthTransport = options.mcpOAuthTransport ?? (
		!isEmpatraHostMcpOAuthRpcOptedIn()
			? undefined
			: createEmpatraHostMcpOAuthBrokerTransport({
				capabilities: [EMPATRA_HOST_MCP_OAUTH_CAPABILITY],
				emitRequest: async event => write(serializeEmpatraHostFrame(event)),
			})
	);
	try {
		await runEmpatraHostServer({
			input: claimRpcInput(),
			runtime: new LazyEmpatraHostRuntime(
				undefined,
				transport || resourcesTransport || mcpOAuthTransport
					? {
						...options,
						...(transport ? { subagentRpcTransport: transport } : {}),
						...(resourcesTransport ? { resourcesTransport } : {}),
						...(mcpOAuthTransport ? { mcpOAuthTransport } : {}),
					}
					: options,
			),
			write,
		});
	} finally {
		transport?.dispose();
		resourcesTransport?.dispose();
		mcpOAuthTransport?.dispose();
		await writeTail;
	}
}
