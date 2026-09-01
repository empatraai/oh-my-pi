import { describe, expect, spyOn, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { BlobStore } from "../../src/session/blob-store";
import { SessionManager } from "../../src/session/session-manager";
import { MemorySessionStorage } from "../../src/session/session-storage";

function entry(id: string, parentId: string | null, data?: unknown): Record<string, unknown> {
	return { type: "custom", customType: "gc-test", data, id, parentId, timestamp: new Date(0).toISOString() };
}

async function writeSession(filePath: string, entries: readonly Record<string, unknown>[]): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const header = {
		type: "session",
		version: 3,
		id: Bun.randomUUIDv7(),
		timestamp: new Date(0).toISOString(),
		cwd: path.dirname(filePath),
	};
	await writeFile(filePath, `${[header, ...entries].map(value => JSON.stringify(value)).join("\n")}\n`);
}

describe("BlobStore reference-aware garbage collection", () => {
	test("retains a shared digest until the last durable session is deleted", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-shared-"));
		try {
			const sessions = path.join(root, "sessions");
			const store = new BlobStore(path.join(root, "blobs"));
			const blob = await store.put(Buffer.from("shared-fork-digest"));
			await writeSession(path.join(sessions, "source.jsonl"), [entry("source", null, { ref: blob.ref })]);
			await writeSession(path.join(sessions, "fork.jsonl"), [entry("fork", null, { ref: blob.ref })]);
			blob.commitPublication();

			expect((await store.collectGarbage({ sessionRoots: [sessions] })).deletedBlobs).toBe(0);
			await unlink(path.join(sessions, "source.jsonl"));
			expect((await store.collectGarbage({ sessionRoots: [sessions] })).deletedBlobs).toBe(0);
			expect(await store.has(blob.hash)).toBe(true);

			await unlink(path.join(sessions, "fork.jsonl"));
			expect((await store.collectGarbage({ sessionRoots: [sessions] })).deletedBlobs).toBe(1);
			expect(await store.has(blob.hash)).toBe(false);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("rollback collects only the abandoned branch and retains its live ancestor", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-rollback-"));
		try {
			const sessions = path.join(root, "sessions");
			const store = new BlobStore(path.join(root, "blobs"));
			const retained = await store.put(Buffer.from("retained-ancestor"));
			const abandoned = await store.put(Buffer.from("abandoned-turn"));
			retained.commitPublication();
			abandoned.commitPublication();
			await writeSession(path.join(sessions, "thread.jsonl"), [
				entry("ancestor", null, { ref: retained.ref }),
				entry("turn", "ancestor", { ref: abandoned.ref }),
				entry("rollback", "ancestor", { kind: "empatra.host.thread-rollback.v1" }),
			]);

			const result = await store.collectGarbage({ sessionRoots: [sessions] });
			expect(result.deletedBlobs).toBe(1);
			expect(await store.has(retained.hash)).toBe(true);
			expect(await store.has(abandoned.hash)).toBe(false);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("treats an active OMP media marker as a reference and cancellation as release", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-media-"));
		try {
			const sessions = path.join(root, "sessions");
			const store = new BlobStore(path.join(root, "blobs"));
			const image = await store.put(Buffer.from("durable-media-marker"));
			const marker = {
				type: "custom",
				customType: "empatra.host.user-media.v1",
				data: {
					images: [
						{
							byteLength: Buffer.byteLength("durable-media-marker"),
							displayName: "image.png",
							mimeType: "image/png",
							sha256: image.hash,
						},
					],
					messageSha256: "a".repeat(64),
					turnId: "turn-1",
					version: 1,
				},
				id: "marker",
				parentId: null,
				timestamp: new Date(0).toISOString(),
			};
			image.commitPublication();
			const sessionFile = path.join(sessions, "media.jsonl");
			await writeSession(sessionFile, [marker]);
			expect((await store.collectGarbage({ sessionRoots: [sessions] })).deletedBlobs).toBe(0);
			expect(await store.has(image.hash)).toBe(true);

			const invalidCancellationData = [
				{ markerEntryId: "marker", turnId: "turn-2", version: 1 },
				{ markerEntryId: "marker", turnId: "turn-1", version: 2 },
				{ extra: true, markerEntryId: "marker", turnId: "turn-1", version: 1 },
				{ markerEntryId: "", turnId: "turn-1", version: 1 },
				{ markerEntryId: "marker", turnId: "x".repeat(257), version: 1 },
			];
			const invalidCancellations: Record<string, unknown>[] = [];
			let parentId = "marker";
			for (const [index, data] of invalidCancellationData.entries()) {
				const cancellation = {
					type: "custom",
					customType: "empatra.host.user-media-cancel.v1",
					data,
					id: `invalid-cancel-${index}`,
					parentId,
					timestamp: new Date(index + 1).toISOString(),
				};
				invalidCancellations.push(cancellation);
				parentId = cancellation.id;
				await writeSession(sessionFile, [marker, ...invalidCancellations]);
				expect((await store.collectGarbage({ sessionRoots: [sessions] })).deletedBlobs).toBe(0);
				expect(await store.has(image.hash)).toBe(true);
			}

			const cancellation = {
				type: "custom",
				customType: "empatra.host.user-media-cancel.v1",
				data: { markerEntryId: "marker", turnId: "turn-1", version: 1 },
				id: "cancel",
				parentId,
				timestamp: new Date(10).toISOString(),
			};
			await writeSession(sessionFile, [marker, ...invalidCancellations, cancellation]);
			expect((await store.collectGarbage({ sessionRoots: [sessions] })).deletedBlobs).toBe(1);
			expect(await store.has(image.hash)).toBe(false);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("a concurrent publication is not deleted before its durable reference lands", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-race-"));
		try {
			const sessions = path.join(root, "sessions");
			await mkdir(sessions);
			const store = new BlobStore(path.join(root, "blobs"));
			const collecting = store.collectGarbage({ sessionRoots: [sessions] });
			const published = await store.put(Buffer.from("put-during-mark"));
			await collecting;
			expect(await store.has(published.hash)).toBe(true);

			await writeSession(path.join(sessions, "new-reference.jsonl"), [entry("new", null, { ref: published.ref })]);
			expect((await store.collectGarbage({ sessionRoots: [sessions] })).deletedBlobs).toBe(0);
			expect(await store.has(published.hash)).toBe(true);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("an abandoned publication lease can be released idempotently for bounded recovery", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-release-"));
		try {
			const sessions = path.join(root, "sessions");
			await mkdir(sessions);
			const store = new BlobStore(path.join(root, "blobs"));
			const abandoned = await store.put(Buffer.from("abandoned-publication"));
			abandoned.releasePublication();
			abandoned.releasePublication();
			const result = await store.collectGarbage({ sessionRoots: [sessions] });
			expect(result.deletedBlobs).toBe(1);
			expect(await store.has(abandoned.hash)).toBe(false);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("releases capacity after duplicate digest leases become durable or are abandoned", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-lease-capacity-"));
		try {
			const sessions = path.join(root, "sessions");
			const store = new BlobStore(path.join(root, "blobs"));
			const publications = Array.from({ length: 4096 }, () => store.putSync(Buffer.from("same-digest")));
			await writeSession(path.join(sessions, "thread.jsonl"), [
				entry("durable", null, { ref: publications[0]!.ref }),
			]);
			publications[0]!.commitPublication();
			expect((await store.collectGarbage({ sessionRoots: [sessions] })).deletedBlobs).toBe(0);
			for (const publication of publications) publication.releasePublication();
			const recovered = store.putSync(Buffer.from("capacity-recovered"));
			recovered.releasePublication();
			expect(await store.has(recovered.hash)).toBe(true);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	}, 10_000);

	test("restarts mark when a durable reference lands after its file was scanned", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-mark-race-"));
		try {
			const sessions = path.join(root, "sessions");
			const store = new BlobStore(path.join(root, "blobs"));
			const published = await store.put(Buffer.from("durable-during-mark"));
			const targetFile = path.join(sessions, "00-target.jsonl");
			await writeSession(targetFile, [entry("base", null)]);
			await writeSession(path.join(sessions, "zz-slow.jsonl"), [entry("slow", null, { pad: "x".repeat(16 << 20) })]);

			const collecting = store.collectGarbage({ sessionRoots: [sessions] });
			await Bun.sleep(5);
			const durable = entry("durable", "base", { ref: published.ref });
			await writeSession(targetFile, [entry("base", null), durable]);
			published.commitPublication();

			const result = await collecting;
			expect(result.deletedBlobs).toBe(0);
			expect(await store.has(published.hash)).toBe(true);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	}, 10_000);

	test("skips corrupt and symlink entries while deleting verified orphans", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-unsafe-"));
		try {
			const sessions = path.join(root, "sessions");
			const blobs = path.join(root, "blobs");
			await mkdir(sessions);
			const store = new BlobStore(blobs);
			const orphan = await store.put(Buffer.from("verified-orphan"));
			const corruptHash = new Bun.SHA256().update("expected-content").digest("hex");
			await writeFile(path.join(blobs, corruptHash), "different-content");
			const outside = path.join(root, "outside");
			await writeFile(outside, "outside-content");
			const symlinkHash = new Bun.SHA256().update("outside-content").digest("hex");
			await symlink(outside, path.join(blobs, symlinkHash));

			const result = await store.collectGarbage({
				protectRecentPublications: false,
				sessionRoots: [sessions],
			});
			expect(result.deletedBlobs).toBe(1);
			expect(await store.has(orphan.hash)).toBe(false);
			expect((await lstat(path.join(blobs, corruptHash))).isFile()).toBe(true);
			expect((await lstat(path.join(blobs, symlinkHash))).isSymbolicLink()).toBe(true);
			expect(await readFile(outside, "utf8")).toBe("outside-content");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("bounds each maintenance pass and converges across repeated passes", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-bounded-"));
		try {
			const sessions = path.join(root, "sessions");
			await mkdir(sessions);
			const store = new BlobStore(path.join(root, "blobs"));
			const blobs = await Promise.all(["one", "two", "three"].map(value => store.put(Buffer.from(value))));

			const first = await store.collectGarbage({
				maxDeletes: 1,
				protectRecentPublications: false,
				sessionRoots: [sessions],
			});
			expect(first.deletedBlobs).toBe(1);
			expect(first.hasMore).toBe(true);
			const second = await store.collectGarbage({
				maxDeletes: 2,
				protectRecentPublications: false,
				sessionRoots: [sessions],
			});
			expect(second.deletedBlobs).toBe(2);
			expect(second.hasMore).toBe(false);
			for (const blob of blobs) expect(await store.has(blob.hash)).toBe(false);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("fails closed before sweep when the mark budget is exhausted", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-mark-budget-"));
		try {
			const sessions = path.join(root, "sessions");
			const store = new BlobStore(path.join(root, "blobs"));
			const orphan = await store.put(Buffer.from("budget-protected-orphan"));
			await writeSession(path.join(sessions, "thread.jsonl"), [entry("entry", null, { value: "x".repeat(1024) })]);

			await expect(
				store.collectGarbage({
					maxSessionBytes: 1,
					protectRecentPublications: false,
					sessionRoots: [sessions],
				}),
			).rejects.toThrow("session byte budget");
			expect(await store.has(orphan.hash)).toBe(true);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("bounds CAS enumeration and sidecars before hashing", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-cas-budget-"));
		try {
			const sessions = path.join(root, "sessions");
			await mkdir(sessions);
			const store = new BlobStore(path.join(root, "blobs"));
			await store.put(Buffer.from("sidecar-budget"), { extension: "png" });
			await store.put(Buffer.from("second-entry"));

			const enumeration = await store.collectGarbage({
				maxBlobEntries: 1,
				protectRecentPublications: false,
				sessionRoots: [sessions],
			});
			expect(enumeration.scannedBlobs).toBe(1);
			expect(enumeration.hasMore).toBe(true);

			const sidecarBlob = await store.put(Buffer.from("fresh-sidecar-budget"), { extension: "png" });
			let sidecars = await store.collectGarbage({
				maxBlobSidecars: 0,
				protectRecentPublications: false,
				sessionRoots: [sessions],
			});
			for (let pass = 0; pass < 4 && sidecars.hasMore; pass += 1) {
				sidecars = await store.collectGarbage({
					maxBlobSidecars: 0,
					protectRecentPublications: false,
					sessionRoots: [sessions],
				});
			}
			expect(sidecars.hasMore).toBe(false);
			expect(await store.has(sidecarBlob.hash)).toBe(true);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("resumes bounded CAS enumeration past a live leading entry", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-cursor-"));
		try {
			const sessions = path.join(root, "sessions");
			const store = new BlobStore(path.join(root, "blobs"));
			const live = await store.put(Buffer.from("cursor-live"));
			const orphan = await store.put(Buffer.from("cursor-orphan"));
			await writeSession(path.join(sessions, "thread.jsonl"), [entry("live", null, { ref: live.ref })]);
			live.commitPublication();

			let hasMore = true;
			for (let pass = 0; pass < 4 && hasMore; pass += 1) {
				const result = await store.collectGarbage({
					maxBlobEntries: 1,
					protectRecentPublications: false,
					sessionRoots: [sessions],
				});
				hasMore = result.hasMore;
			}
			expect(await store.has(live.hash)).toBe(true);
			expect(await store.has(orphan.hash)).toBe(false);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("bounds bytes hashed while validating deletion candidates", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-hash-budget-"));
		try {
			const sessions = path.join(root, "sessions");
			await mkdir(sessions);
			const store = new BlobStore(path.join(root, "blobs"));
			const orphan = await store.put(Buffer.alloc(1024, 7));
			const result = await store.collectGarbage({
				maxHashedBytes: 512,
				protectRecentPublications: false,
				sessionRoots: [sessions],
			});
			expect(result).toMatchObject({ deletedBlobs: 0, hasMore: false });
			expect(await store.has(orphan.hash)).toBe(true);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("does not rerun lifecycle maintenance forever for a permanently oversized candidate", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-oversized-"));
		try {
			const sessions = path.join(root, "sessions");
			await mkdir(sessions);
			const store = new BlobStore(path.join(root, "blobs"));
			const oversized = await store.put(Buffer.from("xx"), { protectUntilDurable: false });
			for (let pass = 0; pass < 2; pass += 1) {
				expect(await store.collectGarbage({ maxBytes: 1, sessionRoots: [sessions] })).toMatchObject({
					deletedBlobs: 0,
					hasMore: false,
				});
			}
			store.scheduleGarbageCollection({ maxBytes: 1, sessionRoots: [sessions] });
			await store.drainScheduledGarbageCollection();
			expect(await store.has(oversized.hash)).toBe(true);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	}, 5_000);

	test("SessionManager dropSession triggers lifecycle collection", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-manager-"));
		try {
			const sessions = path.join(root, "sessions");
			const blobs = path.join(root, "blobs");
			const manager = SessionManager.create(root, sessions, undefined, {
				blobDir: blobs,
				enableFileBlobGarbageCollection: true,
			});
			const blob = await manager.putBlob(Buffer.from("manager-owned"));
			manager.appendCustomEntry("gc-test", { ref: blob.ref });
			await manager.ensureOnDisk();
			blob.commitPublication();
			// Provider/tool materialization of an already-durable attachment is a
			// read concern and must not create a new unpublished-reference lease.
			manager.materializeBlobSync(Buffer.from("manager-owned"));
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			await manager.dropSession(sessionFile!);
			// Lifecycle GC starts on the next macrotask; the delete command itself is
			// never delayed by a full mark/sweep pass.
			expect(new BlobStore(blobs).getSync(blob.hash)).not.toBeNull();
			await manager.drainBlobGarbageCollection();
			expect(await new BlobStore(blobs).has(blob.hash)).toBe(false);
			await manager.close();
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("SessionManager durable rollback releases only the abandoned blob", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-manager-rollback-"));
		try {
			const sessions = path.join(root, "sessions");
			const blobs = path.join(root, "blobs");
			const manager = SessionManager.create(root, sessions, undefined, {
				blobDir: blobs,
				enableFileBlobGarbageCollection: true,
			});
			const retained = await manager.putBlob(Buffer.from("manager-retained"));
			const abandoned = await manager.putBlob(Buffer.from("manager-abandoned"));
			const ancestorId = manager.appendCustomEntry("gc-test", { ref: retained.ref });
			manager.appendCustomEntry("gc-test", { ref: abandoned.ref });
			await manager.ensureOnDisk();
			retained.commitPublication();
			abandoned.commitPublication();
			manager.branchWithSummary(ancestorId, "", { kind: "empatra.host.thread-rollback.v1" });
			await manager.flush();

			manager.scheduleBlobGarbageCollection();
			expect(new BlobStore(blobs).getSync(abandoned.hash)).not.toBeNull();
			const result = await manager.collectBlobGarbage();
			expect(result.deletedBlobs).toBe(1);
			const store = new BlobStore(blobs);
			expect(await store.has(retained.hash)).toBe(true);
			expect(await store.has(abandoned.hash)).toBe(false);
			await manager.drainBlobGarbageCollection();
			await manager.close();
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("combines registered session roots for a shared custom CAS", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-shared-roots-"));
		try {
			const blobs = path.join(root, "blobs");
			const first = SessionManager.create(root, path.join(root, "sessions-a"), undefined, {
				blobDir: blobs,
				enableFileBlobGarbageCollection: true,
			});
			const second = SessionManager.create(root, path.join(root, "sessions-b"), undefined, {
				blobDir: blobs,
				enableFileBlobGarbageCollection: true,
			});
			const firstBlob = await first.putBlob(Buffer.from("shared-custom-root"));
			const secondBlob = await second.putBlob(Buffer.from("shared-custom-root"));
			expect(secondBlob.hash).toBe(firstBlob.hash);
			first.appendCustomEntry("gc-test", { ref: firstBlob.ref });
			second.appendCustomEntry("gc-test", { ref: secondBlob.ref });
			await first.ensureOnDisk();
			await second.ensureOnDisk();
			firstBlob.commitPublication();
			secondBlob.commitPublication();

			await first.dropSession(first.getSessionFile()!);
			await first.collectBlobGarbage();
			expect(await new BlobStore(blobs).has(firstBlob.hash)).toBe(true);
			await second.dropSession(second.getSessionFile()!);
			await second.collectBlobGarbage();
			expect(await new BlobStore(blobs).has(firstBlob.hash)).toBe(false);
			await Promise.all([first.drainBlobGarbageCollection(), second.drainBlobGarbageCollection()]);
			await Promise.all([first.close(), second.close()]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("a rewrite of an old shared digest cannot consume another manager publication lease", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-token-bound-"));
		try {
			const blobs = path.join(root, "blobs");
			const first = SessionManager.create(root, path.join(root, "sessions-a"), undefined, {
				blobDir: blobs,
				enableFileBlobGarbageCollection: true,
			});
			const second = SessionManager.create(root, path.join(root, "sessions-b"), undefined, {
				blobDir: blobs,
				enableFileBlobGarbageCollection: true,
			});
			const durable = await first.putBlob(Buffer.from("token-bound-shared"));
			first.appendCustomEntry("gc-test", { ref: durable.ref });
			await first.ensureOnDisk();
			durable.commitPublication();

			const pending = await second.putBlob(Buffer.from("token-bound-shared"));
			await first.rewriteEntries();
			await first.dropSession(first.getSessionFile()!);
			await first.collectBlobGarbage();
			expect(await new BlobStore(blobs).has(pending.hash)).toBe(true);

			second.appendCustomEntry("gc-test", { ref: pending.ref });
			await second.ensureOnDisk();
			pending.commitPublication();
			expect((await second.collectBlobGarbage()).deletedBlobs).toBe(0);
			await Promise.all([first.drainBlobGarbageCollection(), second.drainBlobGarbageCollection()]);
			await Promise.all([first.close(), second.close()]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("coalesces lifecycle bursts into one running pass and one pending rerun", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-coalesce-"));
		const sessions = path.join(root, "sessions");
		const manager = SessionManager.create(root, sessions, undefined, {
			blobDir: path.join(root, "blobs"),
			enableFileBlobGarbageCollection: true,
		});
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const original = BlobStore.prototype.collectGarbage;
		let calls = 0;
		const collection = spyOn(BlobStore.prototype, "collectGarbage").mockImplementation(async function (
			this: BlobStore,
			options,
		) {
			calls += 1;
			if (calls === 1) {
				firstEntered.resolve();
				await releaseFirst.promise;
			}
			return await original.call(this, options);
		});
		try {
			manager.scheduleBlobGarbageCollection();
			await firstEntered.promise;
			for (let index = 0; index < 100; index += 1) manager.scheduleBlobGarbageCollection();
			releaseFirst.resolve();
			await manager.drainBlobGarbageCollection();
			expect(calls).toBe(2);
		} finally {
			collection.mockRestore();
			await manager.close();
			await rm(root, { force: true, recursive: true });
		}
	});

	test("lifecycle maintenance continues bounded deletion passes until idle", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-lifecycle-converge-"));
		try {
			const blobs = path.join(root, "blobs");
			await mkdir(blobs);
			for (let index = 0; index < 257; index += 1) {
				const bytes = Buffer.from(`lifecycle-orphan-${index}`);
				const hash = new Bun.SHA256().update(bytes).digest("hex");
				await writeFile(path.join(blobs, hash), bytes);
			}
			const manager = SessionManager.create(root, path.join(root, "sessions"), undefined, {
				blobDir: blobs,
				enableFileBlobGarbageCollection: true,
			});
			manager.scheduleBlobGarbageCollection();
			await manager.drainBlobGarbageCollection();
			expect(await readdir(blobs)).toHaveLength(0);
			await manager.close();
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("non-filesystem session storage cannot authorize a filesystem mark-and-sweep", async () => {
		const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-blob-gc-memory-storage-"));
		try {
			const blobs = path.join(root, "blobs");
			const manager = SessionManager.create(root, path.join(root, "sessions"), new MemorySessionStorage(), {
				blobDir: blobs,
			});
			const blob = await manager.putBlob(Buffer.from("memory-storage-live"));
			manager.appendCustomEntry("gc-test", { ref: blob.ref });
			await manager.ensureOnDisk();
			blob.commitPublication();
			manager.scheduleBlobGarbageCollection();
			await expect(manager.collectBlobGarbage()).rejects.toThrow("single-writer file-storage authority");
			expect(await new BlobStore(blobs).has(blob.hash)).toBe(true);
			await manager.close();
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
