import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import {
	EMPATRA_HOST_USER_MEDIA_ENTRY,
	parseEmpatraHostUserMediaCancellation,
	parseEmpatraHostUserMediaMarker,
} from "../modes/empatra-host/user-media-projection";
import type { SessionEntry } from "./session-entries";

const BLOB_PREFIX = "blob:sha256:";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_GC_MAX_DELETES = 256;
const DEFAULT_GC_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_GC_MAX_SESSION_FILES = 20_000;
const DEFAULT_GC_MAX_SESSION_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_GC_MAX_SESSION_ENTRIES = 2_000_000;
const DEFAULT_GC_MAX_SESSION_LINE_BYTES = 64 * 1024 * 1024;
const DEFAULT_GC_MAX_FILESYSTEM_ENTRIES = 200_000;
const DEFAULT_GC_MAX_BLOB_ENTRIES = 100_000;
const DEFAULT_GC_MAX_BLOB_SIDECARS = 16;
const DEFAULT_GC_MAX_HASHED_BYTES = 512 * 1024 * 1024;
const MAX_RECENT_PUBLICATIONS = 4096;
// Node does not expose O_NOFOLLOW on Windows. There we pin the opened inode and
// require matching lstat identities both before and after I/O; missing/zero
// identity metadata fails closed instead of silently trusting a reparse path.
const HAS_ATOMIC_NOFOLLOW =
	process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number" && fs.constants.O_NOFOLLOW !== 0;
const NOFOLLOW_OPEN_FLAGS = HAS_ATOMIC_NOFOLLOW ? fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK : 0;

/** Canonical blob hash shape: exactly 64 lowercase hex chars (a SHA-256 digest). */
export const BLOB_HASH_RE = /^[a-f0-9]{64}$/;

export interface BlobPutOptions {
	/** Optional file extension for a sidecar hardlink/copy that OS openers can type-detect. */
	extension?: string;
	/**
	 * Protect a newly published digest until noteDurableReferences confirms its
	 * journal reference. Set false for read/materialization-only publications.
	 */
	protectUntilDurable?: boolean;
}

export interface BlobPutResult {
	hash: string;
	/** Canonical content-addressed path, always `<dir>/<sha256-hex>`. */
	path: string;
	/** Path with the requested extension when supplied, otherwise the canonical path. */
	displayPath: string;
	get ref(): string;
	/** Confirm that this exact publication's reference became durable. Idempotent. */
	commitPublication(): void;
	/** Release an abandoned unpublished-reference lease. Idempotent. */
	releasePublication(): void;
}

export interface BlobPublicationCapture<T> {
	/** Release only the leases created while producing this exact serialized value. */
	abandon(): void;
	commit(): void;
	value: T;
}

export interface BlobGarbageCollectionOptions {
	/** Roots containing every durable JSONL session that may reference this CAS. */
	sessionRoots: readonly string[];
	/** Maximum canonical blobs removed by one maintenance pass. */
	maxDeletes?: number;
	/** Maximum canonical payload bytes removed by one maintenance pass. */
	maxBytes?: number;
	/** Fail closed without sweeping when the durable mark phase exceeds these budgets. */
	maxSessionFiles?: number;
	maxSessionBytes?: number;
	maxSessionEntries?: number;
	maxSessionLineBytes?: number;
	maxFilesystemEntries?: number;
	maxBlobEntries?: number;
	maxBlobSidecars?: number;
	/** Maximum bytes hashed while validating deletion candidates in one pass. */
	maxHashedBytes?: number;
	/** Lifecycle passes preserve freshly-published blobs until their JSONL write is confirmed. */
	protectRecentPublications?: boolean;
}

export interface BlobGarbageCollectionResult {
	deletedBytes: number;
	deletedBlobs: number;
	hasMore: boolean;
	liveBlobs: number;
	scannedBlobs: number;
}

interface BlobStoreCoordinator {
	recentPublicationLeaseCount: number;
	recentPublications: Map<string, Set<symbol>>;
	durableReferenceEpoch: number;
	sessionRoots: Set<string>;
	gcTail: Promise<void>;
	lifecycleIdle: Promise<void>;
	lifecycleResolve?: () => void;
	lifecycleRerun: boolean;
	lifecycleRunning: boolean;
	lifecycleScheduled: boolean;
	lifecycleTask?: () => Promise<void>;
	sweepState: BlobSweepState;
}

interface BlobSweepState {
	directory?: fs.Dir;
	directoryIdentity?: fs.Stats;
	needsContinuation: boolean;
	pendingGroups: Array<[hash: string, names: string[]]>;
	restartAfterCycle: boolean;
}

interface SessionReferenceEntry {
	id: string;
	parentId: string | null;
	refs: Set<string>;
	mediaReference?: { refs: Set<string>; turnId: string };
	mediaCancellation?: { markerEntryId: string; turnId: string };
}

interface BlobReferenceScanBudget {
	filesystemEntries: number;
	sessionBytes: number;
	sessionEntries: number;
	sessionFiles: number;
	readonly maxFilesystemEntries: number;
	readonly maxSessionBytes: number;
	readonly maxSessionEntries: number;
	readonly maxSessionFiles: number;
	readonly maxSessionLineBytes: number;
}

const blobStoreCoordinators = new Map<string, BlobStoreCoordinator>();

function coordinatorFor(dir: string): BlobStoreCoordinator {
	const key = path.resolve(dir);
	let coordinator = blobStoreCoordinators.get(key);
	if (!coordinator) {
		coordinator = {
			recentPublicationLeaseCount: 0,
			recentPublications: new Map(),
			durableReferenceEpoch: 0,
			sessionRoots: new Set(),
			gcTail: Promise.resolve(),
			lifecycleIdle: Promise.resolve(),
			lifecycleRerun: false,
			lifecycleRunning: false,
			lifecycleScheduled: false,
			sweepState: { needsContinuation: false, pendingGroups: [], restartAfterCycle: false },
		};
		blobStoreCoordinators.set(key, coordinator);
	}
	return coordinator;
}

function noteRecentPublication(coordinator: BlobStoreCoordinator, hash: string): symbol {
	if (coordinator.recentPublicationLeaseCount >= MAX_RECENT_PUBLICATIONS) {
		throw new Error(
			"Blob publication capacity is exhausted; persist pending references before publishing more blobs",
		);
	}
	const lease = Symbol(hash);
	const leases = coordinator.recentPublications.get(hash);
	if (leases) leases.add(lease);
	else coordinator.recentPublications.set(hash, new Set([lease]));
	coordinator.recentPublicationLeaseCount += 1;
	return lease;
}

function releaseRecentPublication(coordinator: BlobStoreCoordinator, hash: string, lease: symbol): void {
	const leases = coordinator.recentPublications.get(hash);
	if (!leases?.delete(lease)) return;
	coordinator.recentPublicationLeaseCount -= 1;
	if (leases.size === 0) coordinator.recentPublications.delete(hash);
}

function noteBlobDirectoryMutation(coordinator: BlobStoreCoordinator): void {
	if (coordinator.sweepState.directoryIdentity) coordinator.sweepState.restartAfterCycle = true;
}

function serializedBlobReferenceCounts(serializedJsonl: string): Map<string, number> {
	const referenced = new Map<string, number>();
	const countReference = (hash: string): void => {
		referenced.set(hash, (referenced.get(hash) ?? 0) + 1);
	};
	for (const match of serializedJsonl.matchAll(/"blob:sha256:([a-f0-9]{64})"/gu)) {
		if (match[1]) countReference(match[1]);
	}
	for (const line of serializedJsonl.split("\n")) {
		if (!line.includes(`"customType":"${EMPATRA_HOST_USER_MEDIA_ENTRY}"`)) continue;
		try {
			const parsed = JSON.parse(line);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
			const mediaReference = readMediaReferences(parsed as Record<string, unknown>).mediaReference;
			if (mediaReference) for (const hash of mediaReference.refs) countReference(hash);
		} catch {
			// Strict collection later remains the authority for malformed journals.
		}
	}
	return referenced;
}

function collectBlobRefs(value: unknown, refs: Set<string>): void {
	if (typeof value === "string") {
		const hash = parseBlobRef(value);
		if (hash) refs.add(hash);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectBlobRefs(item, refs);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const item of Object.values(value)) collectBlobRefs(item, refs);
}

function readMediaReferences(record: Record<string, unknown>): {
	mediaReference?: { refs: Set<string>; turnId: string };
	mediaCancellation?: { markerEntryId: string; turnId: string };
} {
	const entry = record as unknown as SessionEntry;
	const cancellation = parseEmpatraHostUserMediaCancellation(entry);
	if (cancellation) {
		return { mediaCancellation: { markerEntryId: cancellation.markerEntryId, turnId: cancellation.turnId } };
	}
	const marker = parseEmpatraHostUserMediaMarker(entry);
	if (!marker) return {};
	return { mediaReference: { refs: new Set(marker.images.map(image => image.sha256)), turnId: marker.turnId } };
}

/**
 * Content-addressed blob store for externalizing large binary data (images) from session JSONL files.
 *
 * Files are stored canonically at `<dir>/<sha256-hex>`. Callers may also request
 * a typed sidecar path (`<dir>/<sha256-hex>.<ext>`) for `file://` links and OS
 * image viewers; blob refs and reads still address the extensionless hash path.
 * The SHA-256 hash is computed over the raw binary data (not base64).
 * Content-addressing makes writes idempotent and provides automatic deduplication
 * across sessions.
 */

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};

function normalizeBlobExtension(extension: string | undefined): string | undefined {
	if (!extension) return undefined;
	const normalized = extension.startsWith(".") ? extension.slice(1) : extension;
	if (normalized.length === 0 || normalized.length > 32) return undefined;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) return undefined;
	return normalized.toLowerCase();
}

function pathError(message: string, filePath: string): Error {
	return new Error(`${message}: ${filePath}`);
}

function assertRegularFile(stats: fs.Stats, filePath: string): void {
	if (!stats.isFile()) throw pathError("Refusing non-regular blob entry", filePath);
}

function hasSameFileIdentity(expected: fs.Stats, actual: fs.Stats, filePath: string): boolean {
	const identities = [expected, actual].map(stats => ({ dev: stats.dev, ino: stats.ino }));
	if (identities.some(({ dev, ino }) => !Number.isSafeInteger(dev) || !Number.isSafeInteger(ino) || ino === 0)) {
		throw pathError("Cannot verify blob entry identity without O_NOFOLLOW", filePath);
	}
	return expected.dev === actual.dev && expected.ino === actual.ino;
}

function assertSameFileIdentity(expected: fs.Stats, actual: fs.Stats, filePath: string): void {
	if (!hasSameFileIdentity(expected, actual, filePath)) {
		throw pathError("Blob entry changed while it was being opened", filePath);
	}
}

function assertStablePathIdentity(before: fs.Stats, opened: fs.Stats, after: fs.Stats, filePath: string): void {
	assertSameFileIdentity(before, opened, filePath);
	assertSameFileIdentity(opened, after, filePath);
}

async function validateStoreDirectory(dir: string, normalizePrivateMode: boolean): Promise<void> {
	const before = HAS_ATOMIC_NOFOLLOW ? undefined : await fsp.lstat(dir);
	if (before?.isSymbolicLink() || (before && !before.isDirectory())) {
		throw pathError("Refusing non-directory blob store", dir);
	}
	const flags = fs.constants.O_RDONLY | (HAS_ATOMIC_NOFOLLOW ? fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY : 0);
	const handle = await fsp.open(dir, flags);
	try {
		const opened = await handle.stat();
		if (!opened.isDirectory()) throw pathError("Refusing non-directory blob store", dir);
		if (!HAS_ATOMIC_NOFOLLOW) {
			const after = await fsp.lstat(dir);
			if (after.isSymbolicLink() || !after.isDirectory()) throw pathError("Refusing non-directory blob store", dir);
			assertStablePathIdentity(before!, opened, after, dir);
		}
		if (normalizePrivateMode && process.platform !== "win32" && (opened.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
			await handle.chmod(PRIVATE_DIRECTORY_MODE);
		}
	} finally {
		await handle.close();
	}
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
	await fsp.mkdir(dir, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
	await validateStoreDirectory(dir, true);
}

function validateStoreDirectorySync(dir: string, normalizePrivateMode: boolean): void {
	const before = HAS_ATOMIC_NOFOLLOW ? undefined : fs.lstatSync(dir);
	if (before?.isSymbolicLink() || (before && !before.isDirectory())) {
		throw pathError("Refusing non-directory blob store", dir);
	}
	const flags = fs.constants.O_RDONLY | (HAS_ATOMIC_NOFOLLOW ? fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY : 0);
	const fd = fs.openSync(dir, flags);
	try {
		const opened = fs.fstatSync(fd);
		if (!opened.isDirectory()) throw pathError("Refusing non-directory blob store", dir);
		if (!HAS_ATOMIC_NOFOLLOW) {
			const after = fs.lstatSync(dir);
			if (after.isSymbolicLink() || !after.isDirectory()) throw pathError("Refusing non-directory blob store", dir);
			assertStablePathIdentity(before!, opened, after, dir);
		}
		if (normalizePrivateMode && process.platform !== "win32" && (opened.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
			fs.fchmodSync(fd, PRIVATE_DIRECTORY_MODE);
		}
	} finally {
		fs.closeSync(fd);
	}
}

function ensurePrivateDirectorySync(dir: string): void {
	fs.mkdirSync(dir, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
	validateStoreDirectorySync(dir, true);
}

async function assertPublishedRegularFile(filePath: string, expected: fs.Stats): Promise<void> {
	const published = await fsp.lstat(filePath);
	assertRegularFile(published, filePath);
	assertSameFileIdentity(expected, published, filePath);
}

function assertPublishedRegularFileSync(filePath: string, expected: fs.Stats): void {
	const published = fs.lstatSync(filePath);
	assertRegularFile(published, filePath);
	assertSameFileIdentity(expected, published, filePath);
}

async function readRegularFile(filePath: string): Promise<Buffer> {
	const before = HAS_ATOMIC_NOFOLLOW ? undefined : await fsp.lstat(filePath);
	if (before?.isSymbolicLink() || (before && !before.isFile())) {
		throw pathError("Refusing non-regular blob entry", filePath);
	}
	const handle = await fsp.open(filePath, fs.constants.O_RDONLY | NOFOLLOW_OPEN_FLAGS).catch(async error => {
		if ((error as NodeJS.ErrnoException).code === "ELOOP" && (await fsp.lstat(filePath)).isSymbolicLink()) {
			throw pathError("Refusing non-regular blob entry", filePath);
		}
		throw error;
	});
	try {
		const opened = await handle.stat();
		assertRegularFile(opened, filePath);
		if (!HAS_ATOMIC_NOFOLLOW) {
			const afterOpen = await fsp.lstat(filePath);
			if (afterOpen.isSymbolicLink() || !afterOpen.isFile()) {
				throw pathError("Refusing non-regular blob entry", filePath);
			}
			assertStablePathIdentity(before!, opened, afterOpen, filePath);
		}
		const data = await handle.readFile();
		if (!HAS_ATOMIC_NOFOLLOW) {
			const afterRead = await fsp.lstat(filePath);
			if (afterRead.isSymbolicLink() || !afterRead.isFile()) {
				throw pathError("Refusing non-regular blob entry", filePath);
			}
			assertStablePathIdentity(before!, opened, afterRead, filePath);
		}
		return data;
	} finally {
		await handle.close();
	}
}

function readRegularFileSync(filePath: string): Buffer {
	const before = HAS_ATOMIC_NOFOLLOW ? undefined : fs.lstatSync(filePath);
	if (before?.isSymbolicLink() || (before && !before.isFile())) {
		throw pathError("Refusing non-regular blob entry", filePath);
	}
	let fd: number;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW_OPEN_FLAGS);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP" && fs.lstatSync(filePath).isSymbolicLink()) {
			throw pathError("Refusing non-regular blob entry", filePath);
		}
		throw error;
	}
	try {
		const opened = fs.fstatSync(fd);
		assertRegularFile(opened, filePath);
		if (!HAS_ATOMIC_NOFOLLOW) {
			const afterOpen = fs.lstatSync(filePath);
			if (afterOpen.isSymbolicLink() || !afterOpen.isFile()) {
				throw pathError("Refusing non-regular blob entry", filePath);
			}
			assertStablePathIdentity(before!, opened, afterOpen, filePath);
		}
		const data = fs.readFileSync(fd);
		if (!HAS_ATOMIC_NOFOLLOW) {
			const afterRead = fs.lstatSync(filePath);
			if (afterRead.isSymbolicLink() || !afterRead.isFile()) {
				throw pathError("Refusing non-regular blob entry", filePath);
			}
			assertStablePathIdentity(before!, opened, afterRead, filePath);
		}
		return data;
	} finally {
		fs.closeSync(fd);
	}
}

function assertExpectedBytes(actual: Buffer, expected: Buffer, filePath: string): void {
	if (!actual.equals(expected)) throw pathError("Blob entry does not match its content address", filePath);
}

async function readExistingRegularFile(filePath: string): Promise<Buffer | null> {
	try {
		return await readRegularFile(filePath);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

function readExistingRegularFileSync(filePath: string): Buffer | null {
	try {
		return readRegularFileSync(filePath);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function publishRegularFile(filePath: string, data: Buffer): Promise<void> {
	const existing = await readExistingRegularFile(filePath);
	if (existing) {
		assertExpectedBytes(existing, data, filePath);
		return;
	}

	// Publish a fully-written private inode through a no-overwrite hard link. The
	// rename fallback is for filesystems without hardlinks; rename replaces the
	// directory entry itself, never writes through a raced destination symlink.
	const tempPath = path.join(path.dirname(filePath), `.blob-tmp-${process.pid}-${Bun.randomUUIDv7()}`);
	let tempExists = true;
	const handle = await fsp.open(
		tempPath,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW_OPEN_FLAGS,
		PRIVATE_FILE_MODE,
	);
	let tempStats: fs.Stats;
	let verifiedExistingPublication = false;
	try {
		try {
			tempStats = await handle.stat();
			assertRegularFile(tempStats, tempPath);
			if (tempStats.nlink !== 1) throw pathError("Refusing multiply-linked temporary blob", tempPath);
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await fsp.link(tempPath, filePath);
		} catch (error) {
			const published = await readExistingRegularFile(filePath);
			if (published) {
				assertExpectedBytes(published, data, filePath);
				verifiedExistingPublication = true;
			} else {
				logger.debug("Blob hardlink publication failed; falling back to atomic rename", {
					filePath,
					error: error instanceof Error ? error.message : String(error),
				});
				try {
					await fsp.rename(tempPath, filePath);
					tempExists = false;
				} catch (renameError) {
					const racedPublication = await readExistingRegularFile(filePath);
					if (!racedPublication) throw renameError;
					assertExpectedBytes(racedPublication, data, filePath);
					verifiedExistingPublication = true;
				}
			}
		}
		if (!verifiedExistingPublication) await assertPublishedRegularFile(filePath, tempStats);
	} finally {
		if (tempExists) await fsp.unlink(tempPath).catch(() => undefined);
	}
}

function publishRegularFileSync(filePath: string, data: Buffer): void {
	const existing = readExistingRegularFileSync(filePath);
	if (existing) {
		assertExpectedBytes(existing, data, filePath);
		return;
	}

	const tempPath = path.join(path.dirname(filePath), `.blob-tmp-${process.pid}-${Bun.randomUUIDv7()}`);
	let tempExists = true;
	const fd = fs.openSync(
		tempPath,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW_OPEN_FLAGS,
		PRIVATE_FILE_MODE,
	);
	let tempStats: fs.Stats;
	let verifiedExistingPublication = false;
	try {
		try {
			tempStats = fs.fstatSync(fd);
			assertRegularFile(tempStats, tempPath);
			if (tempStats.nlink !== 1) throw pathError("Refusing multiply-linked temporary blob", tempPath);
			fs.writeFileSync(fd, data);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		try {
			fs.linkSync(tempPath, filePath);
		} catch (error) {
			const published = readExistingRegularFileSync(filePath);
			if (published) {
				assertExpectedBytes(published, data, filePath);
				verifiedExistingPublication = true;
			} else {
				logger.debug("Blob hardlink publication failed; falling back to atomic rename", {
					filePath,
					error: error instanceof Error ? error.message : String(error),
				});
				try {
					fs.renameSync(tempPath, filePath);
					tempExists = false;
				} catch (renameError) {
					const racedPublication = readExistingRegularFileSync(filePath);
					if (!racedPublication) throw renameError;
					assertExpectedBytes(racedPublication, data, filePath);
					verifiedExistingPublication = true;
				}
			}
		}
		if (!verifiedExistingPublication) assertPublishedRegularFileSync(filePath, tempStats);
	} finally {
		if (tempExists) {
			try {
				fs.unlinkSync(tempPath);
			} catch {}
		}
	}
}

async function ensureDisplayPath(blobPath: string, displayPath: string, data: Buffer): Promise<void> {
	if (displayPath === blobPath) return;
	const canonical = await fsp.lstat(blobPath);
	assertRegularFile(canonical, blobPath);
	let existingStats: fs.Stats | undefined;
	try {
		existingStats = await fsp.lstat(displayPath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (existingStats) {
		assertRegularFile(existingStats, displayPath);
		if (hasSameFileIdentity(canonical, existingStats, displayPath)) return;
		const existing = await readRegularFile(displayPath);
		assertExpectedBytes(existing, data, displayPath);
		return;
	}
	try {
		await fsp.link(blobPath, displayPath);
		try {
			await assertPublishedRegularFile(displayPath, canonical);
		} catch (error) {
			await fsp.unlink(displayPath).catch(() => undefined);
			throw error;
		}
		return;
	} catch (error) {
		const published = await readExistingRegularFile(displayPath);
		if (published) {
			assertExpectedBytes(published, data, displayPath);
			return;
		}
		logger.debug("Blob display hardlink failed; falling back to atomic publication", {
			blobPath,
			displayPath,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	await publishRegularFile(displayPath, data);
}

function ensureDisplayPathSync(blobPath: string, displayPath: string, data: Buffer): void {
	if (displayPath === blobPath) return;
	const canonical = fs.lstatSync(blobPath);
	assertRegularFile(canonical, blobPath);
	let existingStats: fs.Stats | undefined;
	try {
		existingStats = fs.lstatSync(displayPath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (existingStats) {
		assertRegularFile(existingStats, displayPath);
		if (hasSameFileIdentity(canonical, existingStats, displayPath)) return;
		const existing = readRegularFileSync(displayPath);
		assertExpectedBytes(existing, data, displayPath);
		return;
	}
	try {
		fs.linkSync(blobPath, displayPath);
		try {
			assertPublishedRegularFileSync(displayPath, canonical);
		} catch (error) {
			try {
				fs.unlinkSync(displayPath);
			} catch {}
			throw error;
		}
		return;
	} catch (error) {
		const published = readExistingRegularFileSync(displayPath);
		if (published) {
			assertExpectedBytes(published, data, displayPath);
			return;
		}
		logger.debug("Blob display hardlink failed; falling back to atomic publication", {
			blobPath,
			displayPath,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	publishRegularFileSync(displayPath, data);
}

async function listSessionFiles(
	root: string,
	blobDirectory: string,
	budget: BlobReferenceScanBudget,
): Promise<string[]> {
	let rootStats: fs.Stats;
	try {
		rootStats = await fsp.lstat(root);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
		throw pathError("Refusing unsafe session root during blob collection", root);
	}

	const files: string[] = [];
	const pending = [path.resolve(root)];
	const excluded = path.resolve(blobDirectory);
	while (pending.length > 0) {
		const directory = pending.pop()!;
		for await (const entry of await fsp.opendir(directory)) {
			budget.filesystemEntries += 1;
			if (budget.filesystemEntries > budget.maxFilesystemEntries) {
				throw pathError("Blob reference scan exceeded its filesystem entry budget", root);
			}
			const candidate = path.join(directory, entry.name);
			if (path.resolve(candidate) === excluded) continue;
			if (entry.isSymbolicLink()) {
				throw pathError("Refusing symlink in session tree during blob collection", candidate);
			}
			if (entry.isDirectory()) {
				pending.push(candidate);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				budget.sessionFiles += 1;
				if (budget.sessionFiles > budget.maxSessionFiles) {
					throw pathError("Blob reference scan exceeded its session file budget", root);
				}
				files.push(candidate);
			}
		}
	}
	return files;
}

function assertUnchangedSessionFile(before: fs.Stats, after: fs.Stats, filePath: string): void {
	assertSameFileIdentity(before, after, filePath);
	if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
		throw pathError("Session changed during blob reference scan", filePath);
	}
}

async function collectSessionFileReferences(filePath: string, budget: BlobReferenceScanBudget): Promise<Set<string>> {
	const beforePath = HAS_ATOMIC_NOFOLLOW ? undefined : await fsp.lstat(filePath);
	if (beforePath?.isSymbolicLink() || (beforePath && !beforePath.isFile())) {
		throw pathError("Refusing unsafe session file during blob collection", filePath);
	}
	const handle = await fsp.open(filePath, fs.constants.O_RDONLY | NOFOLLOW_OPEN_FLAGS);
	try {
		const opened = await handle.stat();
		assertRegularFile(opened, filePath);
		budget.sessionBytes += opened.size;
		if (!Number.isSafeInteger(opened.size) || opened.size < 0 || budget.sessionBytes > budget.maxSessionBytes) {
			throw pathError("Blob reference scan exceeded its session byte budget", filePath);
		}
		if (!HAS_ATOMIC_NOFOLLOW) {
			const afterOpen = await fsp.lstat(filePath);
			if (afterOpen.isSymbolicLink() || !afterOpen.isFile()) {
				throw pathError("Refusing unsafe session file during blob collection", filePath);
			}
			assertStablePathIdentity(beforePath!, opened, afterOpen, filePath);
		}

		const entries = new Map<string, SessionReferenceEntry>();
		const alwaysLive = new Set<string>();
		let leafId: string | null = null;
		const consumeLine = (rawLine: string): void => {
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (line.length === 0) return;
			budget.sessionEntries += 1;
			if (budget.sessionEntries > budget.maxSessionEntries) {
				throw pathError("Blob reference scan exceeded its session entry budget", filePath);
			}
			if (Buffer.byteLength(line, "utf8") > budget.maxSessionLineBytes) {
				throw pathError("Blob reference scan exceeded its session line budget", filePath);
			}
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				throw pathError("Refusing malformed session during blob collection", filePath);
			}
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				throw pathError("Refusing malformed session record during blob collection", filePath);
			}
			const record = value as Record<string, unknown>;
			const refs = new Set<string>();
			collectBlobRefs(record, refs);
			if (record.type === "session" || typeof record.id !== "string") {
				for (const ref of refs) alwaysLive.add(ref);
				return;
			}
			if (record.parentId !== null && typeof record.parentId !== "string") {
				throw pathError("Refusing malformed session ancestry during blob collection", filePath);
			}
			if (entries.has(record.id)) throw pathError("Refusing duplicate session entry id", filePath);
			const media = readMediaReferences(record);
			entries.set(record.id, {
				id: record.id,
				parentId: record.parentId,
				refs,
				mediaReference: media.mediaReference,
				mediaCancellation: media.mediaCancellation,
			});
			leafId = record.id;
		};

		const decoder = new TextDecoder();
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let pendingText = "";
		let position = 0;
		while (true) {
			const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
			if (bytesRead === 0) break;
			position += bytesRead;
			pendingText += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
			if (pendingText.length > budget.maxSessionLineBytes) {
				throw pathError("Blob reference scan exceeded its session line budget", filePath);
			}
			let newline = pendingText.indexOf("\n");
			while (newline >= 0) {
				consumeLine(pendingText.slice(0, newline));
				pendingText = pendingText.slice(newline + 1);
				newline = pendingText.indexOf("\n");
			}
		}
		pendingText += decoder.decode();
		if (pendingText.length > 0) consumeLine(pendingText);

		const pathEntries: SessionReferenceEntry[] = [];
		const seen = new Set<string>();
		let cursor: string | null = leafId;
		while (cursor) {
			if (seen.has(cursor)) throw pathError("Refusing cyclic session ancestry during blob collection", filePath);
			seen.add(cursor);
			const entry = entries.get(cursor);
			if (!entry) throw pathError("Refusing broken session ancestry during blob collection", filePath);
			pathEntries.push(entry);
			cursor = entry.parentId;
		}
		pathEntries.reverse();
		const live = new Set(alwaysLive);
		const mediaByEntry = new Map<string, { refs: Set<string>; turnId: string }>();
		for (const entry of pathEntries) {
			for (const ref of entry.refs) live.add(ref);
			if (entry.mediaReference) mediaByEntry.set(entry.id, entry.mediaReference);
			if (entry.mediaCancellation) {
				const marker = mediaByEntry.get(entry.mediaCancellation.markerEntryId);
				if (marker?.turnId === entry.mediaCancellation.turnId) {
					mediaByEntry.delete(entry.mediaCancellation.markerEntryId);
				}
			}
		}
		for (const media of mediaByEntry.values()) {
			for (const ref of media.refs) live.add(ref);
		}

		const afterHandle = await handle.stat();
		assertUnchangedSessionFile(opened, afterHandle, filePath);
		const afterPath = await fsp.lstat(filePath);
		if (afterPath.isSymbolicLink() || !afterPath.isFile()) {
			throw pathError("Refusing unsafe session file during blob collection", filePath);
		}
		assertUnchangedSessionFile(opened, afterPath, filePath);
		return live;
	} finally {
		await handle.close();
	}
}

async function collectLiveBlobReferences(
	sessionRoots: readonly string[],
	blobDirectory: string,
	limits: Omit<BlobReferenceScanBudget, "filesystemEntries" | "sessionBytes" | "sessionEntries" | "sessionFiles">,
): Promise<Set<string>> {
	const live = new Set<string>();
	const budget: BlobReferenceScanBudget = {
		...limits,
		filesystemEntries: 0,
		sessionBytes: 0,
		sessionEntries: 0,
		sessionFiles: 0,
	};
	const roots = [...new Set(sessionRoots.map(root => path.resolve(root)))];
	for (const root of roots) {
		const files = await listSessionFiles(root, blobDirectory, budget);
		for (const file of files) {
			for (const ref of await collectSessionFileReferences(file, budget)) live.add(ref);
		}
	}
	return live;
}

function blobEntryHash(name: string): string | undefined {
	if (BLOB_HASH_RE.test(name)) return name;
	const separator = name.indexOf(".");
	const hash = separator > 0 ? name.slice(0, separator) : "";
	return BLOB_HASH_RE.test(hash) ? hash : undefined;
}

async function verifyBlobEntry(
	filePath: string,
	expectedHash: string,
	maxReadableBytes: number,
): Promise<{ size: number; stats: fs.Stats }> {
	const before = await fsp.lstat(filePath);
	if (before.isSymbolicLink() || !before.isFile())
		throw pathError("Refusing unsafe blob entry during collection", filePath);
	if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxReadableBytes) {
		throw pathError("Refusing oversized blob entry during bounded collection", filePath);
	}
	const handle = await fsp.open(filePath, fs.constants.O_RDONLY | NOFOLLOW_OPEN_FLAGS);
	try {
		const opened = await handle.stat();
		assertRegularFile(opened, filePath);
		assertSameFileIdentity(before, opened, filePath);
		if (opened.size !== before.size) throw pathError("Blob entry changed during collection", filePath);
		const hasher = new Bun.SHA256();
		const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, before.size)));
		let position = 0;
		while (position < before.size) {
			const { bytesRead } = await handle.read(
				buffer,
				0,
				Math.min(buffer.byteLength, before.size - position),
				position,
			);
			if (bytesRead === 0) throw pathError("Blob entry was truncated during collection", filePath);
			hasher.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
		if (hasher.digest("hex") !== expectedHash) {
			throw pathError("Refusing corrupt blob entry during collection", filePath);
		}
		const after = await fsp.lstat(filePath);
		if (after.isSymbolicLink() || !after.isFile())
			throw pathError("Refusing unsafe blob entry during collection", filePath);
		assertStablePathIdentity(before, opened, after, filePath);
		return { size: before.size, stats: after };
	} finally {
		await handle.close();
	}
}

async function resetBlobSweepState(state: BlobSweepState): Promise<void> {
	await state.directory?.close().catch(() => undefined);
	state.directory = undefined;
	state.directoryIdentity = undefined;
	state.needsContinuation = false;
	state.pendingGroups = [];
	state.restartAfterCycle = false;
}

function assertSweepDirectoryCurrent(directory: string, state: BlobSweepState): void {
	if (!state.directoryIdentity) throw pathError("Blob sweep has no pinned directory identity", directory);
	const current = fs.lstatSync(directory);
	if (current.isSymbolicLink() || !current.isDirectory()) {
		throw pathError("Refusing changed blob directory during collection", directory);
	}
	assertSameFileIdentity(state.directoryIdentity, current, directory);
}

async function sweepOrphanBlobs(
	directory: string,
	live: ReadonlySet<string>,
	recent: ReadonlyMap<string, ReadonlySet<symbol>>,
	state: BlobSweepState,
	options: Required<
		Pick<
			BlobGarbageCollectionOptions,
			| "maxBlobEntries"
			| "maxBlobSidecars"
			| "maxBytes"
			| "maxDeletes"
			| "maxHashedBytes"
			| "protectRecentPublications"
		>
	>,
	isSnapshotCurrent: () => boolean,
): Promise<BlobGarbageCollectionResult> {
	try {
		await validateStoreDirectory(directory, false);
	} catch (error) {
		if (isEnoent(error) && state.directoryIdentity === undefined)
			return { deletedBlobs: 0, deletedBytes: 0, hasMore: false, liveBlobs: live.size, scannedBlobs: 0 };
		await resetBlobSweepState(state);
		throw error;
	}
	if (state.directoryIdentity) {
		try {
			assertSweepDirectoryCurrent(directory, state);
		} catch (error) {
			await resetBlobSweepState(state);
			throw error;
		}
	} else {
		const before = await fsp.lstat(directory);
		const opened = await fsp.opendir(directory);
		try {
			const after = await fsp.lstat(directory);
			if (before.isSymbolicLink() || after.isSymbolicLink() || !before.isDirectory() || !after.isDirectory()) {
				throw pathError("Refusing changed blob directory during collection", directory);
			}
			assertSameFileIdentity(before, after, directory);
			state.directory = opened;
			state.directoryIdentity = after;
		} catch (error) {
			await opened.close().catch(() => undefined);
			throw error;
		}
	}

	let scannedBlobs = state.pendingGroups.length;
	if (state.pendingGroups.length === 0 && state.directory) {
		const entriesByHash = new Map<string, string[]>();
		let visitedEntries = 0;
		while (visitedEntries < options.maxBlobEntries) {
			const entry = await state.directory.read();
			if (!entry) {
				await state.directory.close().catch(() => undefined);
				state.directory = undefined;
				break;
			}
			visitedEntries += 1;
			const hash = blobEntryHash(entry.name);
			if (!hash) continue;
			const names = entriesByHash.get(hash);
			if (names) names.push(entry.name);
			else entriesByHash.set(hash, [entry.name]);
		}
		state.pendingGroups = [...entriesByHash].sort(([left], [right]) => left.localeCompare(right));
		scannedBlobs = state.pendingGroups.length;
	}

	let hasMore = false;
	let deletedBlobs = 0;
	let deletedBytes = 0;
	let hashedBytes = 0;
	while (state.pendingGroups.length > 0) {
		const [hash, names] = state.pendingGroups[0]!;
		await new Promise<void>(resolve => setImmediate(resolve));
		try {
			assertSweepDirectoryCurrent(directory, state);
		} catch (error) {
			await resetBlobSweepState(state);
			throw error;
		}
		if (!isSnapshotCurrent()) {
			hasMore = true;
			break;
		}
		if (live.has(hash) || (options.protectRecentPublications && recent.has(hash))) {
			state.pendingGroups.shift();
			continue;
		}
		if (names.length > options.maxBlobSidecars + 1) {
			logger.warn("Skipped blob exceeding garbage collection sidecar limits", {
				hash,
				sidecars: names.length - 1,
			});
			state.pendingGroups.shift();
			continue;
		}
		if (deletedBlobs >= options.maxDeletes || deletedBytes >= options.maxBytes) {
			hasMore = true;
			break;
		}
		const remainingBytes = options.maxBytes - deletedBytes;
		let declaredHashedBytes = 0;
		const declaredPayloadBytes = names.reduce((largest, name) => {
			try {
				const stats = fs.lstatSync(path.join(directory, name));
				if (!stats.isFile() || stats.isSymbolicLink()) return largest;
				declaredHashedBytes += stats.size;
				return Math.max(largest, stats.size);
			} catch {
				return largest;
			}
		}, 0);
		if (!Number.isSafeInteger(declaredHashedBytes)) {
			logger.warn("Skipped blob with an unsafe declared hash byte count during garbage collection", { hash });
			state.pendingGroups.shift();
			continue;
		}
		if (declaredPayloadBytes > options.maxBytes || declaredHashedBytes > options.maxHashedBytes) {
			logger.warn("Skipped blob exceeding per-pass garbage collection byte limits", {
				declaredHashedBytes,
				declaredPayloadBytes,
				hash,
			});
			state.pendingGroups.shift();
			continue;
		}
		if (declaredPayloadBytes > remainingBytes || declaredHashedBytes > options.maxHashedBytes - hashedBytes) {
			hasMore = true;
			break;
		}
		hashedBytes += declaredHashedBytes;
		let payloadBytes = 0;
		const verifiedEntries: Array<{ name: string; stats: fs.Stats }> = [];
		try {
			for (const name of names) {
				const verified = await verifyBlobEntry(path.join(directory, name), hash, remainingBytes);
				payloadBytes = Math.max(payloadBytes, verified.size);
				verifiedEntries.push({ name, stats: verified.stats });
			}
		} catch (error) {
			logger.warn("Skipped unsafe blob during garbage collection", {
				hash,
				error: error instanceof Error ? error.message : String(error),
			});
			state.pendingGroups.shift();
			continue;
		}
		if (!isSnapshotCurrent() || (options.protectRecentPublications && recent.has(hash))) {
			hasMore = true;
			break;
		}
		try {
			assertSweepDirectoryCurrent(directory, state);
		} catch (error) {
			await resetBlobSweepState(state);
			throw error;
		}
		try {
			// Final path identity check + unlink are one synchronous section: a
			// process-local putSync cannot interleave after verification.
			for (const verified of verifiedEntries.sort(
				(left, right) => Number(left.name === hash) - Number(right.name === hash),
			)) {
				const filePath = path.join(directory, verified.name);
				const current = fs.lstatSync(filePath);
				if (current.isSymbolicLink() || !current.isFile()) {
					throw pathError("Blob entry changed before collection unlink", filePath);
				}
				assertSameFileIdentity(verified.stats, current, filePath);
				fs.unlinkSync(filePath);
			}
			deletedBlobs += 1;
			deletedBytes += payloadBytes;
		} catch (error) {
			logger.warn("Blob garbage collection unlink failed", {
				hash,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		state.pendingGroups.shift();
	}
	state.needsContinuation = state.pendingGroups.length > 0 || state.directory !== undefined;
	if (!state.needsContinuation && state.restartAfterCycle) {
		state.restartAfterCycle = false;
		state.directoryIdentity = undefined;
		state.needsContinuation = true;
	}
	if (state.needsContinuation) hasMore = true;
	else state.directoryIdentity = undefined;
	return { deletedBlobs, deletedBytes, hasMore, liveBlobs: live.size, scannedBlobs };
}

export function blobExtensionForImageMimeType(mimeType: string | undefined): string | undefined {
	if (!mimeType) return undefined;
	const lower = mimeType.toLowerCase();
	const known = IMAGE_EXTENSION_BY_MIME[lower];
	if (known) return known;
	if (!lower.startsWith("image/")) return undefined;
	const subtype = lower.slice("image/".length).split(";")[0]?.split("+")[0];
	return normalizeBlobExtension(subtype);
}

export class BlobStore {
	readonly #coordinator: BlobStoreCoordinator;
	#publicationCapture: Array<{ hash: string; lease: symbol }> | undefined;

	constructor(readonly dir: string) {
		this.#coordinator = coordinatorFor(dir);
	}

	/** Capture publication leases created synchronously by one persistence serialization. */
	capturePublications<T>(serialize: () => T): BlobPublicationCapture<T> {
		if (this.#publicationCapture) throw new Error("Nested blob publication capture is not supported");
		const publications: Array<{ hash: string; lease: symbol }> = [];
		this.#publicationCapture = publications;
		let value: T;
		try {
			value = serialize();
		} catch (error) {
			for (const publication of publications) {
				releaseRecentPublication(this.#coordinator, publication.hash, publication.lease);
			}
			throw error;
		} finally {
			this.#publicationCapture = undefined;
		}
		let settled = false;
		const settle = (durable: boolean): void => {
			if (settled) return;
			settled = true;
			for (const publication of publications) {
				releaseRecentPublication(this.#coordinator, publication.hash, publication.lease);
			}
			if (durable) this.#coordinator.durableReferenceEpoch += 1;
		};
		return { abandon: () => settle(false), commit: () => settle(true), value };
	}

	/**
	 * Write binary data to the blob store.
	 * @returns SHA-256 hex hash of the data
	 */
	async put(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		// The async path crosses filesystem awaits before publication. Snapshot the
		// caller-owned Buffer so its digest and published bytes cannot diverge if
		// the caller reuses or mutates that buffer meanwhile.
		const stableData = Buffer.from(data);
		const hash = new Bun.SHA256().update(stableData).digest("hex");
		const publicationLease =
			options?.protectUntilDurable === false ? undefined : noteRecentPublication(this.#coordinator, hash);
		if (publicationLease) this.#publicationCapture?.push({ hash, lease: publicationLease });
		const blobPath = path.join(this.dir, hash);
		const extension = normalizeBlobExtension(options?.extension);
		const displayPath = extension ? `${blobPath}.${extension}` : blobPath;
		let publicationReleased = false;
		const settlePublication = (durable: boolean): void => {
			if (publicationReleased) return;
			publicationReleased = true;
			if (publicationLease) releaseRecentPublication(this.#coordinator, hash, publicationLease);
			if (durable) this.#coordinator.durableReferenceEpoch += 1;
		};
		const result = {
			hash,
			path: blobPath,
			displayPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
			commitPublication: () => settlePublication(true),
			releasePublication: () => settlePublication(false),
		};

		try {
			await ensurePrivateDirectory(this.dir);
			await publishRegularFile(blobPath, stableData);
			await ensureDisplayPath(blobPath, displayPath, stableData);
			noteBlobDirectoryMutation(this.#coordinator);
			return result;
		} catch (error) {
			result.releasePublication();
			throw error;
		}
	}

	/**
	 * Synchronous variant of {@link put}. Use on persistence hot paths where the caller
	 * cannot afford the microtask hops of the async version (e.g. OOM-safe session writes).
	 * Returns once the bytes are in the kernel page cache.
	 */
	putSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const publicationLease =
			options?.protectUntilDurable === false ? undefined : noteRecentPublication(this.#coordinator, hash);
		if (publicationLease) this.#publicationCapture?.push({ hash, lease: publicationLease });
		const blobPath = path.join(this.dir, hash);
		const extension = normalizeBlobExtension(options?.extension);
		const displayPath = extension ? `${blobPath}.${extension}` : blobPath;
		let publicationReleased = false;
		const settlePublication = (durable: boolean): void => {
			if (publicationReleased) return;
			publicationReleased = true;
			if (publicationLease) releaseRecentPublication(this.#coordinator, hash, publicationLease);
			if (durable) this.#coordinator.durableReferenceEpoch += 1;
		};
		const result = {
			hash,
			path: blobPath,
			displayPath,
			get ref() {
				return `${BLOB_PREFIX}${hash}`;
			},
			commitPublication: () => settlePublication(true),
			releasePublication: () => settlePublication(false),
		};
		try {
			ensurePrivateDirectorySync(this.dir);
			publishRegularFileSync(blobPath, data);
			ensureDisplayPathSync(blobPath, displayPath, data);
			noteBlobDirectoryMutation(this.#coordinator);
			return result;
		} catch (error) {
			result.releasePublication();
			throw error;
		}
	}

	/** Read blob by hash, returns Buffer or null if not found. */
	async get(hash: string): Promise<Buffer | null> {
		if (!BLOB_HASH_RE.test(hash)) return null;
		const blobPath = path.join(this.dir, hash);
		try {
			await validateStoreDirectory(this.dir, false);
			const data = await readRegularFile(blobPath);
			if (new Bun.SHA256().update(data).digest("hex") !== hash) {
				throw pathError("Blob contents do not match their digest", blobPath);
			}
			return data;
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	/** Synchronous variant of {@link get}. */
	getSync(hash: string): Buffer | null {
		if (!BLOB_HASH_RE.test(hash)) return null;
		const blobPath = path.join(this.dir, hash);
		try {
			validateStoreDirectorySync(this.dir, false);
			const data = readRegularFileSync(blobPath);
			if (new Bun.SHA256().update(data).digest("hex") !== hash) {
				throw pathError("Blob contents do not match their digest", blobPath);
			}
			return data;
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	/** Check if a blob exists. */
	async has(hash: string): Promise<boolean> {
		return (await this.get(hash)) !== null;
	}

	/** Register another durable root sharing this process-local CAS. */
	registerSessionRoot(root: string): void {
		this.#coordinator.sessionRoots.add(path.resolve(root));
	}

	/**
	 * Notify the collector that a durable journal mutation landed. Publication
	 * leases are deliberately not matched by hash here: only the exact
	 * BlobPutResult/capture that produced the durable bytes may release its token.
	 */
	noteDurableReferences(serializedJsonl: string): void {
		const referenced = serializedBlobReferenceCounts(serializedJsonl);
		if (referenced.size === 0) return;
		this.#coordinator.durableReferenceEpoch += 1;
	}

	/**
	 * Reference-aware, bounded mark-and-sweep over all supplied durable session
	 * roots. Concurrent collectors serialize per CAS; fresh publications remain
	 * protected until their journal write is confirmed or an explicit maintenance
	 * pass opts out of that lifecycle guard.
	 */
	async collectGarbage(options: BlobGarbageCollectionOptions): Promise<BlobGarbageCollectionResult> {
		if (options.sessionRoots.length === 0) throw new Error("Blob garbage collection requires session roots");
		const maxDeletes = options.maxDeletes ?? DEFAULT_GC_MAX_DELETES;
		const maxBytes = options.maxBytes ?? DEFAULT_GC_MAX_BYTES;
		const maxBlobEntries = options.maxBlobEntries ?? DEFAULT_GC_MAX_BLOB_ENTRIES;
		const maxBlobSidecars = options.maxBlobSidecars ?? DEFAULT_GC_MAX_BLOB_SIDECARS;
		const maxHashedBytes = options.maxHashedBytes ?? DEFAULT_GC_MAX_HASHED_BYTES;
		const scanLimits = {
			maxFilesystemEntries: options.maxFilesystemEntries ?? DEFAULT_GC_MAX_FILESYSTEM_ENTRIES,
			maxSessionBytes: options.maxSessionBytes ?? DEFAULT_GC_MAX_SESSION_BYTES,
			maxSessionEntries: options.maxSessionEntries ?? DEFAULT_GC_MAX_SESSION_ENTRIES,
			maxSessionFiles: options.maxSessionFiles ?? DEFAULT_GC_MAX_SESSION_FILES,
			maxSessionLineBytes: options.maxSessionLineBytes ?? DEFAULT_GC_MAX_SESSION_LINE_BYTES,
		};
		if (!Number.isSafeInteger(maxDeletes) || maxDeletes <= 0)
			throw new Error("maxDeletes must be a positive integer");
		if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer");
		if (!Number.isSafeInteger(maxBlobEntries) || maxBlobEntries <= 0)
			throw new Error("maxBlobEntries must be a positive integer");
		if (!Number.isSafeInteger(maxBlobSidecars) || maxBlobSidecars < 0)
			throw new Error("maxBlobSidecars must be a non-negative integer");
		if (!Number.isSafeInteger(maxHashedBytes) || maxHashedBytes <= 0)
			throw new Error("maxHashedBytes must be a positive integer");
		for (const [name, value] of Object.entries(scanLimits)) {
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
		}

		const predecessor = this.#coordinator.gcTail;
		const turn = Promise.withResolvers<void>();
		this.#coordinator.gcTail = predecessor.catch(() => undefined).then(() => turn.promise);
		await predecessor.catch(() => undefined);
		try {
			const protectRecentPublications = options.protectRecentPublications ?? true;
			const sessionRoots = [...new Set([...options.sessionRoots, ...this.#coordinator.sessionRoots])];
			let epoch = this.#coordinator.durableReferenceEpoch;
			let live = await collectLiveBlobReferences(sessionRoots, this.dir, scanLimits);
			if (this.#coordinator.durableReferenceEpoch !== epoch) {
				epoch = this.#coordinator.durableReferenceEpoch;
				live = await collectLiveBlobReferences(sessionRoots, this.dir, scanLimits);
			}
			// A continuously mutating session set is not a safe sweep snapshot. Keep
			// every blob and let the next bounded lifecycle pass retry.
			if (this.#coordinator.durableReferenceEpoch !== epoch) {
				return { deletedBlobs: 0, deletedBytes: 0, hasMore: true, liveBlobs: live.size, scannedBlobs: 0 };
			}
			const result = await sweepOrphanBlobs(
				this.dir,
				live,
				this.#coordinator.recentPublications,
				this.#coordinator.sweepState,
				{
					maxBlobEntries,
					maxBlobSidecars,
					maxBytes,
					maxDeletes,
					maxHashedBytes,
					protectRecentPublications,
				},
				() => this.#coordinator.durableReferenceEpoch === epoch,
			);
			if (!protectRecentPublications) {
				this.#coordinator.recentPublications.clear();
				this.#coordinator.recentPublicationLeaseCount = 0;
			}
			return result;
		} finally {
			turn.resolve();
		}
	}

	/**
	 * Coalesce lifecycle-triggered maintenance into one running pass and at most
	 * one pending rerun. The first pass starts on a macrotask so rollback/delete
	 * RPCs never wait for a full durable-session scan.
	 */
	scheduleGarbageCollection(options: BlobGarbageCollectionOptions): void {
		const coordinator = this.#coordinator;
		coordinator.lifecycleTask = async () => {
			try {
				await this.collectGarbage(options);
				if (coordinator.sweepState.needsContinuation) coordinator.lifecycleRerun = true;
			} catch (error) {
				logger.warn("Deferred blob garbage collection after session lifecycle change", {
					directory: this.dir,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		if (coordinator.lifecycleRunning) {
			coordinator.lifecycleRerun = true;
			return;
		}
		if (coordinator.lifecycleScheduled) return;
		if (!coordinator.lifecycleResolve) {
			const idle = Promise.withResolvers<void>();
			coordinator.lifecycleIdle = idle.promise;
			coordinator.lifecycleResolve = idle.resolve;
		}
		coordinator.lifecycleScheduled = true;
		const timer = setTimeout(() => void this.#runScheduledGarbageCollection(), 0);
		timer.unref?.();
	}

	async #runScheduledGarbageCollection(): Promise<void> {
		const coordinator = this.#coordinator;
		coordinator.lifecycleScheduled = false;
		coordinator.lifecycleRunning = true;
		const task = coordinator.lifecycleTask;
		try {
			await task?.();
		} finally {
			coordinator.lifecycleRunning = false;
			if (coordinator.lifecycleRerun) {
				coordinator.lifecycleRerun = false;
				coordinator.lifecycleScheduled = true;
				const timer = setTimeout(() => void this.#runScheduledGarbageCollection(), 0);
				timer.unref?.();
			} else {
				coordinator.lifecycleTask = undefined;
				const resolve = coordinator.lifecycleResolve;
				coordinator.lifecycleResolve = undefined;
				resolve?.();
			}
		}
	}

	/** Wait until all coalesced lifecycle maintenance for this CAS is idle. */
	async drainScheduledGarbageCollection(): Promise<void> {
		await this.#coordinator.lifecycleIdle;
	}
}

/** Check if a data string is a blob reference. */
export function isBlobRef(data: string): boolean {
	return data.startsWith(BLOB_PREFIX);
}

/**
 * Extract the SHA-256 hash from a blob reference string.
 *
 * Returns null when the string is not a blob ref, or when the suffix is not a
 * canonical 64-char lowercase hex hash. Rejecting non-hash suffixes here is the
 * single choke point that keeps every resolution path confined to the blob dir:
 * `get`/`getSync` feed this value into `path.join(this.dir, hash)`, so an
 * unvalidated `../` suffix would otherwise escape the store and read arbitrary files.
 */
export function parseBlobRef(data: string): string | null {
	if (!data.startsWith(BLOB_PREFIX)) return null;
	const hash = data.slice(BLOB_PREFIX.length);
	if (!BLOB_HASH_RE.test(hash)) {
		logger.warn("Rejected malformed blob reference", { suffix: hash });
		return null;
	}
	return hash;
}

/** Identify provider transport image data URLs so persistence can externalize and restore them losslessly. */
export function isImageDataUrl(data: string): boolean {
	return data.startsWith("data:image/") && data.includes(";base64,");
}

/**
 * Externalize a provider image data URL to the blob store, returning a blob reference.
 * The full data URL string is preserved so transport-native history can be reconstructed on resume.
 */
export async function externalizeImageDataUrl(blobStore: BlobStore, dataUrl: string): Promise<string> {
	if (isBlobRef(dataUrl)) return dataUrl;
	const { ref } = await blobStore.put(Buffer.from(dataUrl, "utf8"));
	return ref;
}

/** Synchronous variant of {@link externalizeImageDataUrl}. */
export function externalizeImageDataUrlSync(blobStore: BlobStore, dataUrl: string): string {
	if (isBlobRef(dataUrl)) return dataUrl;
	return blobStore.putSync(Buffer.from(dataUrl, "utf8")).ref;
}

/**
 * Externalize an image's base64 data to the blob store, returning a blob reference.
 * If the data is already a blob reference, returns it unchanged.
 */
export async function externalizeImageData(
	blobStore: BlobStore,
	base64Data: string,
	mimeType?: string,
): Promise<string> {
	if (isBlobRef(base64Data)) return base64Data;
	const buffer = Buffer.from(base64Data, "base64");
	const { ref } = await blobStore.put(buffer, {
		extension: blobExtensionForImageMimeType(mimeType),
	});
	return ref;
}

/** Synchronous variant of {@link externalizeImageData}. */
export function externalizeImageDataSync(blobStore: BlobStore, base64Data: string, mimeType?: string): string {
	if (isBlobRef(base64Data)) return base64Data;
	return blobStore.putSync(Buffer.from(base64Data, "base64"), {
		extension: blobExtensionForImageMimeType(mimeType),
	}).ref;
}

/**
 * Resolve an externalized provider image data URL back to its original string.
 * If the data is not a blob reference, returns it unchanged.
 * If the blob is missing, logs a warning and returns the reference as-is.
 */
export async function resolveImageDataUrl(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted image data URL", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

/**
 * Resolve a blob reference back to base64 data.
 * If the data is not a blob reference, returns it unchanged.
 * If the blob is missing, logs a warning and returns a placeholder.
 */
export async function resolveImageData(blobStore: BlobStore, data: string): Promise<string> {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = await blobStore.get(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data; // Return the ref as-is; downstream will see invalid base64 but won't crash
	}
	return buffer.toString("base64");
}

/** Synchronous variant of {@link resolveImageData}. */
export function resolveImageDataSync(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		logger.warn("Blob not found for image reference", { hash });
		return data;
	}
	return buffer.toString("base64");
}
