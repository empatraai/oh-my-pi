import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { BlobStore } from "../../src/session/blob-store";

describe("BlobStore hardening", () => {
	test("keeps missing and read-only stores unchanged during reads", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-readonly-"));
		const blobDirectory = path.join(root, "blobs");
		try {
			const store = new BlobStore(blobDirectory);
			const missingHash = "a".repeat(64);
			expect(await store.get(missingHash)).toBeNull();
			expect(await store.has(missingHash)).toBe(false);
			expect(store.getSync(missingHash)).toBeNull();
			expect(await readdir(root)).toEqual([]);

			const data = Buffer.from("existing-read-only-blob");
			const hash = new Bun.SHA256().update(data).digest("hex");
			await mkdir(blobDirectory);
			await writeFile(path.join(blobDirectory, hash), data);
			if (process.platform !== "win32") {
				await chmod(path.join(blobDirectory, hash), 0o444);
				await chmod(blobDirectory, 0o555);
			}
			const directoryModeBefore = (await stat(blobDirectory)).mode & 0o777;
			const fileModeBefore = (await stat(path.join(blobDirectory, hash))).mode & 0o777;

			expect(await store.get(hash)).toEqual(data);
			expect(store.getSync(hash)).toEqual(data);
			expect(await store.has(hash)).toBe(true);
			expect((await stat(blobDirectory)).mode & 0o777).toBe(directoryModeBefore);
			expect((await stat(path.join(blobDirectory, hash))).mode & 0o777).toBe(fileModeBefore);
		} finally {
			if (process.platform !== "win32") await chmod(blobDirectory, 0o700).catch(() => undefined);
			await rm(root, { force: true, recursive: true });
		}
	});

	test("publishes a maximum-sized image without temporary residue", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-large-"));
		try {
			const store = new BlobStore(path.join(root, "blobs"));
			const data = Buffer.alloc(20 * 1024 * 1024, 0x6b);
			const result = await store.put(data, { extension: "png" });
			const canonical = await stat(result.path);
			const display = await stat(result.displayPath);
			expect(canonical.size).toBe(data.byteLength);
			expect(display.size).toBe(data.byteLength);
			if (process.platform !== "win32") expect(display.ino).toBe(canonical.ino);
			expect((await readdir(store.dir)).filter(name => name.startsWith(".blob-tmp-"))).toEqual([]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("fails closed when Windows cannot provide stable file identity", async () => {
		if (process.platform !== "win32") return;
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? ".", "omp-blob-windows-identity-"));
		try {
			const blobDirectory = path.join(root, "blobs");
			const data = Buffer.from("windows-file-identity-probe");
			const hash = new Bun.SHA256().update(data).digest("hex");
			await mkdir(blobDirectory);
			await writeFile(path.join(blobDirectory, hash), data);
			const directoryStats = await lstat(blobDirectory);
			const fileStats = await lstat(path.join(blobDirectory, hash));
			const store = new BlobStore(blobDirectory);
			if (directoryStats.ino === 0 || fileStats.ino === 0) {
				await expect(store.get(hash)).rejects.toThrow("Cannot verify blob entry identity");
			} else {
				expect(await store.get(hash)).toEqual(data);
			}
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
