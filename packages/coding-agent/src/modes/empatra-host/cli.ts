import { claimRpcInput } from "../rpc/rpc-input";
import { LazyEmpatraHostRuntime } from "./lazy-runtime";
import { runEmpatraHostServer } from "./server";

export async function runEmpatraHostCli(): Promise<void> {
	const writer = Bun.stdout.writer();
	await runEmpatraHostServer({
		input: claimRpcInput(),
		runtime: new LazyEmpatraHostRuntime(),
		write: async frame => {
			writer.write(frame);
			await writer.flush();
		},
	});
}
