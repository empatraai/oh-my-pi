import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as path from "node:path";

const temporaryRoots: string[] = [];
const compiledHostBinary = Bun.env.EMPATRA_HOST_BINARY;

function hostCommand(...args: string[]): string[] {
	return compiledHostBinary
		? [compiledHostBinary, ...args]
		: [process.execPath, "packages/coding-agent/src/empatra-host-cli.ts", ...args];
}

async function temporaryHost() {
	const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "empatra-omp-cli-"));
	temporaryRoots.push(root);
	const workspace = path.join(root, "workspace");
	const sessions = path.join(root, "sessions");
	await mkdir(workspace);
	return { sessions, workspace };
}

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("standalone Empatra OMP host entry", () => {
	test("bootstraps only from stdin and exits through the correlated shutdown command", async () => {
		const host = await temporaryHost();
		const child = Bun.spawn({
			cmd: hostCommand(),
			cwd: path.resolve(import.meta.dir, "../../.."),
			stderr: "pipe",
			stdin: "pipe",
			stdout: "pipe",
		});
		const commands = [
			{
				capability: "c".repeat(48),
				gatewayBaseUrl: "http://127.0.0.1:43123/v1",
				id: "initialize-1",
				models: [
					{
						api: "openai-responses",
						contextWindow: 200_000,
						id: "managed-model",
						input: ["text"],
						maxTokens: 32_000,
						name: "Managed Model",
						reasoning: true,
						supportsTools: true,
					},
				],
				protocolVersion: 4,
				sessionDirectory: host.sessions,
				type: "host_initialize",
				workspaceRoots: [host.workspace],
			},
			{ id: "list-1", limit: 50, offset: 0, type: "thread_list" },
			{ id: "shutdown-1", type: "host_shutdown" },
		];
		child.stdin.write(`${commands.map(command => JSON.stringify(command)).join("\n")}\n`);
		await child.stdin.end();
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		const frames = stdout
			.trim()
			.split("\n")
			.map(frame => JSON.parse(frame));
		expect(frames[0]).toMatchObject({ protocolVersion: 4, type: "host_ready" });
		expect(frames.find(frame => frame.id === "initialize-1")).toMatchObject({ success: true });
		expect(frames.find(frame => frame.id === "list-1")).toMatchObject({
			data: { nextOffset: null, threads: [] },
			success: true,
		});
		expect(frames.find(frame => frame.id === "shutdown-1")).toMatchObject({ success: true });
	});

	test("rejects argv configuration before reading host input", async () => {
		const child = Bun.spawn({
			cmd: hostCommand("--model", "ambient"),
			cwd: path.resolve(import.meta.dir, "../../.."),
			stderr: "pipe",
			stdout: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode).toBe(2);
		expect(stdout).toBe("");
		expect(stderr).toContain("does not accept command-line arguments");
	});
});
