import { claimRpcInput } from "../rpc/rpc-input";
import { LazyEmpatraHostRuntime, type EmpatraHostRuntimeFactoryOptions } from "./lazy-runtime";
import { runEmpatraHostServer } from "./server";

/**
 * Run the framed OMP host. A runner may only be injected by an embedding
 * Electron main process; no executable, cwd, environment, or credential is
 * accepted through this CLI boundary.
 */
export async function runEmpatraHostCli(options: EmpatraHostRuntimeFactoryOptions = {}): Promise<void> {
	const writer = Bun.stdout.writer();
	await runEmpatraHostServer({
		input: claimRpcInput(),
		runtime: new LazyEmpatraHostRuntime(undefined, options),
		write: async frame => {
			writer.write(frame);
			await writer.flush();
		},
	});
}
