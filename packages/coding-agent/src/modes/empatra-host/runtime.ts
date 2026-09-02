import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import { type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Effort, ImageContent, Model } from "@oh-my-pi/pi-ai";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import type { Skill } from "../../extensibility/skills";
import type { PlanApprovalDetails } from "../../plan-mode/approved-plan";
import { readPlanFile } from "../../plan-mode/plan-files";
import type { PlanModeState } from "../../plan-mode/state";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import { BlobStore } from "../../session/blob-store";
import type { SessionEntry } from "../../session/session-entries";
import type { SessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import type { PlanProposalHandler } from "../../tools/resolve";
import {
	digestEmpatraHostAtomicInput,
	digestEmpatraHostText,
	type EmpatraHostAtomicOperation,
	EmpatraHostAtomicOperationStore,
} from "./atomic-operation-store";
import { EmpatraHostProtocolError } from "./errors";
import { clearPersistedThreadGoal, getPersistedThreadGoal, setPersistedThreadGoal } from "./goal-store";
import {
	type EmpatraHostSessionTools,
	type EmpatraHostToolScope,
	EmpatraHostToolsConnection,
	validateEmpatraHostToolCatalog,
} from "./host-tools";
import {
	createEmpatraHostInteractionUIContext,
	EmpatraHostInteractionBroker,
	type EmpatraHostInteractionRequest,
	type EmpatraHostInteractionResolution,
} from "./interaction-broker";
import {
	digestEmpatraHostImageDescriptors,
	type EmpatraHostPreparedImages,
	prepareEmpatraHostImages,
} from "./media-input";
import type {
	EmpatraHostApprovalMode,
	EmpatraHostAtomicOperationStatusResponse,
	EmpatraHostCommand,
	EmpatraHostEvent,
	EmpatraHostExtensionDescriptor,
	EmpatraHostGoalClearCommand,
	EmpatraHostGoalGetCommand,
	EmpatraHostGoalSetCommand,
	EmpatraHostImageDescriptor,
	EmpatraHostInitializeCommand,
	EmpatraHostMode,
	EmpatraHostModel,
	EmpatraHostPlanResolutionCommand,
	EmpatraHostReasoningEffort,
	EmpatraHostThreadCreateAndStartCommand,
	EmpatraHostThreadCreateCommand,
	EmpatraHostThreadForkAndStartCommand,
	EmpatraHostThreadForkCommand,
	EmpatraHostToolCancelFrame,
	EmpatraHostToolDefinition,
	EmpatraHostToolExecutionStartPayload,
	EmpatraHostToolOutboundFrame,
	EmpatraHostToolResultFrame,
	EmpatraHostToolsReplaceCommand,
	EmpatraHostTurnStatus,
	EmpatraHostTurnSummary,
} from "./protocol";
import {
	EMPATRA_HOST_CAPABILITIES,
	EMPATRA_HOST_MAX_ASSISTANT_MESSAGES_PER_TURN,
	EMPATRA_HOST_MAX_CONTENT_INDEX,
	EMPATRA_HOST_MAX_PLAN_CONTENT_BYTES,
	EMPATRA_HOST_THREAD_READ_TARGET_BYTES,
	projectEmpatraHostFailure,
} from "./protocol";
import type { EmpatraHostRuntime } from "./server";
import {
	EMPATRA_HOST_SUBAGENT_CAPABILITY,
	EmpatraHostSubagentController,
	type EmpatraHostSubagentCloseCommand,
	type EmpatraHostSubagentInterruptCommand,
	type EmpatraHostSubagentListCommand,
	type EmpatraHostSubagentScope,
	type EmpatraHostSubagentRunner,
	type EmpatraHostSubagentResponseCommand,
	type EmpatraHostSubagentRpcTransport,
	type EmpatraHostSubagentSpawnCommand,
	type EmpatraHostSubagentSteerCommand,
} from "./subagent-broker";
import { type EmpatraHostThreadMetadata, EmpatraHostThreadMetadataStore } from "./thread-metadata-store";
import { type EmpatraHostProjectedMessage, projectThreadMessages } from "./thread-projection";
import { EmpatraHostThreadRegistry } from "./thread-registry";
import { rollbackEmpatraHostThread } from "./thread-rollback";
import {
	EMPATRA_HOST_TOOL_ENTRY,
	EMPATRA_HOST_TOOL_ENTRY_VERSION,
	type EmpatraHostPersistedToolEvent,
	parseEmpatraHostPersistedToolEvent,
	projectEmpatraHostToolEvent,
} from "./tool-projection";
import {
	EMPATRA_TURN_ENTRY,
	EMPATRA_TURN_ENTRY_VERSION,
	type EmpatraHostPersistedTurnMarker,
	parseEmpatraHostTurnMarker,
} from "./turn-marker";
import {
	type EmpatraHostUsageObservation,
	hasTrustworthyEmpatraHostAssistantUsage,
	observeEmpatraHostAssistantUsage,
	projectEmpatraHostContextUsage,
} from "./usage-projection";
import {
	EMPATRA_HOST_USER_MEDIA_CANCEL_ENTRY,
	EMPATRA_HOST_USER_MEDIA_ENTRY,
	EMPATRA_HOST_USER_MEDIA_ENTRY_VERSION,
	type EmpatraHostPersistedUserMedia,
	type EmpatraHostPersistedUserMediaCancellation,
	hasEmpatraHostUserMediaMarker,
} from "./user-media-projection";
import { EmpatraHostWorkspacePolicy } from "./workspace-policy";

const EMPATRA_THREAD_CONFIG_ENTRY = "empatra.host.thread-config.v1";
const EMPATRA_THREAD_CONFIG_VERSION = 1 as const;
const DEFAULT_APPROVAL_MODE: EmpatraHostApprovalMode = "always-ask";
const EMPATRA_THREAD_LIFECYCLE_ENTRY = "empatra.host.thread-lifecycle.v1";
const EMPATRA_THREAD_LIFECYCLE_VERSION = 1 as const;
const MAX_STREAM_EVENT_BYTES = 64 * 1024;
const MAX_PLAN_PROPOSAL_EVENT_BYTES = EMPATRA_HOST_MAX_PLAN_CONTENT_BYTES + 16 * 1024;
const MAX_QUEUED_EVENT_BYTES = 4 * 1024 * 1024;
const eventEncoder = new TextEncoder();

type ThreadListCommand = Extract<EmpatraHostCommand, { type: "thread_list" }>;
type ThreadCompactCommand = Extract<EmpatraHostCommand, { type: "thread_compact" }>;
type ThreadReadCommand = Extract<EmpatraHostCommand, { type: "thread_read" }>;
type ThreadRenameCommand = Extract<EmpatraHostCommand, { type: "thread_rename" }>;
type ThreadRollbackCommand = Extract<EmpatraHostCommand, { type: "thread_rollback" }>;
type ThreadTurnsCommand = Extract<EmpatraHostCommand, { type: "thread_turns" }>;
type ThreadStateCommand = Extract<EmpatraHostCommand, { type: "thread_archive" | "thread_unarchive" }>;
type ThreadDeleteCommand = Extract<EmpatraHostCommand, { type: "thread_delete" }>;
type InteractionActivityCommand = Extract<EmpatraHostCommand, { type: "interaction_activity" }>;
type InteractionCancelCommand = Extract<EmpatraHostCommand, { type: "interaction_cancel" }>;
type InteractionRespondCommand = Extract<EmpatraHostCommand, { type: "interaction_respond" }>;
type TurnInterruptCommand = Extract<EmpatraHostCommand, { type: "turn_interrupt" }>;
type TurnStartCommand = Extract<EmpatraHostCommand, { type: "turn_start" }>;
type TurnSteerCommand = Extract<EmpatraHostCommand, { type: "turn_steer" }>;

interface PersistedThreadConfig {
	approvalMode?: EmpatraHostApprovalMode;
	mode?: EmpatraHostMode;
	modelId: string;
	operationId: string;
	systemPrompt: string;
	version: typeof EMPATRA_THREAD_CONFIG_VERSION;
}

interface PersistedThreadLifecycle {
	archived: boolean;
	version: typeof EMPATRA_THREAD_LIFECYCLE_VERSION;
}

interface TurnCursor {
	anchor: string | null;
	offset: number;
	sortDirection: "asc" | "desc";
	threadId: string;
	turnCount: number;
	v: 1;
}

interface LegacyThreadReadCursor {
	generation: number;
	leafId: string | null;
	messageCount: number;
	offset: number;
	threadId: string;
	v: 1;
}

interface TurnAlignedThreadReadCursor {
	generation: number;
	leafId: string | null;
	order: "desc";
	snapshotRevision: string;
	threadId: string;
	turnCount: number;
	turnOffset: number;
	v: 2;
}

type ThreadReadCursor = LegacyThreadReadCursor | TurnAlignedThreadReadCursor;

interface TurnAlignedThreadReadProjection {
	readonly bytes: number;
	readonly messagesByTurn: ReadonlyMap<string, readonly EmpatraHostProjectedMessage[]>;
	readonly turns: readonly EmpatraHostTurnSummary[];
}

const MAX_THREAD_READ_PROJECTION_CACHE_ENTRIES = 8;
const MAX_THREAD_READ_PROJECTION_CACHE_BYTES = 32 * 1024 * 1024;

function createThreadSnapshotRevision(generation: number, leafId: string | null): string {
	return digestEmpatraHostText(JSON.stringify([generation, leafId]));
}

function planProposalDigest(planText: string): string {
	return `sha256:${digestEmpatraHostText(planText)}`;
}

function planDetails(value: unknown): PlanApprovalDetails {
	if (
		!value ||
		typeof value !== "object" ||
		!("planFilePath" in value) ||
		!("title" in value) ||
		!("planExists" in value) ||
		typeof value.planFilePath !== "string" ||
		typeof value.title !== "string" ||
		value.planExists !== true
	) {
		throw new EmpatraHostProtocolError("plan_not_supported", "OMP returned an invalid plan proposal");
	}
	return {
		planExists: true,
		planFilePath: value.planFilePath,
		title: value.title,
	};
}

export interface EmpatraHostSession {
	abort(options?: { goalReason?: "interrupted" | "internal"; reason?: string }): Promise<void>;
	compact(customInstructions?: string): Promise<unknown>;
	dispose(): Promise<void>;
	getAllToolNames?(): string[];
	prompt(message: string, options?: { images?: ImageContent[] }): Promise<unknown>;
	preparePlanForReview?(title: string): Promise<{ details?: PlanApprovalDetails }>;
	readPlanFile?(planFilePath: string): Promise<string | null>;
	refreshRpcHostTools?(rpcTools: AgentTool[]): Promise<void>;
	getPlanModeState?(): PlanModeState | undefined;
	setPlanModeState?(state: PlanModeState | undefined): void;
	setPlanProposalHandler?(handler: PlanProposalHandler | null): void;
	setPlanReferencePath?(planFilePath: string): void;
	setBaseSystemPrompt?(prompt: string[]): void;
	setModelTemporary?(
		model: Model<"openai-responses">,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void>;
	steer(message: string, images?: ImageContent[]): Promise<void>;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	setThinkingLevel?(level: ThinkingLevel): void;
	setToolUIContext?(uiContext: ExtensionUIContext, hasUI: boolean): void;
}

export interface EmpatraHostSessionFactoryOptions {
	agentDir: string;
	capability: string;
	cwd: string;
	extensionPaths: readonly string[];
	model: Model<"openai-responses">;
	modelRegistry: ModelRegistry;
	scopedModels: readonly Model<"openai-responses">[];
	skills: readonly Skill[];
	sessionManager: SessionManager;
	settings: Settings;
	systemPrompt: string;
}

export type EmpatraHostSessionFactory = (options: EmpatraHostSessionFactoryOptions) => Promise<EmpatraHostSession>;

interface InitializedRuntime {
	agentDir: string;
	atomicOperationStore: EmpatraHostAtomicOperationStore;
	authStorage: AuthStorage;
	blobDirectory: string;
	blobGarbageCollectionAuthority: Database;
	capability: string;
	extensionDescriptors: readonly EmpatraHostExtensionDescriptor[];
	extensionPaths: readonly string[];
	modelRegistry: ModelRegistry;
	metadataStore: EmpatraHostThreadMetadataStore;
	modelDefinitions: ReadonlyMap<string, EmpatraHostModel>;
	models: ReadonlyMap<string, Model<"openai-responses">>;
	skills: readonly Skill[];
	policy: EmpatraHostWorkspacePolicy;
	sessionDirectory: string;
}

function isInsideDirectory(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveMaterializedSkills(
	entries: readonly NonNullable<EmpatraHostInitializeCommand["skills"]>[number][],
	sessionDirectory: string,
): Promise<readonly Skill[]> {
	return await Promise.all(
		entries.map(async entry => {
			let filePath: string;
			let baseDir: string;
			try {
				[filePath, baseDir] = await Promise.all([realpath(entry.filePath), realpath(entry.baseDir)]);
				const [fileInfo, directoryInfo] = await Promise.all([lstat(filePath), lstat(baseDir)]);
				if (!fileInfo.isFile() || !directoryInfo.isDirectory() || !isInsideDirectory(baseDir, filePath)) {
					throw new Error("skill snapshot has invalid filesystem entries");
				}
			} catch {
				throw new EmpatraHostProtocolError("invalid_request", "skill snapshot is unavailable");
			}
			if (!isInsideDirectory(sessionDirectory, baseDir) || !isInsideDirectory(sessionDirectory, filePath)) {
				throw new EmpatraHostProtocolError("invalid_request", "skill snapshot escapes private session storage");
			}
			return {
				baseDir,
				description: entry.description,
				filePath,
				...(entry.hide === undefined ? {} : { hide: entry.hide }),
				name: entry.name,
				source: entry.source,
			};
		}),
	);
}

/**
 * Validate main-owned extension modules before any session is created. OMP
 * never discovers extensions in user/project roots for an Empatra host: only
 * regular files under the private session directory, bound to the digest sent
 * by Electron main, can enter the explicit lifecycle lane.
 */
async function resolveMaterializedExtensions(
	entries: readonly NonNullable<EmpatraHostInitializeCommand["extensions"]>[number][],
	sessionDirectory: string,
): Promise<readonly string[]> {
	const seenPaths = new Set<string>();
	const seenIds = new Set<string>();
	const resolved: string[] = [];
	for (const entry of entries) {
		if (seenIds.has(entry.id)) {
			throw new EmpatraHostProtocolError("invalid_request", "extension ids must be unique");
		}
		seenIds.add(entry.id);
		let filePath: string;
		try {
			filePath = await realpath(entry.filePath);
			const fileInfo = await lstat(filePath);
			if (!fileInfo.isFile() || !isInsideDirectory(sessionDirectory, filePath)) {
				throw new Error("extension module has invalid filesystem entries");
			}
			const digest = createHash("sha256")
				.update(await readFile(filePath))
				.digest("hex");
			if (digest !== entry.sha256) throw new Error("extension module digest mismatch");
		} catch {
			throw new EmpatraHostProtocolError("invalid_request", "extension module is unavailable or invalid");
		}
		if (seenPaths.has(filePath)) {
			throw new EmpatraHostProtocolError("invalid_request", "extension module paths must be unique");
		}
		seenPaths.add(filePath);
		resolved.push(filePath);
	}
	return resolved;
}

async function createPrivateBlobDirectory(sessionDirectory: string): Promise<string> {
	const candidate = path.join(sessionDirectory, "blobs");
	try {
		const existing = await lstat(candidate);
		if (existing.isSymbolicLink()) {
			throw new EmpatraHostProtocolError("runtime_error", "Empatra host blob directory must not be a symlink");
		}
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
	}
	await mkdir(candidate, { mode: 0o700, recursive: true });
	const canonical = await realpath(candidate);
	if (!isInsideDirectory(sessionDirectory, canonical)) {
		throw new EmpatraHostProtocolError("runtime_error", "Empatra host blob directory escapes session storage");
	}
	if (process.platform !== "win32") await chmod(canonical, 0o700);
	return canonical;
}

function acquireBlobGarbageCollectionAuthority(agentDir: string): Database {
	const lockPath = path.join(agentDir, "empatra-host-blob-gc-authority.sqlite3");
	const database = new Database(lockPath);
	try {
		database.exec("PRAGMA busy_timeout = 0");
		database.exec("PRAGMA journal_mode = DELETE");
		database.exec(
			"CREATE TABLE IF NOT EXISTS blob_gc_authority (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL)",
		);
		database.exec("INSERT OR IGNORE INTO blob_gc_authority (id, generation) VALUES (1, 0)");
		database.exec("BEGIN EXCLUSIVE");
		database.exec("UPDATE blob_gc_authority SET generation = generation + 1 WHERE id = 1");
		return database;
	} catch {
		database.close();
		throw new EmpatraHostProtocolError(
			"runtime_error",
			"Empatra host session storage is already owned by another local runtime",
		);
	}
}

interface ThreadHandle {
	defaultApprovalMode: EmpatraHostApprovalMode;
	activeTurn: {
		approvalMode: EmpatraHostApprovalMode;
		acceptingEvents: boolean;
		acceptingSteer: boolean;
		activeAssistantMessageIndex: number | null;
		activeReasoningContentIndexes: Map<number, number>;
		assistantMessageCount: number;
		atomicOperation?: Readonly<{ inputSha256: string; operationId: string }>;
		catalogRevision: string | null;
		generation: number;
		imageAdmissions: EmpatraHostPreparedImages[];
		openTools: Map<
			string,
			Readonly<{
				outputText: string;
				startPayload: EmpatraHostToolExecutionStartPayload;
			}>
		>;
		sequence: number;
		toolFailure?: Error;
		turnId: string;
		usageBaseLeafId: string;
		usageObservations: EmpatraHostUsageObservation[];
		usageUpdateCount: number;
	} | null;
	dispose(): Promise<void>;
	eventTail: Promise<void>;
	queuedEventBytes: number;
	settings: Settings;
	session: EmpatraHostSession;
	sessionManager: SessionManager;
	hostTools: EmpatraHostSessionTools;
	model: Model<"openai-responses">;
	modelContextWindow: number;
	streamAbortStarted: boolean;
	streamFailure?: Error;
	threadId: string;
	unsubscribe: () => void;
}

interface PendingPlanResolution {
	digest: string;
	generation: number;
	reject: (error: Error) => void;
	resolve: (command: EmpatraHostPlanResolutionCommand) => void;
	requestId: string;
	threadId: string;
	turnId: string;
}

interface IndexedThread {
	metadata: EmpatraHostThreadMetadata;
	session: SessionInfo;
}

function utf8Chunks(value: string, maxBytes: number): string[] {
	if (eventEncoder.encode(value).byteLength <= maxBytes) return [value];
	const chunks: string[] = [];
	let bytes = 0;
	let start = 0;
	for (let index = 0; index < value.length;) {
		const codePoint = value.codePointAt(index) ?? 0;
		const codeUnits = codePoint > 0xffff ? 2 : 1;
		const codePointBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
		if (bytes + codePointBytes > maxBytes && index > start) {
			chunks.push(value.slice(start, index));
			start = index;
			bytes = 0;
		}
		bytes += codePointBytes;
		index += codeUnits;
	}
	if (start < value.length) chunks.push(value.slice(start));
	return chunks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistedThreadConfig(value: unknown): PersistedThreadConfig | undefined {
	if (
		!isRecord(value) ||
		value.version !== EMPATRA_THREAD_CONFIG_VERSION ||
		(value.approvalMode !== undefined && value.approvalMode !== "always-ask" && value.approvalMode !== "yolo") ||
		(value.mode !== undefined && value.mode !== "default" && value.mode !== "plan") ||
		typeof value.modelId !== "string" ||
		typeof value.operationId !== "string" ||
		typeof value.systemPrompt !== "string"
	) {
		return undefined;
	}
	return {
		...(value.approvalMode === undefined ? {} : { approvalMode: value.approvalMode }),
		...(value.mode === undefined ? {} : { mode: value.mode }),
		modelId: value.modelId,
		operationId: value.operationId,
		systemPrompt: value.systemPrompt,
		version: EMPATRA_THREAD_CONFIG_VERSION,
	};
}

function findThreadConfig(sessionManager: SessionManager): PersistedThreadConfig {
	for (const entry of sessionManager.getEntries().toReversed()) {
		if (entry.type !== "custom" || entry.customType !== EMPATRA_THREAD_CONFIG_ENTRY) continue;
		const config = parsePersistedThreadConfig(entry.data);
		if (config) return config;
	}
	throw new EmpatraHostProtocolError("thread_config_missing", "Thread is missing its Empatra host configuration");
}

function findThreadLifecycle(sessionManager: SessionManager): PersistedThreadLifecycle {
	for (const entry of sessionManager.getEntries().toReversed()) {
		if (entry.type !== "custom" || entry.customType !== EMPATRA_THREAD_LIFECYCLE_ENTRY || !isRecord(entry.data)) {
			continue;
		}
		if (entry.data.version === EMPATRA_THREAD_LIFECYCLE_VERSION && typeof entry.data.archived === "boolean") {
			return { archived: entry.data.archived, version: EMPATRA_THREAD_LIFECYCLE_VERSION };
		}
	}
	return { archived: false, version: EMPATRA_THREAD_LIFECYCLE_VERSION };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const expected = new Set(keys);
	return Object.keys(value).length === expected.size && Object.keys(value).every(key => expected.has(key));
}

function nonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function legacyTurnStatus(entry: Extract<SessionEntry, { type: "message" }> | undefined): EmpatraHostTurnStatus {
	if (entry?.message.role !== "assistant") return "interrupted";
	if (entry.message.stopReason === "aborted") return "interrupted";
	if (entry.message.stopReason === "error") return "failed";
	return "completed";
}

function projectLegacyTurns(entries: readonly SessionEntry[]): EmpatraHostTurnSummary[] {
	const turns: EmpatraHostTurnSummary[] = [];
	let current:
		| { id: string; itemCount: number; lastAssistant?: Extract<SessionEntry, { type: "message" }>; startedAt: number }
		| undefined;
	const finish = () => {
		if (!current) return;
		const completedAt =
			current.lastAssistant?.message.role === "assistant"
				? (current.lastAssistant.message.completedAt ?? current.lastAssistant.message.timestamp)
				: undefined;
		turns.push({
			...(completedAt === undefined
				? {}
				: { completedAt, durationMs: Math.max(0, completedAt - current.startedAt) }),
			id: current.id,
			itemCount: current.itemCount,
			startedAt: current.startedAt,
			status: legacyTurnStatus(current.lastAssistant),
		});
		current = undefined;
	};
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "user" && !entry.message.synthetic) {
			finish();
			current = { id: entry.id, itemCount: 0, startedAt: entry.message.timestamp };
		}
		if (!current) continue;
		current.itemCount += 1;
		if (entry.message.role === "assistant") current.lastAssistant = entry;
	}
	finish();
	return turns;
}

function projectThreadTurns(entries: readonly SessionEntry[], activeTurnId: string | null): EmpatraHostTurnSummary[] {
	const firstMarkerIndex = entries.findIndex(
		entry => entry.type === "custom" && entry.customType === EMPATRA_TURN_ENTRY,
	);
	if (firstMarkerIndex < 0) return projectLegacyTurns(entries);
	const turns = projectLegacyTurns(entries.slice(0, firstMarkerIndex));
	let current: { id: string; itemCount: number; startedAt: number } | undefined;
	for (const entry of entries.slice(firstMarkerIndex)) {
		const marker = parseEmpatraHostTurnMarker(entry);
		if (marker?.phase === "started") {
			if (current) {
				turns.push({
					id: current.id,
					itemCount: current.itemCount,
					startedAt: current.startedAt,
					status: "interrupted",
				});
			}
			current = { id: marker.turnId, itemCount: 0, startedAt: marker.startedAt };
			continue;
		}
		if (marker?.phase === "completed") {
			if (!current || current.id !== marker.turnId || marker.completedAt < current.startedAt) {
				throw new EmpatraHostProtocolError("turn_state_corrupt", "Turn completion has no matching start marker");
			}
			turns.push({
				completedAt: marker.completedAt,
				durationMs: marker.completedAt - current.startedAt,
				id: current.id,
				itemCount: current.itemCount,
				startedAt: current.startedAt,
				status: marker.outcome,
			});
			current = undefined;
			continue;
		}
		if (current && entry.type === "message") current.itemCount += 1;
	}
	if (current) {
		turns.push({
			id: current.id,
			itemCount: current.itemCount,
			startedAt: current.startedAt,
			status: activeTurnId === current.id ? "running" : "interrupted",
		});
	}
	return turns;
}

function buildTurnAlignedThreadReadProjection(
	entries: readonly SessionEntry[],
	activeTurnId: string | null,
): TurnAlignedThreadReadProjection {
	const messages = projectThreadMessages(entries);
	const turns = projectThreadTurns(entries, activeTurnId);
	const knownTurnIds = new Set(turns.map(turn => turn.id));
	const messagesByTurn = new Map<string, EmpatraHostProjectedMessage[]>();
	let bytes = eventEncoder.encode(JSON.stringify(turns)).byteLength;

	for (const message of messages) {
		if (!message.turnId || !knownTurnIds.has(message.turnId)) {
			throw new EmpatraHostProtocolError(
				"turn_state_corrupt",
				"Projected thread message does not belong to a durable turn",
			);
		}
		const page = messagesByTurn.get(message.turnId) ?? [];
		page.push(message);
		messagesByTurn.set(message.turnId, page);
		// This is deliberately an upper-bound estimate. It avoids retaining a
		// projection whose payload would make the bounded cache unbounded while
		// keeping the authoritative page path available as a safe fallback.
		bytes = Math.min(
			MAX_THREAD_READ_PROJECTION_CACHE_BYTES + 1,
			bytes + eventEncoder.encode(JSON.stringify(message)).byteLength,
		);
	}

	return { bytes, messagesByTurn, turns };
}

function persistedTurnPhase(
	manager: SessionManager,
	turnId: string,
): "completed" | "missing" | "started" | "uncertain" {
	let startedEntryId: string | undefined;
	let completed = false;
	for (const entry of manager.getBranch()) {
		const marker = parseEmpatraHostTurnMarker(entry);
		if (!marker || marker.turnId !== turnId) continue;
		if (marker.phase === "started") startedEntryId = entry.id;
		else completed = true;
	}
	if (completed) return "completed";
	if (!startedEntryId) return "missing";
	return manager.getLeafId() === startedEntryId ? "started" : "uncertain";
}

async function recoverInterruptedToolExecutions(manager: SessionManager): Promise<void> {
	const open = new Map<
		string,
		Readonly<{
			generation: number;
			payload: EmpatraHostToolExecutionStartPayload;
			sequence: number;
			turnId: string;
		}>
	>();
	const maxSequenceByTurn = new Map<string, number>();
	for (const entry of manager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== EMPATRA_HOST_TOOL_ENTRY) continue;
		const event = parseEmpatraHostPersistedToolEvent(entry.data);
		if (!event) throw new EmpatraHostProtocolError("turn_state_corrupt", "Persisted tool event is invalid");
		const key = `${event.turnId}\0${event.payload.toolCallId}`;
		maxSequenceByTurn.set(event.turnId, Math.max(maxSequenceByTurn.get(event.turnId) ?? 0, event.sequence));
		if (event.payload.phase === "start") {
			open.set(key, {
				generation: event.generation,
				payload: event.payload,
				sequence: event.sequence,
				turnId: event.turnId,
			});
		} else if (event.payload.phase === "end") {
			open.delete(key);
		}
	}
	if (open.size === 0) return;
	for (const tool of open.values()) {
		const sequence = (maxSequenceByTurn.get(tool.turnId) ?? tool.sequence) + 1;
		maxSequenceByTurn.set(tool.turnId, sequence);
		manager.appendCustomEntry(EMPATRA_HOST_TOOL_ENTRY, {
			generation: tool.generation,
			payload: {
				argumentsText: tool.payload.argumentsText,
				argumentsTruncated: tool.payload.argumentsTruncated,
				failed: true,
				phase: "end",
				resultText: "Tool execution was interrupted before completion",
				resultTruncated: false,
				toolCallId: tool.payload.toolCallId,
				toolName: tool.payload.toolName,
			},
			sequence,
			turnId: tool.turnId,
			version: EMPATRA_HOST_TOOL_ENTRY_VERSION,
		} satisfies EmpatraHostPersistedToolEvent);
	}
	await manager.flush();
}

function encodeTurnCursor(cursor: TurnCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeTurnCursor(encoded: string): TurnCursor {
	try {
		const bytes = Buffer.from(encoded, "base64url");
		if (bytes.toString("base64url") !== encoded) throw new Error("Non-canonical cursor");
		const value: unknown = JSON.parse(bytes.toString("utf8"));
		if (
			!isRecord(value) ||
			!hasExactKeys(value, ["anchor", "offset", "sortDirection", "threadId", "turnCount", "v"]) ||
			value.v !== 1 ||
			(value.anchor !== null && typeof value.anchor !== "string") ||
			!nonNegativeInteger(value.offset) ||
			(value.sortDirection !== "asc" && value.sortDirection !== "desc") ||
			typeof value.threadId !== "string" ||
			!nonNegativeInteger(value.turnCount)
		) {
			throw new Error("Invalid cursor payload");
		}
		return {
			anchor: value.anchor,
			offset: value.offset,
			sortDirection: value.sortDirection,
			threadId: value.threadId,
			turnCount: value.turnCount,
			v: 1,
		};
	} catch {
		throw new EmpatraHostProtocolError("invalid_cursor", "Thread turns cursor is invalid");
	}
}

function encodeThreadReadCursor(cursor: ThreadReadCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeThreadReadCursor(encoded: string): ThreadReadCursor {
	try {
		const bytes = Buffer.from(encoded, "base64url");
		if (bytes.toString("base64url") !== encoded) throw new Error("Non-canonical cursor");
		const value: unknown = JSON.parse(bytes.toString("utf8"));
		if (!isRecord(value) || typeof value.v !== "number") throw new Error("Invalid cursor payload");
		if (value.v === 1) {
			if (
				!hasExactKeys(value, ["generation", "leafId", "messageCount", "offset", "threadId", "v"]) ||
				!nonNegativeInteger(value.generation) ||
				(value.leafId !== null && typeof value.leafId !== "string") ||
				!nonNegativeInteger(value.messageCount) ||
				!nonNegativeInteger(value.offset) ||
				typeof value.threadId !== "string"
			) {
				throw new Error("Invalid cursor payload");
			}
			return {
				generation: value.generation,
				leafId: value.leafId,
				messageCount: value.messageCount,
				offset: value.offset,
				threadId: value.threadId,
				v: 1,
			};
		}
		if (
			value.v !== 2 ||
			!hasExactKeys(value, [
				"generation",
				"leafId",
				"order",
				"snapshotRevision",
				"threadId",
				"turnCount",
				"turnOffset",
				"v",
			]) ||
			!nonNegativeInteger(value.generation) ||
			(value.leafId !== null && typeof value.leafId !== "string") ||
			value.order !== "desc" ||
			typeof value.snapshotRevision !== "string" ||
			!/^[a-f0-9]{64}$/u.test(value.snapshotRevision) ||
			typeof value.threadId !== "string" ||
			!nonNegativeInteger(value.turnCount) ||
			!nonNegativeInteger(value.turnOffset)
		) {
			throw new Error("Invalid cursor payload");
		}
		return {
			generation: value.generation,
			leafId: value.leafId,
			order: "desc",
			snapshotRevision: value.snapshotRevision,
			threadId: value.threadId,
			turnCount: value.turnCount,
			turnOffset: value.turnOffset,
			v: 2,
		};
	} catch {
		throw new EmpatraHostProtocolError("invalid_cursor", "Thread read cursor is invalid");
	}
}

function toModel(model: EmpatraHostModel, gatewayBaseUrl: string): Model<"openai-responses"> {
	const nativeEfforts = (model.reasoningEfforts ?? []).filter(effort => effort !== "none") as Effort[];
	return buildModel({
		api: "openai-responses",
		baseUrl: gatewayBaseUrl,
		contextWindow: model.contextWindow,
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
		id: model.id,
		input: [...model.input],
		maxTokens: model.maxTokens,
		name: model.name,
		provider: "empatra-gateway",
		reasoning: model.reasoning,
		...(nativeEfforts.length > 0 ? { thinking: { mode: "effort" as const, efforts: nativeEfforts } } : {}),
		supportsTools: model.supportsTools,
	});
}

async function defaultSessionFactory(options: EmpatraHostSessionFactoryOptions): Promise<EmpatraHostSession> {
	const { createAgentSession } = await import("../../sdk");
	const { session, setToolUIContext } = await createAgentSession({
		agentDir: options.agentDir,
		allowRestrictedCustomTools: false,
		allowRestrictedExtensions: options.extensionPaths.length > 0,
		autoApprove: false,
		contextFiles: [],
		cwd: options.cwd,
		disableExtensionDiscovery: true,
		enableIrc: false,
		enableLsp: false,
		enableMCP: false,
		extensions: [],
		preloadedExtensionPaths: [...options.extensionPaths],
		getApiKey: async requestedModel => {
			if (
				requestedModel.provider !== options.model.provider ||
				requestedModel.baseUrl !== options.model.baseUrl ||
				!options.scopedModels.some(model => model.id === requestedModel.id)
			) {
				throw new EmpatraHostProtocolError("model_denied", "Model is outside the injected Empatra catalog");
			}
			return options.capability;
		},
		hasUI: false,
		interactivePrompts: true,
		model: options.model,
		modelRegistry: options.modelRegistry,
		promptTemplates: [],
		restrictToolNames: true,
		rules: [],
		scopedModels: options.scopedModels.map(model => ({ model })),
		sessionManager: options.sessionManager,
		settings: options.settings,
		skipPythonPreflight: true,
		skills: [...options.skills],
		slashCommands: [],
		systemPrompt: options.systemPrompt,
		toolNames: [],
	});
	return {
		abort: session.abort.bind(session),
		compact: session.compact.bind(session),
		dispose: session.dispose.bind(session),
		getAllToolNames: session.getAllToolNames.bind(session),
		prompt: session.prompt.bind(session),
		preparePlanForReview: session.preparePlanForReview.bind(session),
		readPlanFile: planFilePath =>
			readPlanFile(planFilePath, {
				cwd: options.cwd,
				localProtocolOptions: {
					getArtifactsDir: () => options.sessionManager.getArtifactsDir(),
					getSessionId: () => options.sessionManager.getSessionId(),
				},
			}),
		refreshRpcHostTools: session.refreshRpcHostTools.bind(session),
		getPlanModeState: session.getPlanModeState.bind(session),
		setPlanModeState: session.setPlanModeState.bind(session),
		setPlanProposalHandler: session.setPlanProposalHandler.bind(session),
		setPlanReferencePath: session.setPlanReferencePath.bind(session),
		setBaseSystemPrompt: session.setBaseSystemPrompt.bind(session),
		setModelTemporary: session.setModelTemporary.bind(session),
		setThinkingLevel: session.setThinkingLevel.bind(session),
		setToolUIContext,
		steer: session.steer.bind(session),
		subscribe: session.subscribe.bind(session),
	};
}

export class EmpatraHostAgentRuntime implements EmpatraHostRuntime {
	readonly #backgroundTurns = new Set<Promise<void>>();
	readonly #interactionBroker: EmpatraHostInteractionBroker;
	readonly #hostToolsConnection: EmpatraHostToolsConnection;
	readonly #handles = new Set<ThreadHandle>();
	readonly #registry: EmpatraHostThreadRegistry<ThreadHandle>;
	readonly #sessionFactory: EmpatraHostSessionFactory;
	readonly #subagentController?: EmpatraHostSubagentController;
	readonly #subagentRpcTransport?: EmpatraHostSubagentRpcTransport;
	#disposing = false;
	#eventSink: (event: EmpatraHostEvent) => Promise<void> = async () => {
		throw new EmpatraHostProtocolError("event_sink_missing", "Empatra host event sink is not connected");
	};
	#initialized?: InitializedRuntime;
	readonly #interruptedTurns = new Set<string>();
	readonly #operationCommandTails = new Map<string, Promise<void>>();
	readonly #threadReadProjectionCache = new Map<string, TurnAlignedThreadReadProjection>();
	readonly #threadCommandTails = new Map<string, Promise<void>>();
	readonly #pendingPlanResolutions = new Map<string, PendingPlanResolution>();
	#hostToolCatalog?: Readonly<{ revision: string; tools: readonly EmpatraHostToolDefinition[] }>;

	constructor(
		options: {
			maxResidentThreads?: number;
			sessionFactory?: EmpatraHostSessionFactory;
			subagentController?: EmpatraHostSubagentController;
			subagentRpcTransport?: EmpatraHostSubagentRpcTransport;
			subagentRunner?: EmpatraHostSubagentRunner;
		} = {},
	) {
		if (options.subagentController && options.subagentRunner) {
			throw new RangeError("Provide either subagentController or subagentRunner, not both");
		}
		const subagentRunner = options.subagentRunner;
		this.#registry = new EmpatraHostThreadRegistry(options.maxResidentThreads);
		this.#sessionFactory = options.sessionFactory ?? defaultSessionFactory;
		this.#subagentController =
			options.subagentController ??
			(subagentRunner
				? new EmpatraHostSubagentController({
						onEvent: event => this.#eventSink(event),
						runner: subagentRunner,
				})
				: undefined);
		this.#subagentRpcTransport = options.subagentRpcTransport;
		this.#hostToolsConnection = new EmpatraHostToolsConnection();
		this.#interactionBroker = new EmpatraHostInteractionBroker({
			emitRequest: request => this.#emitInteractionRequest(request),
		});
	}

	getAdvertisedCapabilities() {
		return this.#subagentController || this.#subagentRpcTransport
			? [...EMPATRA_HOST_CAPABILITIES, EMPATRA_HOST_SUBAGENT_CAPABILITY]
			: EMPATRA_HOST_CAPABILITIES;
	}

	spawnSubagent(command: EmpatraHostSubagentSpawnCommand): Promise<unknown> {
		this.#requireSubagentParent(command);
		if (this.#subagentController) return this.#subagentController.spawn(command);
		return this.#requireSubagentRpcBroker().spawn(this.#subagentScope(command), {
			...(command.agentName === undefined ? {} : { agentName: command.agentName }),
			assignment: command.assignment,
			...(command.modelId === undefined ? {} : { modelId: command.modelId }),
		});
	}

	steerSubagent(command: EmpatraHostSubagentSteerCommand): Promise<unknown> {
		this.#requireSubagentParent(command);
		if (this.#subagentController) return this.#subagentController.steer(command, command.childId, command.message);
		return this.#requireSubagentRpcBroker().steer(this.#subagentScope(command), command.childId, command.message);
	}

	interruptSubagent(command: EmpatraHostSubagentInterruptCommand): Promise<unknown> {
		this.#requireSubagentParent(command);
		if (this.#subagentController) return this.#subagentController.interrupt(command, command.childId);
		return this.#requireSubagentRpcBroker().interrupt(this.#subagentScope(command), command.childId);
	}

	closeSubagent(command: EmpatraHostSubagentCloseCommand): Promise<unknown> {
		this.#requireSubagentParent(command);
		if (this.#subagentController) return this.#subagentController.close(command, command.childId);
		return this.#requireSubagentRpcBroker().close(this.#subagentScope(command), command.childId);
	}

	listSubagents(command: EmpatraHostSubagentListCommand): Promise<unknown> {
		this.#requireSubagentParent(command);
		if (this.#subagentController) return this.#subagentController.list(command);
		return this.#requireSubagentRpcBroker().list(this.#subagentScope(command));
	}

	/**
	 * The desktop controller owns execution. A response is accepted only by a
	 * future injected transport; the default runtime has no local executor and
	 * therefore fails closed instead of interpreting the payload itself.
	 */
	handleExecutionBrokerResponse(_command: Extract<EmpatraHostCommand, { type: "execution_broker_response" }>): void {
		throw new EmpatraHostProtocolError(
			"execution_broker_unavailable",
			"OMP execution broker transport is not connected",
		);
	}

	handleSubagentResponse(command: EmpatraHostSubagentResponseCommand): void {
		if (!this.#subagentRpcTransport) {
			throw new EmpatraHostProtocolError("subagent_unavailable", "OMP subagent RPC transport is not connected");
		}
		this.#subagentRpcTransport.handleResponse(command);
	}

	async initialize(command: EmpatraHostInitializeCommand): Promise<unknown> {
		if (this.#initialized) {
			throw new EmpatraHostProtocolError("already_initialized", "Empatra host runtime is already initialized");
		}
		const policy = await EmpatraHostWorkspacePolicy.create(command.workspaceRoots);
		const requestedSessionDirectory = path.resolve(command.sessionDirectory);
		await mkdir(requestedSessionDirectory, { mode: 0o700, recursive: true });
		const sessionDirectory = await realpath(requestedSessionDirectory);
		if (process.platform !== "win32") await chmod(sessionDirectory, 0o700);
		const blobDirectory = await createPrivateBlobDirectory(sessionDirectory);
		const extensionPaths = await resolveMaterializedExtensions(command.extensions ?? [], sessionDirectory);
		const agentDir = path.join(sessionDirectory, "runtime");
		await mkdir(agentDir, { mode: 0o700, recursive: true });
		if (process.platform !== "win32") await chmod(agentDir, 0o700);
		const models = new Map(command.models.map(model => [model.id, toModel(model, command.gatewayBaseUrl)]));
		const modelDefinitions = new Map(command.models.map(model => [model.id, model]));
		const skills = await resolveMaterializedSkills(command.skills ?? [], sessionDirectory);
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await authStorage.reload();
		const settings = Settings.isolated({ "tools.approvalMode": "always-ask" }, { agentDir, cwd: policy.roots[0] });
		const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "injected-models.yml"), {
			ignoreLocalModelConfig: true,
			settings,
		});
		const metadataPath = path.join(agentDir, "empatra-host-metadata.sqlite3");
		const blobAuthorityPath = path.join(agentDir, "empatra-host-blob-gc-authority.sqlite3");
		let metadataStore: EmpatraHostThreadMetadataStore | undefined;
		let atomicOperationStore: EmpatraHostAtomicOperationStore | undefined;
		let blobGarbageCollectionAuthority: Database | undefined;
		try {
			blobGarbageCollectionAuthority = acquireBlobGarbageCollectionAuthority(agentDir);
			metadataStore = new EmpatraHostThreadMetadataStore(metadataPath);
			atomicOperationStore = new EmpatraHostAtomicOperationStore(metadataPath);
			if (process.platform !== "win32") {
				await chmod(blobAuthorityPath, 0o600);
				await chmod(metadataPath, 0o600);
			}
		} catch (error) {
			atomicOperationStore?.close();
			metadataStore?.close();
			blobGarbageCollectionAuthority?.close();
			authStorage.close();
			throw error;
		}
		if (!metadataStore || !atomicOperationStore || !blobGarbageCollectionAuthority) {
			blobGarbageCollectionAuthority?.close();
			authStorage.close();
			throw new EmpatraHostProtocolError("runtime_error", "Empatra host metadata stores failed to initialize");
		}
		this.#initialized = {
			agentDir,
			atomicOperationStore,
			authStorage,
			blobDirectory,
			blobGarbageCollectionAuthority,
			capability: command.capability,
			extensionDescriptors: (command.extensions ?? []).map((entry, index) => ({
				...entry,
				filePath: extensionPaths[index] as string,
			})),
			extensionPaths,
			modelRegistry,
			metadataStore,
			modelDefinitions,
			models,
			skills,
			policy,
			sessionDirectory,
		};
		return {
			extensionCount: extensionPaths.length,
			modelCount: models.size,
			workspaceRootCount: policy.roots.length,
		};
	}

	/**
	 * Returns the durable receipt projection without opening a thread or
	 * attempting recovery. A controller can use this after an uncertain request
	 * to reconcile its state while preserving the no-replay boundary.
	 */
	async getAtomicOperationStatus(
		command: Extract<EmpatraHostCommand, { type: "atomic_operation_status" }>,
	): Promise<EmpatraHostAtomicOperationStatusResponse> {
		return this.#withOperationCommand(command.operationId, async () => {
			const receipt = this.#requireInitialized().atomicOperationStore.status(command.operationId);
			if (!receipt) return { operationId: command.operationId, status: "missing" };
			return {
				generation: receipt.generation,
				inputSha256: receipt.inputSha256,
				kind: receipt.kind,
				operationId: receipt.operationId,
				status: receipt.phase,
				threadId: receipt.threadId,
				turnId: receipt.turnId,
			};
		});
	}

	setEventSink(sink: (event: EmpatraHostEvent) => Promise<void>): void {
		this.#eventSink = sink;
	}

	setHostToolSink(sink: (frame: EmpatraHostToolOutboundFrame) => Promise<void>): void {
		this.#hostToolsConnection.setSink(sink);
	}

	async replaceHostTools(command: EmpatraHostToolsReplaceCommand): Promise<unknown> {
		return this.#withOperationCommand("empatra-host-tools", async () => {
			validateEmpatraHostToolCatalog(command.tools, command.catalogRevision);
			const previous = this.#hostToolCatalog;
			const handles = [...this.#handles];
			for (const handle of handles) {
				const previousHostNames = handle.hostTools.getToolNames();
				const nativeNames = new Set(
					(handle.session.getAllToolNames?.() ?? []).filter(name => !previousHostNames.has(name)),
				);
				if (command.tools.some(tool => nativeNames.has(tool.name))) {
					throw new EmpatraHostProtocolError(
						"host_tool_catalog_invalid",
						"Host tool conflicts with a session tool",
					);
				}
			}
			const attempted: ThreadHandle[] = [];
			try {
				for (const handle of handles) {
					attempted.push(handle);
					const tools = handle.hostTools.replaceCatalog(command.tools, command.catalogRevision);
					await handle.session.refreshRpcHostTools?.(tools);
				}
			} catch (error) {
				const rollbackTools = previous?.tools ?? [];
				const rollbackRevision = previous?.revision ?? command.catalogRevision;
				const rollback = await Promise.allSettled(
					attempted.map(async handle => {
						const tools = handle.hostTools.replaceCatalog(rollbackTools, rollbackRevision);
						await handle.session.refreshRpcHostTools?.(tools);
					}),
				);
				if (rollback.some(result => result.status === "rejected")) {
					throw new EmpatraHostProtocolError("runtime_error", "Host tool catalog rollback failed");
				}
				throw error;
			}
			this.#hostToolCatalog = { revision: command.catalogRevision, tools: command.tools };
			for (const handle of handles) {
				if (handle.activeTurn) handle.activeTurn.catalogRevision = command.catalogRevision;
			}
			return {
				catalogRevision: command.catalogRevision,
				toolNames: command.tools.map(tool => tool.name),
			};
		});
	}

	handleHostToolResult(frame: EmpatraHostToolResultFrame): void {
		this.#requireActiveHostToolScope(frame);
		this.#hostToolsConnection.handleResult(frame);
	}

	handleHostToolCancel(frame: EmpatraHostToolCancelFrame): void {
		this.#requireActiveHostToolScope(frame);
		this.#hostToolsConnection.handleHostCancel(frame);
	}

	async noteInteractionActivity(command: InteractionActivityCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () => {
			this.#requireInteractionTurn(command);
			const resolution = this.#interactionBroker.noteActivity(command.requestId, command.digest);
			this.#assertInteractionResolution(resolution);
			return {
				expiresAt: resolution.accepted ? (resolution.expiresAt ?? null) : null,
				requestId: command.requestId,
			};
		});
	}

	async cancelInteraction(command: InteractionCancelCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () => {
			this.#requireInteractionTurn(command);
			this.#assertInteractionResolution(this.#interactionBroker.cancel(command.requestId, command.digest));
			return { cancelled: true, requestId: command.requestId };
		});
	}

	async respondToInteraction(command: InteractionRespondCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () => {
			this.#requireInteractionTurn(command);
			this.#assertInteractionResolution(
				this.#interactionBroker.resolveResponse({
					...command.response,
					digest: command.digest,
					requestId: command.requestId,
				}),
			);
			return { accepted: true, requestId: command.requestId };
		});
	}

	#rejectPendingPlanResolutions(threadId: string, turnId: string, error: Error): void {
		for (const [requestId, pending] of this.#pendingPlanResolutions) {
			if (pending.threadId !== threadId || pending.turnId !== turnId) continue;
			this.#pendingPlanResolutions.delete(requestId);
			pending.reject(error);
		}
	}

	async resolvePlan(command: EmpatraHostPlanResolutionCommand): Promise<unknown> {
		return await this.#withThreadCommand(command.threadId, async () => {
			const state = this.#registry.get(command.threadId);
			const activeTurn = state?.handle.activeTurn;
			if (
				!state ||
				state.generation !== command.expectedGeneration ||
				state.activeTurnId !== command.turnId ||
				!activeTurn ||
				activeTurn.generation !== command.expectedGeneration ||
				activeTurn.turnId !== command.turnId
			) {
				throw new EmpatraHostProtocolError("stale_turn", "Plan resolution does not match the active turn");
			}
			const pending = this.#pendingPlanResolutions.get(command.requestId);
			if (!pending) throw new EmpatraHostProtocolError("plan_not_pending", "Plan proposal is no longer pending");
			if (
				pending.digest !== command.digest ||
				pending.generation !== command.expectedGeneration ||
				pending.threadId !== command.threadId ||
				pending.turnId !== command.turnId
			) {
				throw new EmpatraHostProtocolError("identity_mismatch", "Plan proposal identity validation failed");
			}
			pending.resolve(command);
			return { accepted: true, action: command.action, requestId: command.requestId };
		});
	}

	async startThread(command: EmpatraHostThreadCreateCommand): Promise<unknown> {
		const runtime = this.#requireInitialized();
		const existing = await this.#findThreadByOperation(command.operationId);
		if (existing) {
			const state = await this.#registry.open(existing.id, () => this.#openThread(existing.path));
			const requestedCwd = await runtime.policy.requireCwd(command.cwd);
			const config = findThreadConfig(state.handle.sessionManager);
			this.#assertCreateMatches(state.handle.sessionManager, command, requestedCwd);
			this.#configureApprovalMode(state.handle, command.approvalMode ?? config.approvalMode);
			this.#configureMode(state.handle, command.mode ?? config.mode);
			return { generation: state.generation, threadId: state.handle.threadId };
		}
		const cwd = await runtime.policy.requireCwd(command.cwd);
		const model = this.#requireModel(command.modelId);
		const state = await this.#registry.create(command.operationId, async () => {
			const sessionManager = SessionManager.create(cwd, runtime.sessionDirectory, undefined, {
				blobDir: runtime.blobDirectory,
				enableFileBlobGarbageCollection: true,
			});
			sessionManager.appendCustomEntry(EMPATRA_THREAD_CONFIG_ENTRY, {
				...(command.approvalMode === undefined ? {} : { approvalMode: command.approvalMode }),
				...(command.mode === undefined ? {} : { mode: command.mode }),
				modelId: command.modelId,
				operationId: command.operationId,
				systemPrompt: command.systemPrompt,
				version: EMPATRA_THREAD_CONFIG_VERSION,
			} satisfies PersistedThreadConfig);
			await sessionManager.ensureOnDisk();
			return this.#createHandle(sessionManager, model, command.systemPrompt, command.approvalMode);
		});
		this.#configureMode(state.handle, command.mode);
		this.#recordThreadMetadata(state.handle, command.operationId, false);
		return { generation: state.generation, threadId: state.handle.threadId };
	}

	async startThreadAndTurn(command: EmpatraHostThreadCreateAndStartCommand): Promise<unknown> {
		return this.#withOperationCommand(command.operationId, async () => {
			let inputSha256 = digestEmpatraHostAtomicInput([
				"empatra.host.create-and-start.v6",
				command.operationId,
				command.cwd,
				command.modelId,
				command.systemPrompt,
				command.mode ?? "",
				command.approvalMode ?? "",
				command.reasoningEffort ?? "",
				command.message,
				digestEmpatraHostImageDescriptors(command.images),
				command.turnId,
			]);
			const runtime = this.#requireInitialized();
			const existing = runtime.atomicOperationStore.get(command.operationId);
			if (
				existing &&
				existing.inputSha256 !== inputSha256 &&
				command.reasoningEffort == null &&
				command.mode == null &&
				command.approvalMode == null
			) {
				const previousInputSha256 = digestEmpatraHostAtomicInput([
					"empatra.host.create-and-start.v5",
					command.operationId,
					command.cwd,
					command.modelId,
					command.systemPrompt,
					command.mode ?? "",
					command.reasoningEffort ?? "",
					command.message,
					digestEmpatraHostImageDescriptors(command.images),
					command.turnId,
				]);
				if (existing.inputSha256 === previousInputSha256) inputSha256 = previousInputSha256;
				else {
					const legacyInputSha256 = digestEmpatraHostAtomicInput([
						"empatra.host.create-and-start.v3",
						command.operationId,
						command.cwd,
						command.modelId,
						command.systemPrompt,
						command.message,
						digestEmpatraHostImageDescriptors(command.images),
						command.turnId,
					]);
					if (existing.inputSha256 === legacyInputSha256) inputSha256 = legacyInputSha256;
				}
			}
			if (existing) {
				const receipt = runtime.atomicOperationStore.accept({
					generation: existing.generation,
					inputSha256,
					kind: "create_and_start",
					operationId: command.operationId,
					threadId: existing.threadId,
					turnId: command.turnId,
				});
				return this.#resumeAtomicOperation(
					receipt,
					command.message,
					command.images,
					command.reasoningEffort ?? null,
					command.mode,
					command.approvalMode,
				);
			}
			const preparedImages = await prepareEmpatraHostImages(
				runtime.sessionDirectory,
				this.#requireModel(command.modelId),
				command.images,
			);
			try {
				const created = (await this.startThread({
					cwd: command.cwd,
					id: command.id,
					modelId: command.modelId,
					...(command.mode === undefined ? {} : { mode: command.mode }),
					...(command.approvalMode === undefined ? {} : { approvalMode: command.approvalMode }),
					operationId: command.operationId,
					systemPrompt: command.systemPrompt,
					type: "thread_create",
				})) as { generation: number; threadId: string };
				const receipt = this.#requireInitialized().atomicOperationStore.accept({
					generation: created.generation + 1,
					inputSha256,
					kind: "create_and_start",
					operationId: command.operationId,
					threadId: created.threadId,
					turnId: command.turnId,
				});
				return await this.#resumeAtomicOperation(
					receipt,
					command.message,
					command.images,
					command.reasoningEffort ?? null,
					command.mode,
					command.approvalMode,
					preparedImages,
				);
			} catch (error) {
				preparedImages?.release();
				throw error;
			}
		});
	}

	async forkThread(command: EmpatraHostThreadForkCommand): Promise<unknown> {
		const existing = await this.#findThreadByOperation(command.operationId);
		if (existing) return this.#openIdempotentFork(existing, command);
		return this.#withThreadCommand(command.threadId, async () => {
			const repeated = await this.#findThreadByOperation(command.operationId);
			if (repeated) return this.#openIdempotentFork(repeated, command);
			const runtime = this.#requireInitialized();
			const source = await this.#findThread(command.threadId);
			const resident = this.#registry.get(command.threadId);
			if (resident?.activeTurnId) {
				throw new EmpatraHostProtocolError("turn_active", "Cannot fork a thread with an active turn");
			}
			const sourceManager = resident?.handle.sessionManager ?? (await this.#openSessionManager(source.path));
			try {
				const sourceConfig = findThreadConfig(sourceManager);
				const cwd = await runtime.policy.requireCwd(command.cwd ?? sourceManager.getCwd());
				const state = await this.#registry.create(command.operationId, async () => {
					const forked = await SessionManager.forkFrom(source.path, cwd, runtime.sessionDirectory, undefined, {
						blobDir: runtime.blobDirectory,
						copyArtifacts: true,
						enableFileBlobGarbageCollection: true,
						suppressBreadcrumb: true,
					});
					let persisted = false;
					try {
						forked.appendCustomEntry(EMPATRA_THREAD_CONFIG_ENTRY, {
							...(command.approvalMode === undefined && sourceConfig.approvalMode === undefined
								? {}
								: { approvalMode: command.approvalMode ?? sourceConfig.approvalMode }),
							...(command.mode === undefined && sourceConfig.mode === undefined
								? {}
								: { mode: command.mode ?? sourceConfig.mode }),
							modelId: sourceConfig.modelId,
							operationId: command.operationId,
							systemPrompt: sourceConfig.systemPrompt,
							version: EMPATRA_THREAD_CONFIG_VERSION,
						} satisfies PersistedThreadConfig);
						forked.appendCustomEntry(EMPATRA_THREAD_LIFECYCLE_ENTRY, {
							archived: false,
							version: EMPATRA_THREAD_LIFECYCLE_VERSION,
						} satisfies PersistedThreadLifecycle);
						await forked.ensureOnDisk();
						persisted = true;
						return await this.#createHandle(
							forked,
							this.#requireModel(sourceConfig.modelId),
							sourceConfig.systemPrompt,
							command.approvalMode ?? sourceConfig.approvalMode,
						);
					} catch (error) {
						const sessionPath = forked.getSessionFile();
						if (persisted || !sessionPath) await forked.close().catch(() => undefined);
						else await forked.dropSession(sessionPath).catch(() => undefined);
						throw error;
					}
				});
				this.#assertForkMatches(state.handle.sessionManager, command, cwd);
				const config = findThreadConfig(state.handle.sessionManager);
				this.#configureMode(state.handle, command.mode ?? config.mode);
				this.#recordThreadMetadata(state.handle, command.operationId, false);
				return { generation: state.generation, threadId: state.handle.threadId };
			} finally {
				if (!resident) await sourceManager.close();
			}
		});
	}

	async forkThreadAndStart(command: EmpatraHostThreadForkAndStartCommand): Promise<unknown> {
		return this.#withOperationCommand(command.operationId, async () => {
			let inputSha256 = digestEmpatraHostAtomicInput([
				"empatra.host.fork-and-start.v6",
				command.operationId,
				command.threadId,
				command.mode ?? "",
				command.approvalMode ?? "",
				command.cwd ?? "",
				command.reasoningEffort ?? "",
				command.message,
				digestEmpatraHostImageDescriptors(command.images),
				command.turnId,
			]);
			const runtime = this.#requireInitialized();
			const existing = runtime.atomicOperationStore.get(command.operationId);
			if (
				existing &&
				existing.inputSha256 !== inputSha256 &&
				command.reasoningEffort == null &&
				command.mode == null &&
				command.approvalMode == null
			) {
				const previousInputSha256 = digestEmpatraHostAtomicInput([
					"empatra.host.fork-and-start.v5",
					command.operationId,
					command.threadId,
					command.mode ?? "",
					command.cwd ?? "",
					command.reasoningEffort ?? "",
					command.message,
					digestEmpatraHostImageDescriptors(command.images),
					command.turnId,
				]);
				if (existing.inputSha256 === previousInputSha256) inputSha256 = previousInputSha256;
				else {
					const legacyInputSha256 = digestEmpatraHostAtomicInput([
						"empatra.host.fork-and-start.v3",
						command.operationId,
						command.threadId,
						command.cwd ?? "",
						command.message,
						digestEmpatraHostImageDescriptors(command.images),
						command.turnId,
					]);
					if (existing.inputSha256 === legacyInputSha256) inputSha256 = legacyInputSha256;
				}
			}
			if (existing) {
				const receipt = runtime.atomicOperationStore.accept({
					generation: existing.generation,
					inputSha256,
					kind: "fork_and_start",
					operationId: command.operationId,
					threadId: existing.threadId,
					turnId: command.turnId,
				});
				return this.#resumeAtomicOperation(
					receipt,
					command.message,
					command.images,
					command.reasoningEffort ?? null,
					command.mode,
					command.approvalMode,
				);
			}
			const preparedImages = await this.#prepareImagesForThread(command.threadId, command.images);
			try {
				const forked = (await this.forkThread({
					...(command.cwd === undefined ? {} : { cwd: command.cwd }),
					id: command.id,
					operationId: command.operationId,
					threadId: command.threadId,
					...(command.mode === undefined ? {} : { mode: command.mode }),
					...(command.approvalMode === undefined ? {} : { approvalMode: command.approvalMode }),
					type: "thread_fork",
				})) as { generation: number; threadId: string };
				const receipt = this.#requireInitialized().atomicOperationStore.accept({
					generation: forked.generation + 1,
					inputSha256,
					kind: "fork_and_start",
					operationId: command.operationId,
					threadId: forked.threadId,
					turnId: command.turnId,
				});
				return await this.#resumeAtomicOperation(
					receipt,
					command.message,
					command.images,
					command.reasoningEffort ?? null,
					command.mode,
					command.approvalMode,
					preparedImages,
				);
			} catch (error) {
				preparedImages?.release();
				throw error;
			}
		});
	}

	async compactThread(command: ThreadCompactCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () => {
			const state = await this.#registry.open(command.threadId, async () => {
				const session = await this.#findThread(command.threadId);
				return this.#openThread(session.path);
			});
			if (state.activeTurnId) {
				throw new EmpatraHostProtocolError("turn_active", "Cannot compact a thread with an active turn");
			}
			await state.handle.session.compact();
			return { compacted: true, generation: state.generation, threadId: command.threadId };
		});
	}

	async rollbackThread(command: ThreadRollbackCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () => {
			const state = await this.#registry.open(command.threadId, async () => {
				const session = await this.#findThread(command.threadId);
				return this.#openThread(session.path);
			});
			if (state.activeTurnId) {
				throw new EmpatraHostProtocolError("turn_active", "Cannot roll back a thread with an active turn");
			}
			const rolledBack = await rollbackEmpatraHostThread(state.handle.sessionManager, command.turns);
			state.handle.sessionManager.scheduleBlobGarbageCollection();
			const generation = this.#registry.advanceGeneration(command.threadId);
			return {
				generation,
				rolledBackTurnIds: rolledBack.rolledBackTurnIds,
				threadId: command.threadId,
			};
		});
	}

	async archiveThread(command: ThreadStateCommand): Promise<unknown> {
		return this.#setArchived(command.threadId, true);
	}

	async unarchiveThread(command: ThreadStateCommand): Promise<unknown> {
		return this.#setArchived(command.threadId, false);
	}

	async deleteThread(command: ThreadDeleteCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () => {
			this.#interactionBroker.cancelThread(command.threadId);
			const session = await this.#findThread(command.threadId);
			await this.#registry.close(command.threadId);
			const manager = await this.#openSessionManager(session.path);
			try {
				await manager.dropSession(session.path);
			} finally {
				await manager.close();
			}
			this.#requireInitialized().metadataStore.delete(command.threadId);
			return { deleted: true, threadId: command.threadId };
		});
	}

	async renameThread(command: ThreadRenameCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () => {
			const session = await this.#findThread(command.threadId);
			const resident = this.#registry.get(command.threadId);
			if (resident) {
				if (!(await resident.handle.sessionManager.setSessionName(command.title, "user", "empatra-host"))) {
					throw new EmpatraHostProtocolError("thread_rename_failed", "OMP rejected the thread title");
				}
				return { renamed: true, threadId: command.threadId, title: command.title };
			}
			const manager = await this.#openSessionManager(session.path);
			try {
				if (!(await manager.setSessionName(command.title, "user", "empatra-host"))) {
					throw new EmpatraHostProtocolError("thread_rename_failed", "OMP rejected the thread title");
				}
			} finally {
				await manager.close();
			}
			return { renamed: true, threadId: command.threadId, title: command.title };
		});
	}

	async listThreads(command: ThreadListCommand): Promise<unknown> {
		const sessions = await this.#listAuthorizedSessions();
		const indexed = await this.#indexSessions(sessions);
		const archived = command.archived ?? false;
		const searchTerm = command.searchTerm?.normalize("NFKC").toLocaleLowerCase();
		const filtered = indexed.filter(({ metadata, session }) => {
			if (metadata.archived !== archived) return false;
			if (!searchTerm) return true;
			return [session.title ?? "", session.cwd].some(value =>
				value.normalize("NFKC").toLocaleLowerCase().includes(searchTerm),
			);
		});
		const page = filtered.slice(command.offset, command.offset + command.limit);
		const nextOffset = command.offset + page.length;
		return {
			nextOffset: nextOffset < filtered.length ? nextOffset : null,
			threads: page.map(({ metadata, session }) => ({
				archived: metadata.archived,
				createdAt: session.created.toISOString(),
				cwd: session.cwd,
				id: session.id,
				messageCount: session.messageCount,
				status: session.status ?? null,
				title: session.title ?? null,
				updatedAt: session.modified.toISOString(),
			})),
		};
	}

	#readProjection(
		threadId: string,
		generation: number,
		leafId: string | null,
		branch: readonly SessionEntry[],
		activeTurnId: string | null,
	): TurnAlignedThreadReadProjection {
		const snapshotRevision = createThreadSnapshotRevision(generation, leafId);
		const cacheKey = `${threadId}\0${snapshotRevision}`;
		const cached = this.#threadReadProjectionCache.get(cacheKey);
		if (cached) {
			// Map insertion order is the small LRU; touching the item keeps hot
			// history resident while bounding total retained projection memory.
			this.#threadReadProjectionCache.delete(cacheKey);
			this.#threadReadProjectionCache.set(cacheKey, cached);
			return cached;
		}

		const projection = buildTurnAlignedThreadReadProjection(branch, activeTurnId);
		if (projection.bytes <= MAX_THREAD_READ_PROJECTION_CACHE_BYTES) {
			this.#threadReadProjectionCache.set(cacheKey, projection);
			while (this.#threadReadProjectionCache.size > MAX_THREAD_READ_PROJECTION_CACHE_ENTRIES) {
				const oldest = this.#threadReadProjectionCache.keys().next().value;
				if (oldest === undefined) break;
				this.#threadReadProjectionCache.delete(oldest);
			}
		}
		return projection;
	}

	async #readTurnAlignedThreadPage(
		command: ThreadReadCommand,
		session: SessionInfo,
		manager: SessionManager,
		cursor: TurnAlignedThreadReadCursor | undefined,
	): Promise<unknown> {
		const config = findThreadConfig(manager);
		const branch = manager.getBranch();
		const modelContextWindow = this.#requireModel(config.modelId).contextWindow;
		if (modelContextWindow === null) {
			throw new EmpatraHostProtocolError("model_invalid", "Injected model is missing its context window");
		}
		const generation = this.#registry.get(command.threadId)?.generation ?? 0;
		const leafId = manager.getLeafId();
		const snapshotRevision = createThreadSnapshotRevision(generation, leafId);
		if (
			cursor &&
			(cursor.threadId !== command.threadId ||
				cursor.generation !== generation ||
				cursor.leafId !== leafId ||
				cursor.snapshotRevision !== snapshotRevision)
		) {
			throw new EmpatraHostProtocolError("stale_cursor", "Thread changed during snapshot pagination");
		}

		const activeTurnId = this.#registry.get(command.threadId)?.activeTurnId ?? null;
		const projection = this.#readProjection(command.threadId, generation, leafId, branch, activeTurnId);
		const modelContext = projectEmpatraHostContextUsage(branch, modelContextWindow);
		const thread = {
			archived: (await this.#ensureThreadMetadata(session)).archived,
			cwd: manager.getCwd(),
			id: manager.getSessionId(),
			modelId: config.modelId,
			systemPromptSha256: digestEmpatraHostText(config.systemPrompt),
			title: manager.getSessionName() ?? null,
		};
		const orderedTurns = projection.turns.toReversed();
		const turnOffset = cursor?.turnOffset ?? 0;
		if (
			turnOffset > orderedTurns.length ||
			(cursor?.turnCount !== undefined && cursor.turnCount !== orderedTurns.length)
		) {
			throw new EmpatraHostProtocolError("stale_cursor", "Thread turns changed during snapshot pagination");
		}

		const candidateTurns = orderedTurns.slice(turnOffset, turnOffset + command.limit);
		const makePage = (pageTurns: readonly EmpatraHostTurnSummary[]) => {
			const messages = pageTurns.flatMap(turn => projection.messagesByTurn.get(turn.id) ?? []);
			const nextOffset = turnOffset + pageTurns.length;
			return {
				contextUsage: modelContext,
				generation,
				messages,
				nextCursor:
					nextOffset < orderedTurns.length
						? encodeThreadReadCursor({
								generation,
								leafId,
								order: "desc",
								snapshotRevision,
								threadId: command.threadId,
								turnCount: orderedTurns.length,
								turnOffset: nextOffset,
								v: 2,
							})
						: null,
				paginationVersion: 2 as const,
				snapshotRevision,
				thread,
				turns: pageTurns,
			};
		};

		let pageTurns = candidateTurns;
		for (;;) {
			const candidate = makePage(pageTurns.toReversed());
			if (eventEncoder.encode(JSON.stringify(candidate)).byteLength <= EMPATRA_HOST_THREAD_READ_TARGET_BYTES) {
				if (pageTurns.length === 0 && turnOffset < orderedTurns.length) {
					throw new EmpatraHostProtocolError("frame_too_large", "A projected thread turn exceeds the read budget");
				}
				return candidate;
			}
			if (pageTurns.length <= 1) {
				throw new EmpatraHostProtocolError("frame_too_large", "A projected thread turn exceeds the read budget");
			}
			pageTurns = pageTurns.slice(0, -1);
		}
	}

	async readThread(command: ThreadReadCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () => {
			const session = await this.#findThread(command.threadId);
			return this.#withThreadManager(command.threadId, async manager => {
				const requestedCursor = command.cursor ? decodeThreadReadCursor(command.cursor) : undefined;
				if (command.pagination === "turns-v2" || requestedCursor?.v === 2) {
					if (requestedCursor?.v === 1) {
						throw new EmpatraHostProtocolError(
							"invalid_cursor",
							"Legacy thread read cursors cannot be used with turn-aligned pagination",
						);
					}
					return this.#readTurnAlignedThreadPage(command, session, manager, requestedCursor);
				}
				const config = findThreadConfig(manager);
				const branch = manager.getBranch();
				const messages = projectThreadMessages(branch);
				const modelContextWindow = this.#requireModel(config.modelId).contextWindow;
				if (modelContextWindow === null) {
					throw new EmpatraHostProtocolError("model_invalid", "Injected model is missing its context window");
				}
				const contextUsage = projectEmpatraHostContextUsage(branch, modelContextWindow);
				const generation = this.#registry.get(command.threadId)?.generation ?? 0;
				const leafId = manager.getLeafId();
				const snapshotRevision = createThreadSnapshotRevision(generation, leafId);
				const cursor = requestedCursor?.v === 1 ? requestedCursor : undefined;
				if (
					cursor &&
					(cursor.threadId !== command.threadId ||
						cursor.generation !== generation ||
						cursor.leafId !== leafId ||
						cursor.messageCount !== messages.length ||
						cursor.offset > messages.length)
				) {
					throw new EmpatraHostProtocolError("stale_cursor", "Thread changed during snapshot pagination");
				}
				const offset = cursor?.offset ?? 0;
				const thread = {
					archived: (await this.#ensureThreadMetadata(session)).archived,
					cwd: manager.getCwd(),
					id: manager.getSessionId(),
					modelId: config.modelId,
					systemPromptSha256: digestEmpatraHostText(config.systemPrompt),
					title: manager.getSessionName() ?? null,
				};
				const makePage = (page: typeof messages) => {
					const nextOffset = offset + page.length;
					return {
						contextUsage,
						generation,
						messages: page,
						nextCursor:
							nextOffset < messages.length
								? encodeThreadReadCursor({
										generation,
										leafId,
										messageCount: messages.length,
										offset: nextOffset,
										threadId: command.threadId,
										v: 1,
									})
								: null,
						snapshotRevision,
						thread,
					};
				};
				const page = [] as (typeof messages)[number][];
				for (const message of messages.slice(offset, offset + command.limit)) {
					const candidate = [...page, message];
					if (
						eventEncoder.encode(JSON.stringify(makePage(candidate))).byteLength >
						EMPATRA_HOST_THREAD_READ_TARGET_BYTES
					) {
						break;
					}
					page.push(message);
				}
				if (page.length === 0 && offset < messages.length) {
					throw new EmpatraHostProtocolError(
						"frame_too_large",
						"A projected thread message exceeds the read budget",
					);
				}
				return makePage(page);
			});
		});
	}

	async listThreadTurns(command: ThreadTurnsCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () =>
			this.#withThreadManager(command.threadId, async manager => {
				const resident = this.#registry.get(command.threadId);
				const activeTurnId = resident?.activeTurnId ?? null;
				const generation = resident?.generation ?? 0;
				const turns = projectThreadTurns(manager.getBranch(), activeTurnId);
				const sortDirection = command.sortDirection ?? "desc";
				const anchor = manager.getLeafId();
				const snapshotRevision = createThreadSnapshotRevision(generation, anchor);
				const cursor = command.cursor ? decodeTurnCursor(command.cursor) : undefined;
				if (
					cursor &&
					(cursor.threadId !== command.threadId ||
						cursor.sortDirection !== sortDirection ||
						cursor.anchor !== anchor ||
						cursor.turnCount !== turns.length ||
						cursor.offset > turns.length)
				) {
					throw new EmpatraHostProtocolError("stale_cursor", "Thread turns changed during pagination");
				}
				const ordered = sortDirection === "asc" ? turns : turns.toReversed();
				const offset = cursor?.offset ?? 0;
				const data = ordered.slice(offset, offset + command.limit);
				const nextOffset = offset + data.length;
				const makeCursor = (cursorOffset: number) =>
					encodeTurnCursor({
						anchor,
						offset: cursorOffset,
						sortDirection,
						threadId: command.threadId,
						turnCount: turns.length,
						v: 1,
					});
				return {
					backwardsCursor: offset > 0 ? makeCursor(Math.max(0, offset - command.limit)) : null,
					data,
					nextCursor: nextOffset < ordered.length ? makeCursor(nextOffset) : null,
					snapshotRevision,
				};
			}),
		);
	}

	async getThreadGoal(command: EmpatraHostGoalGetCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () =>
			this.#withThreadManager(command.threadId, async manager => ({ goal: getPersistedThreadGoal(manager) })),
		);
	}

	async setThreadGoal(command: EmpatraHostGoalSetCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () =>
			this.#withThreadManager(command.threadId, async manager => ({
				goal: setPersistedThreadGoal(manager, command),
			})),
		);
	}

	async clearThreadGoal(command: EmpatraHostGoalClearCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () =>
			this.#withThreadManager(command.threadId, async manager => clearPersistedThreadGoal(manager, command)),
		);
	}

	async startTurn(command: TurnStartCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () => {
			const preparedImages = await this.#prepareImagesForThread(command.threadId, command.images, command.modelId);
			return this.#startTurnLocked(command, { preparedImages });
		});
	}

	async interruptTurn(command: TurnInterruptCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () => {
			const handle = this.#registry.requireActiveTurn(command.threadId, command.turnId, command.expectedGeneration);
			this.#interactionBroker.cancelThread(command.threadId);
			this.#rejectPendingPlanResolutions(
				command.threadId,
				command.turnId,
				new EmpatraHostProtocolError("plan_not_pending", "Plan proposal was interrupted"),
			);
			this.#interruptedTurns.add(this.#turnKey(command.threadId, command.turnId));
			try {
				await handle.session.abort({ goalReason: "interrupted", reason: "Interrupted by Empatra Studio" });
			} catch (error) {
				this.#interruptedTurns.delete(this.#turnKey(command.threadId, command.turnId));
				throw error;
			} finally {
				for (const admission of handle.activeTurn?.imageAdmissions ?? []) admission.release();
			}
			return { interrupted: true, threadId: command.threadId, turnId: command.turnId };
		});
	}

	async steerTurn(command: TurnSteerCommand): Promise<unknown> {
		return this.#withThreadCommand(command.threadId, async () => {
			const handle = this.#registry.requireActiveTurn(command.threadId, command.turnId, command.expectedGeneration);
			const activeTurn = handle.activeTurn;
			if (
				!activeTurn?.acceptingSteer ||
				activeTurn.generation !== command.expectedGeneration ||
				activeTurn.turnId !== command.turnId
			) {
				throw new EmpatraHostProtocolError("stale_turn", "Turn no longer accepts steering input");
			}
			const preparedImages = await prepareEmpatraHostImages(
				this.#requireInitialized().sessionDirectory,
				handle.model,
				command.images,
			);
			let accepted = false;
			let markerEntryId: string | undefined;
			try {
				if (preparedImages) {
					markerEntryId = handle.sessionManager.appendCustomEntry(
						EMPATRA_HOST_USER_MEDIA_ENTRY,
						this.#persistedUserMedia(command.turnId, command.message, preparedImages),
					);
					await handle.sessionManager.flush();
				}
				this.#configureApprovalMode(handle, command.approvalMode ?? activeTurn.approvalMode);
				activeTurn.approvalMode = command.approvalMode ?? activeTurn.approvalMode;
				await handle.session.steer(command.message, preparedImages?.images);
				if (preparedImages) activeTurn.imageAdmissions.push(preparedImages);
				accepted = true;
			} catch (error) {
				if (markerEntryId) {
					handle.sessionManager.appendCustomEntry(EMPATRA_HOST_USER_MEDIA_CANCEL_ENTRY, {
						markerEntryId,
						turnId: command.turnId,
						version: EMPATRA_HOST_USER_MEDIA_ENTRY_VERSION,
					} satisfies EmpatraHostPersistedUserMediaCancellation);
					await handle.sessionManager.flush();
				}
				throw error;
			} finally {
				if (!accepted) preparedImages?.release();
			}
			return {
				generation: activeTurn.generation,
				steered: true,
				threadId: command.threadId,
				turnId: command.turnId,
			};
		});
	}

	async dispose(): Promise<void> {
		this.#disposing = true;
		await this.#subagentController?.dispose();
		this.#subagentRpcTransport?.dispose();
		this.#threadReadProjectionCache.clear();
		this.#interactionBroker.dispose();
		for (const pending of this.#pendingPlanResolutions.values()) {
			pending.reject(new EmpatraHostProtocolError("host_disposed", "OMP host is shutting down"));
		}
		this.#pendingPlanResolutions.clear();
		this.#hostToolsConnection.dispose();
		for (const handle of this.#handles) {
			for (const admission of handle.activeTurn?.imageAdmissions ?? []) admission.release();
		}
		await Promise.allSettled(this.#operationCommandTails.values());
		await Promise.allSettled(this.#threadCommandTails.values());
		await this.#registry.dispose();
		await Promise.allSettled(this.#backgroundTurns);
		if (this.#initialized) {
			await new BlobStore(this.#initialized.blobDirectory).drainScheduledGarbageCollection();
		}
		this.#initialized?.atomicOperationStore.close();
		this.#initialized?.metadataStore.close();
		this.#initialized?.authStorage.close();
		this.#initialized?.blobGarbageCollectionAuthority.close();
		this.#initialized = undefined;
	}

	async #runTurn(
		handle: ThreadHandle,
		command: TurnStartCommand,
		activeGeneration: number,
		preparedImages?: EmpatraHostPreparedImages,
		beforePrompt?: () => void,
	): Promise<void> {
		let error: unknown;
		try {
			beforePrompt?.();
			await handle.session.prompt(command.message, { images: preparedImages?.images });
		} catch (cause) {
			error = cause;
		} finally {
			preparedImages?.release();
		}
		if (handle.activeTurn?.generation === activeGeneration) handle.activeTurn.acceptingSteer = false;
		if (this.#disposing) return;
		await this.#withThreadCommand(command.threadId, async () => {
			await this.#finishTurnLocked(handle, command, activeGeneration, error);
		});
	}

	async #finishTurnLocked(
		handle: ThreadHandle,
		command: TurnStartCommand,
		activeGeneration: number,
		promptError: unknown,
	): Promise<void> {
		this.#interactionBroker.cancelThread(command.threadId);
		this.#rejectPendingPlanResolutions(
			command.threadId,
			command.turnId,
			new EmpatraHostProtocolError("plan_not_pending", "Plan proposal is no longer active"),
		);
		let error = promptError;
		const atomicOperation = handle.activeTurn?.atomicOperation;
		for (const admission of handle.activeTurn?.imageAdmissions ?? []) admission.release();
		this.#closeDanglingTools(handle);
		if (handle.activeTurn) handle.activeTurn.acceptingEvents = false;
		await handle.eventTail;
		this.#configureApprovalMode(handle, handle.defaultApprovalMode);
		if (!error && handle.activeTurn?.toolFailure) error = handle.activeTurn.toolFailure;
		if (!error && handle.streamFailure) error = handle.streamFailure;
		const generation = activeGeneration + 1;
		const key = this.#turnKey(command.threadId, command.turnId);
		const interrupted = this.#interruptedTurns.delete(key);
		const failure = error ? projectEmpatraHostFailure(error, "turn_failed") : undefined;
		const outcome = interrupted ? "interrupted" : failure ? "failed" : "completed";
		try {
			handle.sessionManager.appendCustomEntry(EMPATRA_TURN_ENTRY, {
				completedAt: Date.now(),
				outcome,
				phase: "completed",
				turnId: command.turnId,
				version: EMPATRA_TURN_ENTRY_VERSION,
			} satisfies EmpatraHostPersistedTurnMarker);
			await handle.sessionManager.flush();
		} catch (cause) {
			error = cause;
		}
		if (atomicOperation) {
			try {
				this.#requireInitialized().atomicOperationStore.markCompleted(
					atomicOperation.operationId,
					atomicOperation.inputSha256,
				);
			} catch (cause) {
				error ??= cause;
			}
		}
		const durableFailure = error ? projectEmpatraHostFailure(error, "turn_failed") : undefined;
		const event: EmpatraHostEvent = failure
			? {
					event: "turn_completed",
					error: durableFailure ?? failure,
					generation,
					outcome: interrupted ? "interrupted" : "failed",
					threadId: command.threadId,
					turnId: command.turnId,
					type: "host_event",
				}
			: durableFailure
				? {
						error: durableFailure,
						event: "turn_completed",
						generation,
						outcome: "failed",
						threadId: command.threadId,
						turnId: command.turnId,
						type: "host_event",
					}
				: {
						event: "turn_completed",
						generation,
						outcome: interrupted ? "interrupted" : "completed",
						threadId: command.threadId,
						turnId: command.turnId,
						type: "host_event",
					};
		let deliveryError: unknown;
		let deliveryFailed = false;
		try {
			await this.#eventSink(event);
		} catch (cause) {
			deliveryFailed = true;
			deliveryError = cause;
		}
		const finishedGeneration = this.#registry.finishTurn(command.threadId, command.turnId, activeGeneration);
		handle.activeTurn = null;
		if (finishedGeneration !== generation) {
			throw new EmpatraHostProtocolError("stale_generation", "Turn completion advanced an unexpected generation");
		}
		if (deliveryFailed) throw deliveryError;
	}

	async #startTurnLocked(
		command: TurnStartCommand,
		options: {
			atomicOperation?: Readonly<{ inputSha256: string; operationId: string }>;
			beforePrompt?: () => void;
			preparedImages?: EmpatraHostPreparedImages;
			reusePersistedStart?: boolean;
		} = {},
	): Promise<{ generation: number; threadId: string; turnId: string }> {
		let admissionTransferred = false;
		try {
			const state = await this.#registry.open(command.threadId, async () => {
				const session = await this.#findThread(command.threadId);
				return this.#openThread(session.path);
			});
			const activeGeneration = this.#registry.beginTurn(
				command.threadId,
				command.turnId,
				command.expectedGeneration,
			);
			try {
				await this.#applyTurnConfiguration(state.handle, command);
				this.#applyReasoningEffort(state.handle, command.reasoningEffort ?? null);
				this.#configureApprovalMode(state.handle, command.approvalMode ?? state.handle.defaultApprovalMode);
				this.#configureMode(state.handle, command.mode);
				if (!options.reusePersistedStart) {
					state.handle.sessionManager.appendCustomEntry(EMPATRA_TURN_ENTRY, {
						phase: "started",
						startedAt: Date.now(),
						turnId: command.turnId,
						version: EMPATRA_TURN_ENTRY_VERSION,
					} satisfies EmpatraHostPersistedTurnMarker);
					await state.handle.sessionManager.flush();
				}
				if (options.preparedImages) {
					const messageSha256 = digestEmpatraHostText(command.message);
					if (
						!options.reusePersistedStart ||
						!hasEmpatraHostUserMediaMarker(state.handle.sessionManager.getBranch(), command.turnId, messageSha256)
					) {
						state.handle.sessionManager.appendCustomEntry(
							EMPATRA_HOST_USER_MEDIA_ENTRY,
							this.#persistedUserMedia(command.turnId, command.message, options.preparedImages),
						);
						await state.handle.sessionManager.flush();
					}
				}
			} catch (error) {
				this.#registry.finishTurn(command.threadId, command.turnId, activeGeneration);
				throw error;
			}
			const usageBaseLeafId = state.handle.sessionManager.getLeafId();
			if (usageBaseLeafId === null) {
				this.#registry.finishTurn(command.threadId, command.turnId, activeGeneration);
				throw new EmpatraHostProtocolError("turn_state_corrupt", "Turn start marker was not persisted");
			}
			state.handle.activeTurn = {
				approvalMode: command.approvalMode ?? state.handle.defaultApprovalMode,
				acceptingEvents: true,
				acceptingSteer: true,
				activeAssistantMessageIndex: null,
				activeReasoningContentIndexes: new Map(),
				assistantMessageCount: 0,
				...(options.atomicOperation ? { atomicOperation: options.atomicOperation } : {}),
				catalogRevision: this.#hostToolCatalog?.revision ?? null,
				generation: activeGeneration,
				imageAdmissions: options.preparedImages ? [options.preparedImages] : [],
				openTools: new Map(),
				sequence: 0,
				turnId: command.turnId,
				usageBaseLeafId,
				usageObservations: [],
				usageUpdateCount: 0,
			};
			state.handle.streamFailure = undefined;
			state.handle.streamAbortStarted = false;
			const background = this.#runTurn(
				state.handle,
				command,
				activeGeneration,
				options.preparedImages,
				options.beforePrompt,
			)
				.catch(() => undefined)
				.finally(() => {
					this.#backgroundTurns.delete(background);
				});
			admissionTransferred = true;
			this.#backgroundTurns.add(background);
			return {
				generation: activeGeneration,
				threadId: command.threadId,
				turnId: command.turnId,
			};
		} finally {
			if (!admissionTransferred) options.preparedImages?.release();
		}
	}

	async #prepareImagesForThread(
		threadId: string,
		descriptors: readonly EmpatraHostImageDescriptor[] | undefined,
		modelId?: string,
	): Promise<EmpatraHostPreparedImages | undefined> {
		if (!descriptors) return undefined;
		const resident = this.#registry.get(threadId);
		let model = modelId === undefined ? resident?.handle.model : this.#requireModel(modelId);
		if (!model) {
			const session = await this.#findThread(threadId);
			const manager = await this.#openSessionManager(session.path);
			try {
				model = this.#requireModel(findThreadConfig(manager).modelId);
			} finally {
				await manager.close();
			}
		}
		return prepareEmpatraHostImages(this.#requireInitialized().sessionDirectory, model, descriptors);
	}

	async #resumeAtomicOperation(
		receipt: EmpatraHostAtomicOperation,
		message: string,
		descriptors: readonly EmpatraHostImageDescriptor[] | undefined,
		reasoningEffort: EmpatraHostReasoningEffort | null,
		mode: EmpatraHostMode | undefined,
		approvalMode: EmpatraHostApprovalMode | undefined,
		preloadedImages?: EmpatraHostPreparedImages,
	): Promise<{ generation: number; operationId: string; threadId: string; turnId: string }> {
		return this.#withThreadCommand(receipt.threadId, async () => {
			let preparedImages = preloadedImages;
			let admissionTransferred = false;
			try {
				const state = await this.#registry.open(receipt.threadId, async () => {
					const session = await this.#findThread(receipt.threadId);
					return this.#openThread(session.path);
				});
				const result = {
					generation: receipt.generation,
					operationId: receipt.operationId,
					threadId: receipt.threadId,
					turnId: receipt.turnId,
				};
				if (receipt.phase === "completed") return result;
				if (
					receipt.phase === "dispatching" &&
					state.activeTurnId === receipt.turnId &&
					state.generation === receipt.generation
				) {
					return result;
				}
				const persistedPhase = persistedTurnPhase(state.handle.sessionManager, receipt.turnId);
				if (persistedPhase === "completed") {
					this.#requireInitialized().atomicOperationStore.markCompleted(receipt.operationId, receipt.inputSha256);
					return result;
				}
				if (receipt.phase === "dispatching" || persistedPhase === "uncertain") {
					throw new EmpatraHostProtocolError(
						"atomic_operation_uncertain",
						"Accepted atomic operation may already have reached the provider",
					);
				}
				if (state.generation + 1 !== receipt.generation) {
					throw new EmpatraHostProtocolError(
						"atomic_operation_uncertain",
						"Accepted atomic operation has an unexpected thread generation",
					);
				}
				preparedImages ??= await prepareEmpatraHostImages(
					this.#requireInitialized().sessionDirectory,
					state.handle.model,
					descriptors,
				);
				await this.#startTurnLocked(
					{
						expectedGeneration: state.generation,
						id: receipt.operationId,
						message,
						...(mode === undefined ? {} : { mode }),
						...(approvalMode === undefined ? {} : { approvalMode }),
						reasoningEffort,
						threadId: receipt.threadId,
						turnId: receipt.turnId,
						type: "turn_start",
					},
					{
						atomicOperation: { inputSha256: receipt.inputSha256, operationId: receipt.operationId },
						beforePrompt: () => {
							this.#requireInitialized().atomicOperationStore.markDispatching(
								receipt.operationId,
								receipt.inputSha256,
							);
						},
						preparedImages,
						reusePersistedStart: persistedPhase === "started",
					},
				);
				admissionTransferred = true;
				return result;
			} finally {
				if (!admissionTransferred) preparedImages?.release();
			}
		});
	}

	#turnKey(threadId: string, turnId: string): string {
		return `${threadId}\u0000${turnId}`;
	}

	#persistedUserMedia(
		turnId: string,
		message: string,
		preparedImages: EmpatraHostPreparedImages,
	): EmpatraHostPersistedUserMedia {
		return {
			images: preparedImages.projection.map(({ blockType: _blockType, ...image }) => image),
			messageSha256: digestEmpatraHostText(message),
			turnId,
			version: EMPATRA_HOST_USER_MEDIA_ENTRY_VERSION,
		};
	}

	#requireInteractionTurn(command: { expectedGeneration: number; threadId: string; turnId: string }): ThreadHandle {
		const handle = this.#registry.requireActiveTurn(command.threadId, command.turnId, command.expectedGeneration);
		const activeTurn = handle.activeTurn;
		if (!activeTurn || activeTurn.generation !== command.expectedGeneration || activeTurn.turnId !== command.turnId) {
			throw new EmpatraHostProtocolError("stale_turn", "Interaction command does not match the active turn");
		}
		return handle;
	}

	#requireSubagentRpcBroker(): EmpatraHostSubagentRpcTransport["broker"] {
		const broker = this.#subagentRpcTransport?.broker;
		if (!broker) {
			throw new EmpatraHostProtocolError("subagent_unavailable", "Subagent lifecycle is not wired by the main host");
		}
		return broker;
	}

	#subagentScope(command: EmpatraHostSubagentScope): EmpatraHostSubagentScope {
		return {
			generation: command.generation,
			parentThreadId: command.parentThreadId,
			parentTurnId: command.parentTurnId,
		};
	}

	#requireSubagentParent(command: {
		generation: number;
		parentThreadId: string;
		parentTurnId: string;
	}): void {
		const state = this.#registry.get(command.parentThreadId);
		if (
			!state ||
			state.generation !== command.generation ||
			state.activeTurnId !== command.parentTurnId ||
			state.handle.activeTurn?.generation !== command.generation ||
			state.handle.activeTurn.turnId !== command.parentTurnId
		) {
			throw new EmpatraHostProtocolError("stale_turn", "Subagent command does not match the active parent turn");
		}
	}

	#assertInteractionResolution(resolution: EmpatraHostInteractionResolution): void {
		if (resolution.accepted) return;
		if (resolution.code === "identity_mismatch") {
			throw new EmpatraHostProtocolError("identity_mismatch", "Interaction identity validation failed");
		}
		if (resolution.code === "not_pending") {
			throw new EmpatraHostProtocolError("interaction_not_pending", "Interaction is no longer pending");
		}
		throw new EmpatraHostProtocolError("interaction_response_invalid", "Interaction response is invalid");
	}

	#requireInitialized(): InitializedRuntime {
		if (!this.#initialized) {
			throw new EmpatraHostProtocolError("not_initialized", "Empatra host runtime is not initialized");
		}
		return this.#initialized;
	}

	async #withThreadManager<Result>(
		threadId: string,
		task: (manager: SessionManager) => Promise<Result>,
	): Promise<Result> {
		const session = await this.#findThread(threadId);
		const resident = this.#registry.get(threadId);
		if (resident) return task(resident.handle.sessionManager);
		const manager = await this.#openSessionManager(session.path);
		try {
			await recoverInterruptedToolExecutions(manager);
			return await task(manager);
		} finally {
			await manager.close();
		}
	}

	#requireModel(modelId: string): Model<"openai-responses"> {
		const model = this.#requireInitialized().models.get(modelId);
		if (!model) throw new EmpatraHostProtocolError("model_not_found", "Model is not in the injected Empatra catalog");
		return model;
	}

	#requireActiveHostToolScope(scope: Pick<EmpatraHostToolScope, "generation" | "threadId" | "turnId">): void {
		const state = this.#registry.get(scope.threadId);
		if (
			!state ||
			state.generation !== scope.generation ||
			state.activeTurnId !== scope.turnId ||
			!state.handle.activeTurn?.acceptingEvents
		) {
			throw new EmpatraHostProtocolError("host_tool_protocol_violation", "Host tool response targets a stale turn");
		}
	}

	async #setArchived(threadId: string, archived: boolean): Promise<unknown> {
		return this.#withThreadCommand(threadId, async () => {
			const session = await this.#findThread(threadId);
			const current = await this.#ensureThreadMetadata(session);
			if (current.archived === archived) return { archived, changed: false, threadId };
			await this.#registry.close(threadId);
			const manager = await this.#openSessionManager(session.path);
			try {
				manager.appendCustomEntry(EMPATRA_THREAD_LIFECYCLE_ENTRY, {
					archived,
					version: EMPATRA_THREAD_LIFECYCLE_VERSION,
				} satisfies PersistedThreadLifecycle);
				await manager.ensureOnDisk();
			} finally {
				await manager.close();
			}
			this.#requireInitialized().metadataStore.upsert({ ...current, archived });
			return { archived, changed: true, threadId };
		});
	}

	async #withThreadCommand<Result>(threadId: string, task: () => Promise<Result>): Promise<Result> {
		if (this.#disposing) {
			throw new EmpatraHostProtocolError("host_disposed", "Empatra host runtime is shutting down");
		}
		const previous = this.#threadCommandTails.get(threadId) ?? Promise.resolve();
		const { promise: current, resolve: release } = Promise.withResolvers<void>();
		const tail = previous.catch(() => undefined).then(() => current);
		this.#threadCommandTails.set(threadId, tail);
		await previous.catch(() => undefined);
		try {
			if (this.#disposing) {
				throw new EmpatraHostProtocolError("host_disposed", "Empatra host runtime is shutting down");
			}
			return await task();
		} finally {
			release();
			if (this.#threadCommandTails.get(threadId) === tail) this.#threadCommandTails.delete(threadId);
		}
	}

	async #withOperationCommand<Result>(operationId: string, task: () => Promise<Result>): Promise<Result> {
		if (this.#disposing) {
			throw new EmpatraHostProtocolError("host_disposed", "Empatra host runtime is shutting down");
		}
		const previous = this.#operationCommandTails.get(operationId) ?? Promise.resolve();
		const { promise: current, resolve: release } = Promise.withResolvers<void>();
		const tail = previous.catch(() => undefined).then(() => current);
		this.#operationCommandTails.set(operationId, tail);
		await previous.catch(() => undefined);
		try {
			if (this.#disposing) {
				throw new EmpatraHostProtocolError("host_disposed", "Empatra host runtime is shutting down");
			}
			return await task();
		} finally {
			release();
			if (this.#operationCommandTails.get(operationId) === tail) this.#operationCommandTails.delete(operationId);
		}
	}

	/**
	 * Applies a controller-requested configuration for the next turn while the
	 * per-thread command queue is held.  The durable host config is written
	 * after the in-memory session accepts the model/prompt, so a rejected model
	 * never changes the persisted thread contract.
	 */
	async #applyTurnConfiguration(handle: ThreadHandle, command: TurnStartCommand): Promise<void> {
		if (command.modelId === undefined && command.systemPrompt === undefined) return;
		const current = findThreadConfig(handle.sessionManager);
		const nextModel = command.modelId === undefined ? handle.model : this.#requireModel(command.modelId);
		const nextSystemPrompt = command.systemPrompt ?? current.systemPrompt;
		const modelChanged = nextModel.id !== current.modelId;
		const promptChanged = nextSystemPrompt !== current.systemPrompt;
		if (!modelChanged && !promptChanged) return;
		if (modelChanged) {
			if (!handle.session.setModelTemporary) {
				throw new EmpatraHostProtocolError("runtime_error", "OMP session cannot switch models");
			}
			await handle.session.setModelTemporary(nextModel, undefined, { ephemeral: true });
		}
		if (promptChanged) {
			if (!handle.session.setBaseSystemPrompt) {
				throw new EmpatraHostProtocolError("runtime_error", "OMP session cannot switch system prompts");
			}
			handle.session.setBaseSystemPrompt([nextSystemPrompt]);
		}
		handle.sessionManager.appendCustomEntry(EMPATRA_THREAD_CONFIG_ENTRY, {
			...(current.approvalMode === undefined ? {} : { approvalMode: current.approvalMode }),
			...(current.mode === undefined ? {} : { mode: current.mode }),
			modelId: nextModel.id,
			operationId: current.operationId,
			systemPrompt: nextSystemPrompt,
			version: EMPATRA_THREAD_CONFIG_VERSION,
		} satisfies PersistedThreadConfig);
		await handle.sessionManager.flush();
		handle.model = nextModel;
		handle.modelContextWindow = nextModel.contextWindow ?? 0;
	}

	#recordThreadMetadata(handle: ThreadHandle, operationId: string, archived: boolean): void {
		const sessionPath = handle.sessionManager.getSessionFile();
		if (!sessionPath) {
			throw new EmpatraHostProtocolError("thread_not_persisted", "OMP thread has no durable session path");
		}
		this.#requireInitialized().metadataStore.upsert({
			archived,
			operationId,
			sessionPath,
			threadId: handle.threadId,
		});
	}

	async #openIdempotentFork(
		session: SessionInfo,
		command: EmpatraHostThreadForkCommand,
	): Promise<{ generation: number; threadId: string }> {
		const requestedCwd = command.cwd ? await this.#requireInitialized().policy.requireCwd(command.cwd) : undefined;
		const state = await this.#registry.open(session.id, () => this.#openThread(session.path));
		this.#assertForkMatches(state.handle.sessionManager, command, requestedCwd);
		const config = findThreadConfig(state.handle.sessionManager);
		this.#configureApprovalMode(state.handle, command.approvalMode ?? config.approvalMode);
		this.#configureMode(state.handle, command.mode ?? config.mode);
		return { generation: state.generation, threadId: state.handle.threadId };
	}

	#assertForkMatches(
		manager: SessionManager,
		command: EmpatraHostThreadForkCommand,
		requestedCwd: string | undefined,
	): void {
		const config = findThreadConfig(manager);
		if (
			config.operationId !== command.operationId ||
			manager.getHeader()?.parentSession !== command.threadId ||
			(command.approvalMode !== undefined &&
				(config.approvalMode ?? DEFAULT_APPROVAL_MODE) !== command.approvalMode) ||
			(command.mode !== undefined && (config.mode ?? "default") !== command.mode) ||
			(requestedCwd !== undefined && path.resolve(manager.getCwd()) !== requestedCwd)
		) {
			throw new EmpatraHostProtocolError(
				"operation_conflict",
				"The operation id is already bound to different fork inputs",
			);
		}
	}

	#assertCreateMatches(manager: SessionManager, command: EmpatraHostThreadCreateCommand, requestedCwd: string): void {
		const config = findThreadConfig(manager);
		if (
			config.operationId !== command.operationId ||
			config.modelId !== command.modelId ||
			config.systemPrompt !== command.systemPrompt ||
			(config.approvalMode ?? DEFAULT_APPROVAL_MODE) !== (command.approvalMode ?? DEFAULT_APPROVAL_MODE) ||
			(config.mode ?? "default") !== (command.mode ?? "default") ||
			path.resolve(manager.getCwd()) !== requestedCwd
		) {
			throw new EmpatraHostProtocolError(
				"operation_conflict",
				"The operation id is already bound to different thread inputs",
			);
		}
	}

	#applyReasoningEffort(handle: ThreadHandle, effort: EmpatraHostReasoningEffort | null): void {
		const allowed = this.#requireInitialized().modelDefinitions.get(handle.model.id)?.reasoningEfforts ?? [];
		if (effort !== null && !allowed.includes(effort)) {
			throw new EmpatraHostProtocolError(
				"reasoning_effort_denied",
				"Reasoning effort is outside the injected model catalog",
			);
		}
		const session = handle.session;
		if (!session.setThinkingLevel) {
			if (effort !== null) {
				throw new EmpatraHostProtocolError(
					"reasoning_effort_unavailable",
					"Session does not support reasoning effort selection",
				);
			}
			return;
		}
		if (effort === null) {
			session.setThinkingLevel(ThinkingLevel.Inherit);
			return;
		}
		session.setThinkingLevel(effort === "none" ? ThinkingLevel.Off : (effort as ThinkingLevel));
	}

	/** Applies a host-approved mode to the current session without persisting it. */
	#configureApprovalMode(handle: ThreadHandle, mode: EmpatraHostApprovalMode | undefined): void {
		handle.settings.override("tools.approvalMode", mode ?? handle.defaultApprovalMode);
	}

	async #openSessionManager(sessionPath: string): Promise<SessionManager> {
		const runtime = this.#requireInitialized();
		const manager = await SessionManager.open(sessionPath, runtime.sessionDirectory, undefined, {
			blobDir: runtime.blobDirectory,
			enableFileBlobGarbageCollection: true,
			initialCwd: runtime.policy.roots[0],
			suppressBreadcrumb: true,
		});
		try {
			await runtime.policy.requireCwd(manager.getCwd());
			return manager;
		} catch (error) {
			await manager.close();
			throw error;
		}
	}

	async #ensureThreadMetadata(session: SessionInfo): Promise<EmpatraHostThreadMetadata> {
		const runtime = this.#requireInitialized();
		const cached = runtime.metadataStore.get(session.id);
		if (cached?.sessionPath === session.path) return cached;
		const manager = await this.#openSessionManager(session.path);
		try {
			const config = findThreadConfig(manager);
			const lifecycle = findThreadLifecycle(manager);
			const metadata = {
				archived: lifecycle.archived,
				operationId: config.operationId,
				sessionPath: session.path,
				threadId: session.id,
			} satisfies EmpatraHostThreadMetadata;
			runtime.metadataStore.upsert(metadata);
			return metadata;
		} finally {
			await manager.close();
		}
	}

	async #indexSessions(sessions: readonly SessionInfo[]): Promise<IndexedThread[]> {
		const indexed: IndexedThread[] = [];
		const concurrency = 8;
		for (let offset = 0; offset < sessions.length; offset += concurrency) {
			const batch = sessions.slice(offset, offset + concurrency);
			indexed.push(
				...(await Promise.all(
					batch.map(async session => ({
						metadata: await this.#ensureThreadMetadata(session),
						session,
					})),
				)),
			);
		}
		return indexed;
	}

	async #createHandle(
		sessionManager: SessionManager,
		model: Model<"openai-responses">,
		systemPrompt: string,
		defaultApprovalMode: EmpatraHostApprovalMode = DEFAULT_APPROVAL_MODE,
	): Promise<ThreadHandle> {
		const runtime = this.#requireInitialized();
		const extensionPaths = await resolveMaterializedExtensions(
			runtime.extensionDescriptors,
			runtime.sessionDirectory,
		);
		const cwd = await runtime.policy.requireCwd(sessionManager.getCwd());
		if (model.contextWindow === null) {
			throw new EmpatraHostProtocolError("model_invalid", "Injected model is missing its context window");
		}
		const settings = Settings.isolated(
			{ "tools.approvalMode": defaultApprovalMode },
			{ agentDir: runtime.agentDir, cwd },
		);
		const session = await this.#sessionFactory({
			agentDir: runtime.agentDir,
			capability: runtime.capability,
			cwd,
			extensionPaths,
			model,
			modelRegistry: runtime.modelRegistry,
			scopedModels: [...runtime.models.values()],
			skills: runtime.skills,
			sessionManager,
			settings,
			systemPrompt,
		});
		const handleRef: { current: ThreadHandle | undefined } = { current: undefined };
		const hostTools = this.#hostToolsConnection.createSession((): EmpatraHostToolScope | undefined => {
			const handle = handleRef.current;
			const activeTurn = handle?.activeTurn;
			if (!handle || !activeTurn?.catalogRevision) return undefined;
			return {
				catalogRevision: activeTurn.catalogRevision,
				generation: activeTurn.generation,
				threadId: handle.threadId,
				turnId: activeTurn.turnId,
			};
		});
		const handle: ThreadHandle = {
			activeTurn: null,
			defaultApprovalMode,
			dispose: async () => {
				handle.unsubscribe();
				hostTools.dispose();
				await session.dispose();
				await handle.eventTail;
				this.#handles.delete(handle);
			},
			eventTail: Promise.resolve(),
			queuedEventBytes: 0,
			session,
			sessionManager,
			settings,
			hostTools,
			model,
			modelContextWindow: model.contextWindow,
			streamAbortStarted: false,
			threadId: sessionManager.getSessionId(),
			unsubscribe: () => undefined,
		};
		handleRef.current = handle;
		try {
			return await this.#withOperationCommand("empatra-host-tools", async () => {
				const catalog = this.#hostToolCatalog;
				if (catalog) {
					const nativeNames = new Set(session.getAllToolNames?.() ?? []);
					if (catalog.tools.some(tool => nativeNames.has(tool.name))) {
						throw new EmpatraHostProtocolError(
							"host_tool_catalog_invalid",
							"Host tool conflicts with a session tool",
						);
					}
					const tools = hostTools.replaceCatalog(catalog.tools, catalog.revision);
					await session.refreshRpcHostTools?.(tools);
				}
				this.#handles.add(handle);
				session.setToolUIContext?.(
					createEmpatraHostInteractionUIContext({
						broker: this.#interactionBroker,
						getScope: () => {
							const activeTurn = handle.activeTurn;
							return activeTurn
								? {
										generation: activeTurn.generation,
										threadId: handle.threadId,
										turnId: activeTurn.turnId,
									}
								: undefined;
						},
					}),
					true,
				);
				handle.unsubscribe = session.subscribe(event => this.#forwardSessionEvent(handle, event));
				return handle;
			});
		} catch (error) {
			hostTools.dispose();
			await session.dispose();
			throw error;
		}
	}

	async #emitInteractionRequest(request: EmpatraHostInteractionRequest): Promise<void> {
		const state = this.#registry.get(request.threadId);
		const activeTurn = state?.handle.activeTurn;
		if (
			!state ||
			state.generation !== request.generation ||
			state.activeTurnId !== request.turnId ||
			!activeTurn ||
			!activeTurn.acceptingEvents ||
			activeTurn.generation !== request.generation ||
			activeTurn.turnId !== request.turnId
		) {
			throw new EmpatraHostProtocolError("stale_turn", "Interaction request does not match the active turn");
		}
		activeTurn.sequence += 1;
		await this.#enqueueEvent(state.handle, {
			event: "interaction_requested",
			generation: activeTurn.generation,
			request,
			sequence: activeTurn.sequence,
			threadId: request.threadId,
			turnId: request.turnId,
			type: "host_event",
		});
	}

	async #handlePlanProposal(handle: ThreadHandle, title: string) {
		const activeTurn = handle.activeTurn;
		if (
			!activeTurn?.acceptingEvents ||
			!handle.session.preparePlanForReview ||
			!handle.session.readPlanFile ||
			!handle.session.getPlanModeState
		) {
			throw new EmpatraHostProtocolError("plan_not_supported", "OMP plan proposal lifecycle is unavailable");
		}
		const review = await handle.session.preparePlanForReview(title);
		const details = planDetails(review.details);
		const planContent = await handle.session.readPlanFile(details.planFilePath);
		if (planContent === null) {
			throw new EmpatraHostProtocolError("plan_not_supported", "OMP plan artifact is unavailable");
		}
		const requestId = `plan-${Bun.randomUUIDv7()}`;
		const summary = details.title;
		const digest = planProposalDigest(planContent);
		const {
			promise: resolutionPromise,
			resolve: resolveResolution,
			reject: rejectResolution,
		} = Promise.withResolvers<EmpatraHostPlanResolutionCommand>();
		this.#pendingPlanResolutions.set(requestId, {
			digest,
			generation: activeTurn.generation,
			reject: rejectResolution,
			resolve: resolveResolution,
			requestId,
			threadId: handle.threadId,
			turnId: activeTurn.turnId,
		});
		activeTurn.sequence += 1;
		try {
			await this.#enqueueEvent(handle, {
				digest,
				event: "plan_proposal",
				generation: activeTurn.generation,
				planText: planContent,
				requestId,
				sequence: activeTurn.sequence,
				summary,
				threadId: handle.threadId,
				turnId: activeTurn.turnId,
				type: "host_event",
			});
			const resolution = await resolutionPromise;
			if (resolution.action === "approve") {
				handle.session.setPlanReferencePath?.(details.planFilePath);
				handle.session.setPlanProposalHandler?.(null);
				handle.session.setPlanModeState?.(undefined);
				return {
					content: [{ type: "text" as const, text: "Plan approved; continue with implementation." }],
					details,
				};
			}
			if (resolution.action === "revise") {
				const state = handle.session.getPlanModeState();
				if (state?.enabled && state.planFilePath !== details.planFilePath && handle.session.setPlanModeState) {
					handle.session.setPlanModeState({ ...state, planFilePath: details.planFilePath });
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Plan revision requested${resolution.feedback ? `: ${resolution.feedback}` : "."} Update the plan and propose it again.`,
						},
					],
					details,
				};
			}
			handle.session.setPlanProposalHandler?.(null);
			handle.session.setPlanModeState?.(undefined);
			return { content: [{ type: "text" as const, text: "Plan dismissed; return to the caller." }], details };
		} finally {
			this.#pendingPlanResolutions.delete(requestId);
		}
	}

	#configureMode(handle: ThreadHandle, mode: EmpatraHostMode | undefined): void {
		if (mode === undefined) return;
		if (mode !== "plan") {
			handle.session.setPlanProposalHandler?.(null);
			handle.session.setPlanModeState?.(undefined);
			return;
		}
		if (!handle.session.setPlanModeState || !handle.session.setPlanProposalHandler) {
			throw new EmpatraHostProtocolError("plan_not_supported", "OMP plan mode is unavailable for this session");
		}
		const previous = handle.session.getPlanModeState?.();
		handle.session.setPlanModeState({
			enabled: true,
			planFilePath: previous?.planFilePath ?? "local://PLAN.md",
			workflow: previous?.workflow ?? "parallel",
			reentry: previous !== undefined,
		});
		handle.session.setPlanProposalHandler(title => this.#handlePlanProposal(handle, title));
	}

	#forwardSessionEvent(handle: ThreadHandle, event: AgentSessionEvent): void {
		const activeTurn = handle.activeTurn;
		if (!activeTurn?.acceptingEvents) return;
		if (
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end"
		) {
			this.#forwardToolEvent(handle, event);
			return;
		}
		if (event.type === "message_start" && event.message.role === "assistant") {
			if (
				activeTurn.activeAssistantMessageIndex !== null ||
				activeTurn.assistantMessageCount >= EMPATRA_HOST_MAX_ASSISTANT_MESSAGES_PER_TURN
			) {
				this.#failTurnEventStream(handle, "Assistant message lifecycle is invalid");
				return;
			}
			activeTurn.activeAssistantMessageIndex = activeTurn.assistantMessageCount;
			activeTurn.activeReasoningContentIndexes.clear();
			activeTurn.assistantMessageCount += 1;
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const messageIndex = activeTurn.activeAssistantMessageIndex;
			if (messageIndex === null) {
				this.#failTurnEventStream(handle, "Assistant message lifecycle is invalid");
				return;
			}
			activeTurn.activeAssistantMessageIndex = null;
			activeTurn.activeReasoningContentIndexes.clear();
			if (!hasTrustworthyEmpatraHostAssistantUsage(event.message as AssistantMessage)) return;
			if (activeTurn.usageUpdateCount >= EMPATRA_HOST_MAX_ASSISTANT_MESSAGES_PER_TURN) {
				this.#failTurnEventStream(handle, "Assistant message lifecycle is invalid");
				return;
			}
			try {
				activeTurn.usageObservations.push(
					observeEmpatraHostAssistantUsage(event.message as AssistantMessage, activeTurn.turnId),
				);
				const contextUsage = projectEmpatraHostContextUsage(
					handle.sessionManager.getBranch(activeTurn.usageBaseLeafId),
					handle.modelContextWindow,
					activeTurn.usageObservations,
				);
				activeTurn.usageUpdateCount += 1;
				activeTurn.sequence += 1;
				void this.#enqueueEvent(handle, {
					contextUsage,
					event: "turn_usage_updated",
					generation: activeTurn.generation,
					messageIndex,
					sequence: activeTurn.sequence,
					threadId: handle.threadId,
					turnId: activeTurn.turnId,
					type: "host_event",
				}).catch(() => undefined);
			} catch {
				this.#failTurnEventStream(handle, "Assistant usage is invalid");
			}
			return;
		}
		if (event.type !== "message_update") return;
		const update = event.assistantMessageEvent;
		if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
		const messageIndex = activeTurn.activeAssistantMessageIndex;
		if (
			messageIndex === null ||
			!Number.isSafeInteger(update.contentIndex) ||
			update.contentIndex < 0 ||
			update.contentIndex > EMPATRA_HOST_MAX_CONTENT_INDEX
		) {
			this.#failTurnEventStream(handle, "Assistant output identity is invalid");
			return;
		}
		let contentIndex = update.contentIndex;
		if (update.type === "thinking_delta") {
			const existing = activeTurn.activeReasoningContentIndexes.get(update.contentIndex);
			if (existing === undefined) {
				contentIndex = activeTurn.activeReasoningContentIndexes.size;
				if (contentIndex > EMPATRA_HOST_MAX_CONTENT_INDEX) {
					this.#failTurnEventStream(handle, "Assistant reasoning identity is invalid");
					return;
				}
				activeTurn.activeReasoningContentIndexes.set(update.contentIndex, contentIndex);
			} else {
				contentIndex = existing;
			}
		}
		for (const delta of utf8Chunks(update.delta, MAX_STREAM_EVENT_BYTES - 2048)) {
			activeTurn.sequence += 1;
			const output: EmpatraHostEvent = {
				contentIndex,
				delta,
				event: "turn_output",
				generation: activeTurn.generation,
				kind: update.type,
				messageIndex,
				sequence: activeTurn.sequence,
				threadId: handle.threadId,
				turnId: activeTurn.turnId,
				type: "host_event",
			};
			void this.#enqueueEvent(handle, output).catch(() => undefined);
		}
	}

	#forwardToolEvent(
		handle: ThreadHandle,
		event: Extract<
			AgentSessionEvent,
			{ type: "tool_execution_end" | "tool_execution_start" | "tool_execution_update" }
		>,
		allowTerminalClose = false,
	): void {
		const activeTurn = handle.activeTurn;
		if (
			!activeTurn ||
			handle.streamFailure ||
			(!allowTerminalClose && (!activeTurn.acceptingEvents || activeTurn.toolFailure))
		)
			return;
		const existing = activeTurn.openTools.get(event.toolCallId);
		if (event.type === "tool_execution_start" ? existing !== undefined : existing === undefined) {
			this.#failToolStream(handle);
			return;
		}
		if (existing && existing.startPayload.toolName !== event.toolName) {
			this.#failToolStream(handle);
			return;
		}
		try {
			const projected = projectEmpatraHostToolEvent(event, {
				...(existing ? { previousOutputText: existing.outputText, startPayload: existing.startPayload } : {}),
				workspaceRoots: this.#requireInitialized().policy.roots,
			});
			activeTurn.sequence += 1;
			const persisted = {
				generation: activeTurn.generation,
				payload: projected.payload,
				sequence: activeTurn.sequence,
				turnId: activeTurn.turnId,
				version: EMPATRA_HOST_TOOL_ENTRY_VERSION,
			} satisfies EmpatraHostPersistedToolEvent;
			handle.sessionManager.appendCustomEntry(EMPATRA_HOST_TOOL_ENTRY, persisted);
			if (projected.payload.phase === "start") {
				activeTurn.openTools.set(event.toolCallId, {
					outputText: projected.outputText,
					startPayload: projected.payload,
				});
			} else if (projected.payload.phase === "update" && existing) {
				activeTurn.openTools.set(event.toolCallId, { ...existing, outputText: projected.outputText });
			} else {
				activeTurn.openTools.delete(event.toolCallId);
			}
			const base = {
				generation: activeTurn.generation,
				sequence: activeTurn.sequence,
				threadId: handle.threadId,
				turnId: activeTurn.turnId,
				type: "host_event" as const,
			};
			const output: EmpatraHostEvent =
				projected.payload.phase === "start"
					? {
							...base,
							argumentsText: projected.payload.argumentsText,
							argumentsTruncated: projected.payload.argumentsTruncated,
							event: "tool_execution_start",
							toolCallId: projected.payload.toolCallId,
							toolName: projected.payload.toolName,
						}
					: projected.payload.phase === "update"
						? {
								...base,
								event: "tool_execution_update",
								toolCallId: projected.payload.toolCallId,
								toolName: projected.payload.toolName,
								update: projected.payload.update,
							}
						: {
								...base,
								argumentsText: projected.payload.argumentsText,
								argumentsTruncated: projected.payload.argumentsTruncated,
								event: "tool_execution_end",
								failed: projected.payload.failed,
								resultText: projected.payload.resultText,
								resultTruncated: projected.payload.resultTruncated,
								toolCallId: projected.payload.toolCallId,
								toolName: projected.payload.toolName,
							};
			void this.#enqueueEvent(handle, output).catch(() => undefined);
		} catch {
			this.#failToolStream(handle);
		}
	}

	#closeDanglingTools(handle: ThreadHandle): void {
		const activeTurn = handle.activeTurn;
		if (!activeTurn || activeTurn.openTools.size === 0) return;
		for (const [toolCallId, tool] of activeTurn.openTools) {
			this.#forwardToolEvent(
				handle,
				{
					isError: true,
					result: { content: [{ text: "Tool execution ended without a terminal result", type: "text" }] },
					toolCallId,
					toolName: tool.startPayload.toolName,
					type: "tool_execution_end",
				},
				true,
			);
		}
		if (!activeTurn.toolFailure) {
			activeTurn.toolFailure = new EmpatraHostProtocolError("turn_state_corrupt", "Tool execution remained open");
		}
	}

	#failToolStream(handle: ThreadHandle): void {
		this.#failTurnEventStream(handle, "Tool execution lifecycle is invalid");
	}

	#failTurnEventStream(handle: ThreadHandle, message: string): void {
		const activeTurn = handle.activeTurn;
		if (activeTurn && !activeTurn.toolFailure) {
			activeTurn.toolFailure = new EmpatraHostProtocolError("turn_state_corrupt", message);
		}
		if (!handle.streamAbortStarted) {
			handle.streamAbortStarted = true;
			void handle.session
				.abort({ goalReason: "internal", reason: "Empatra host event lifecycle invalid" })
				.catch(() => undefined);
		}
	}

	#enqueueEvent(handle: ThreadHandle, event: EmpatraHostEvent): Promise<void> {
		if (handle.streamFailure) return Promise.reject(handle.streamFailure);
		const bytes = eventEncoder.encode(JSON.stringify(event)).byteLength;
		const maxEventBytes = event.event === "plan_proposal" ? MAX_PLAN_PROPOSAL_EVENT_BYTES : MAX_STREAM_EVENT_BYTES;
		if (bytes > maxEventBytes) {
			handle.streamFailure = new EmpatraHostProtocolError("event_backpressure", "Empatra host event is too large");
			this.#failToolStream(handle);
			return Promise.reject(handle.streamFailure);
		}
		if (handle.queuedEventBytes + bytes > MAX_QUEUED_EVENT_BYTES) {
			handle.streamFailure = new EmpatraHostProtocolError(
				"event_backpressure",
				"Empatra host event queue exceeded its memory limit",
			);
			if (!handle.streamAbortStarted) {
				handle.streamAbortStarted = true;
				void handle.session
					.abort({ goalReason: "internal", reason: "Empatra host output backpressure" })
					.catch(() => undefined);
			}
			return Promise.reject(handle.streamFailure);
		}
		handle.queuedEventBytes += bytes;
		const delivery = handle.eventTail.then(() => this.#eventSink(event));
		handle.eventTail = delivery
			.catch(error => {
				handle.streamFailure = error instanceof Error ? error : new Error(String(error));
				if (!handle.streamAbortStarted) {
					handle.streamAbortStarted = true;
					void handle.session
						.abort({ goalReason: "internal", reason: "Empatra host event delivery failed" })
						.catch(() => undefined);
				}
			})
			.finally(() => {
				handle.queuedEventBytes -= bytes;
			});
		return delivery;
	}

	async #openThread(filePath: string): Promise<ThreadHandle> {
		const sessionManager = await this.#openSessionManager(filePath);
		try {
			await recoverInterruptedToolExecutions(sessionManager);
			const config = findThreadConfig(sessionManager);
			return await this.#createHandle(
				sessionManager,
				this.#requireModel(config.modelId),
				config.systemPrompt,
				config.approvalMode,
			);
		} catch (error) {
			await sessionManager.close();
			throw error;
		}
	}

	async #listAuthorizedSessions() {
		const runtime = this.#requireInitialized();
		const sessions = await SessionManager.list(runtime.policy.roots[0], runtime.sessionDirectory);
		return sessions.filter(session => runtime.policy.containsLexically(session.cwd));
	}

	async #findThread(threadId: string) {
		const session = (await this.#listAuthorizedSessions()).find(candidate => candidate.id === threadId);
		if (!session) throw new EmpatraHostProtocolError("thread_not_found", "Thread does not exist in this host");
		return session;
	}

	async #findThreadByOperation(operationId: string): Promise<SessionInfo | undefined> {
		const runtime = this.#requireInitialized();
		const sessions = await this.#listAuthorizedSessions();
		const indexed = runtime.metadataStore.findByOperation(operationId);
		if (indexed) {
			const session = sessions.find(
				candidate => candidate.id === indexed.threadId && candidate.path === indexed.sessionPath,
			);
			if (session) return session;
			runtime.metadataStore.delete(indexed.threadId);
		}
		for (const session of sessions) {
			const manager = await this.#openSessionManager(session.path);
			try {
				const config = findThreadConfig(manager);
				if (config.operationId !== operationId) continue;
				runtime.metadataStore.upsert({
					archived: findThreadLifecycle(manager).archived,
					operationId,
					sessionPath: session.path,
					threadId: session.id,
				});
				return session;
			} catch (error) {
				if (!(error instanceof EmpatraHostProtocolError) || error.code !== "thread_config_missing") throw error;
			} finally {
				await manager.close();
			}
		}
		return undefined;
	}
}
