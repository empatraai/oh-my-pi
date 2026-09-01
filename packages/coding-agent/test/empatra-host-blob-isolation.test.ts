import { describe, expect, test } from "bun:test";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	EmpatraHostAgentRuntime,
	type EmpatraHostInitializeCommand,
	type EmpatraHostSession,
	type EmpatraHostSessionFactoryOptions,
} from "../src/modes/empatra-host";
import type { AgentSessionEvent } from "../src/session/agent-session-events";
import { BlobStore } from "../src/session/blob-store";
import type { SessionManager } from "../src/session/session-manager";

const CHILD_RUN = process.env.EMPATRA_HOST_BLOB_ISOLATION_CHILD === "1";

class PassiveSession implements EmpatraHostSession {
	abort(): Promise<void> {
		return Promise.resolve();
	}
	compact(): Promise<void> {
		return Promise.resolve();
	}
	dispose(): Promise<void> {
		return Promise.resolve();
	}
	getAllToolNames(): string[] {
		return [];
	}
	prompt(): Promise<void> {
		return Promise.resolve();
	}
	refreshRpcHostTools(_rpcTools: AgentTool[]): Promise<void> {
		return Promise.resolve();
	}
	steer(_message: string): Promise<void> {
		return Promise.resolve();
	}
	subscribe(_listener: (event: AgentSessionEvent) => void): () => void {
		return () => undefined;
	}
}

function initializeCommand(workspace: string, sessionDirectory: string): EmpatraHostInitializeCommand {
	return {
		capability: "c".repeat(48),
		gatewayBaseUrl: "http://127.0.0.1:43123/v1",
		id: "initialize-blob-isolation",
		models: [
			{
				api: "openai-responses",
				contextWindow: 200_000,
				id: "managed-model",
				input: ["text", "image"],
				maxTokens: 32_000,
				name: "Managed Model",
				reasoning: true,
				supportsTools: true,
			},
		],
		protocolVersion: 4,
		sessionDirectory,
		type: "host_initialize",
		workspaceRoots: [workspace],
	};
}

function restoredImageData(manager: SessionManager): string | undefined {
	for (const entry of manager.getEntries()) {
		if (entry.type !== "message" || !("content" in entry.message) || !Array.isArray(entry.message.content)) continue;
		for (const block of entry.message.content) {
			if (
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "image" &&
				"data" in block &&
				typeof block.data === "string"
			) {
				return block.data;
			}
		}
	}
	return undefined;
}

interface TreeSnapshotEntry {
	content?: string;
	kind: "directory" | "file" | "symlink";
	path: string;
}

async function snapshotTree(root: string): Promise<TreeSnapshotEntry[]> {
	const entries: TreeSnapshotEntry[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const name of (await readdir(directory)).sort()) {
			const absolutePath = path.join(directory, name);
			const relativePath = path.relative(root, absolutePath);
			const entryStat = await lstat(absolutePath);
			if (entryStat.isSymbolicLink()) {
				entries.push({ content: await readlink(absolutePath), kind: "symlink", path: relativePath });
			} else if (entryStat.isDirectory()) {
				entries.push({ kind: "directory", path: relativePath });
				await visit(absolutePath);
			} else if (entryStat.isFile()) {
				entries.push({
					content: (await readFile(absolutePath)).toString("base64"),
					kind: "file",
					path: relativePath,
				});
			} else {
				throw new Error(`Unexpected global agent entry type: ${absolutePath}`);
			}
		}
	};
	await visit(root);
	return entries;
}

async function runChildIsolationContract(): Promise<void> {
	const root = process.env.EMPATRA_HOST_BLOB_TEST_ROOT;
	const hostileAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	if (!root || !hostileAgentDirectory) throw new Error("Child isolation paths are missing");
	const workspace = path.join(root, "workspace");
	const sessionDirectory = path.join(root, "sessions");
	const globalBlobDirectory = path.join(hostileAgentDirectory, "blobs");
	const canaryPath = path.join(globalBlobDirectory, "global-store-canary");
	await mkdir(workspace, { recursive: true });
	await mkdir(globalBlobDirectory, { recursive: true });
	await writeFile(canaryPath, "must remain the only global blob file");
	await mkdir(path.join(hostileAgentDirectory, "nested-canary"));
	await writeFile(path.join(hostileAgentDirectory, "agent-root-canary"), "agent root must remain unchanged");
	await writeFile(
		path.join(hostileAgentDirectory, "nested-canary", "nested-file"),
		"nested data must remain unchanged",
	);
	const globalAgentDirectoryBefore = await snapshotTree(hostileAgentDirectory);

	const imageBytes = Buffer.alloc(4096, 0x5a);
	const imageData = imageBytes.toString("base64");
	const blobHash = new Bun.SHA256().update(imageBytes).digest("hex");
	const captures: EmpatraHostSessionFactoryOptions[] = [];
	const createRuntime = () =>
		new EmpatraHostAgentRuntime({
			sessionFactory: async options => {
				captures.push(options);
				return new PassiveSession();
			},
		});

	let runtime = createRuntime();
	await runtime.initialize(initializeCommand(workspace, sessionDirectory));
	const created = (await runtime.startThread({
		cwd: workspace,
		id: "create-image-source",
		modelId: "managed-model",
		operationId: "operation-image-source",
		systemPrompt: "Empatra system prompt",
		type: "thread_create",
	})) as { threadId: string };
	const sourceManager = captures[0]?.sessionManager;
	if (!sourceManager) throw new Error("Source SessionManager was not captured");
	sourceManager.appendMessage({
		content: [{ data: imageData, mimeType: "image/png", type: "image" }],
		role: "user",
		timestamp: Date.now(),
	});
	await sourceManager.flush();
	const sourcePath = sourceManager.getSessionFile();
	if (!sourcePath) throw new Error("Source session was not persisted");
	const privateBlobDirectory = path.join(sessionDirectory, "blobs");
	expect(await Bun.file(path.join(privateBlobDirectory, blobHash)).arrayBuffer()).toEqual(
		imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
	);
	expect(await Bun.file(sourcePath).text()).toContain(`blob:sha256:${blobHash}`);
	expect(await snapshotTree(hostileAgentDirectory)).toEqual(globalAgentDirectoryBefore);
	if (process.platform !== "win32") {
		expect((await stat(privateBlobDirectory)).mode & 0o777).toBe(0o700);
		expect((await stat(path.join(privateBlobDirectory, blobHash))).mode & 0o777).toBe(0o600);
		expect((await stat(path.join(privateBlobDirectory, `${blobHash}.png`))).mode & 0o777).toBe(0o600);
	}
	const cloneBytes = Buffer.from("clone-owned-private-blob");
	const cloneHash = new Bun.SHA256().update(cloneBytes).digest("hex");
	const clone = sourceManager.cloneCurrentSession();
	const cloneBlob = await clone.putBlob(cloneBytes);
	expect(await realpath(cloneBlob.path)).toBe(await realpath(path.join(privateBlobDirectory, cloneHash)));
	expect(await Bun.file(cloneBlob.path).bytes()).toEqual(new Uint8Array(cloneBytes));
	expect(await snapshotTree(hostileAgentDirectory)).toEqual(globalAgentDirectoryBefore);
	await clone.close();
	await runtime.dispose();

	captures.length = 0;
	runtime = createRuntime();
	const resumedTurnCompleted = Promise.withResolvers<void>();
	runtime.setEventSink(async event => {
		if (event.event === "turn_completed" && event.turnId === "resume-image-turn") resumedTurnCompleted.resolve();
	});
	await runtime.initialize(initializeCommand(workspace, sessionDirectory));
	await runtime.startTurn({
		expectedGeneration: 0,
		id: "start-resume-image-turn",
		message: "resume without provider I/O",
		threadId: created.threadId,
		turnId: "resume-image-turn",
		type: "turn_start",
	});
	await resumedTurnCompleted.promise;
	expect(restoredImageData(captures[0]!.sessionManager)).toBe(imageData);
	const forked = (await runtime.forkThread({
		id: "fork-image-source",
		operationId: "operation-image-fork",
		threadId: created.threadId,
		type: "thread_fork",
	})) as { threadId: string };
	expect(forked.threadId).not.toBe(created.threadId);
	expect(restoredImageData(captures[1]!.sessionManager)).toBe(imageData);
	const forkPath = captures[1]!.sessionManager.getSessionFile();
	if (!forkPath) throw new Error("Fork session was not persisted");
	expect(await Bun.file(forkPath).text()).toContain(`blob:sha256:${blobHash}`);
	expect(await snapshotTree(hostileAgentDirectory)).toEqual(globalAgentDirectoryBefore);
	await runtime.dispose();
}

describe("Empatra host blob isolation", () => {
	if (CHILD_RUN) {
		test("externalizes, resumes, and forks images without global blob writes", runChildIsolationContract);
		return;
	}

	test("keeps host blobs private when HOME and the global agent directory are hostile", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "empatra-host-blob-parent-"));
		try {
			const hostileHome = path.join(root, "hostile-home");
			const hostileAgentDirectory = path.join(hostileHome, "hostile-agent");
			await mkdir(hostileHome, { recursive: true });
			const child = Bun.spawn([process.execPath, "test", import.meta.path], {
				cwd: import.meta.dir,
				env: {
					...process.env,
					EMPATRA_HOST_BLOB_ISOLATION_CHILD: "1",
					EMPATRA_HOST_BLOB_TEST_ROOT: path.join(root, "host"),
					HOME: hostileHome,
					PI_CODING_AGENT_DIR: hostileAgentDirectory,
				},
				stderr: "pipe",
				stdout: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (exitCode !== 0) throw new Error(`Blob isolation child failed:\n${stdout}\n${stderr}`);
			expect(exitCode).toBe(0);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	}, 30_000);

	test("rejects a pre-existing blob-directory symlink that escapes session storage", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "empatra-host-blob-symlink-"));
		try {
			const workspace = path.join(root, "workspace");
			const sessionDirectory = path.join(root, "sessions");
			const outside = path.join(root, "outside");
			await Promise.all([mkdir(workspace), mkdir(sessionDirectory), mkdir(outside)]);
			await symlink(outside, path.join(sessionDirectory, "blobs"));
			const runtime = new EmpatraHostAgentRuntime({ sessionFactory: async () => new PassiveSession() });
			await expect(runtime.initialize(initializeCommand(workspace, sessionDirectory))).rejects.toMatchObject({
				code: "runtime_error",
			});
			expect(await readdir(outside)).toEqual([]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("refuses digest and display symlinks without touching their external targets", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "empatra-host-blob-entry-symlink-"));
		try {
			const blobDirectory = path.join(root, "blobs");
			const outsideDigest = path.join(root, "outside-digest");
			const outsideDisplay = path.join(root, "outside-display");
			await mkdir(blobDirectory);
			await writeFile(outsideDigest, "digest target must remain unchanged");
			await writeFile(outsideDisplay, "display target must remain unchanged");

			const store = new BlobStore(blobDirectory);
			const digestBytes = Buffer.from("hostile-digest-link-input");
			const digestHash = new Bun.SHA256().update(digestBytes).digest("hex");
			await symlink(outsideDigest, path.join(blobDirectory, digestHash));

			await expect(store.put(digestBytes)).rejects.toThrow("blob entry");
			await expect(store.get(digestHash)).rejects.toThrow("blob entry");
			expect(() => store.putSync(digestBytes)).toThrow("blob entry");
			expect(() => store.getSync(digestHash)).toThrow("blob entry");
			expect(await readFile(outsideDigest, "utf8")).toBe("digest target must remain unchanged");

			const displayBytes = Buffer.from("hostile-display-link-input");
			const canonical = await store.put(displayBytes);
			const displayPath = `${canonical.path}.png`;
			await symlink(outsideDisplay, displayPath);
			await expect(store.put(displayBytes, { extension: "png" })).rejects.toThrow("blob entry");
			expect(() => store.putSync(displayBytes, { extension: "png" })).toThrow("blob entry");
			expect(await readFile(outsideDisplay, "utf8")).toBe("display target must remain unchanged");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("publishes identical blobs idempotently under concurrent writers", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "empatra-host-blob-concurrent-"));
		try {
			const store = new BlobStore(path.join(root, "blobs"));
			const data = Buffer.alloc(64 * 1024, 0x4d);
			const results = await Promise.all(Array.from({ length: 24 }, () => store.put(data, { extension: "webp" })));
			const [first] = results;
			if (!first) throw new Error("Concurrent blob publication returned no result");
			expect(new Set(results.map(result => result.path))).toEqual(new Set([first.path]));
			expect(new Set(results.map(result => result.displayPath))).toEqual(new Set([first.displayPath]));
			expect(await readFile(first.path)).toEqual(data);
			expect(await readFile(first.displayPath)).toEqual(data);
			expect((await readdir(store.dir)).filter(name => name.startsWith(".blob-tmp-"))).toEqual([]);
			const syncResult = store.putSync(data, { extension: "webp" });
			expect(syncResult.path).toBe(first.path);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
