import * as path from "node:path";

import { EmpatraHostProtocolError, EmpatraHostRegistryError } from "./errors";
import type {
	EmpatraHostApprovalResponse,
	EmpatraHostInteractionExpiredEvent,
	EmpatraHostInteractionRequest,
	EmpatraHostUserInputResponse,
} from "./interaction-broker";
import {
	type EmpatraHostExecutionBrokerRequestEvent,
	type EmpatraHostExecutionBrokerResponseCommand,
	parseEmpatraHostExecutionBrokerRequestEvent,
	parseEmpatraHostExecutionBrokerResponse,
} from "./execution-broker";
import {
	parseEmpatraHostImageGenerationRequestedEvent,
	parseEmpatraHostImageGenerationResponseCommand,
	parseEmpatraHostImageGenerationEvent,
	type EmpatraHostImageGenerationRequestedEvent,
	type EmpatraHostImageGenerationResponseCommand,
	type EmpatraHostImageGenerationEvent,
} from "./image-generation";
import {
	parseEmpatraHostMcpOAuthRequestedEvent,
	parseEmpatraHostMcpOAuthResponseCommand,
	type EmpatraHostMcpOAuthRequestedEvent,
	type EmpatraHostMcpOAuthResponseCommand,
} from "./mcp-oauth-broker";
import {
	parseEmpatraHostResourcesRequestedEvent,
	parseEmpatraHostResourcesResponseCommand,
	type EmpatraHostResourcesRequestedEvent,
	type EmpatraHostResourcesResponseCommand,
} from "./resources";
import {
	EMPATRA_HOST_SUBAGENT_CAPABILITY,
	parseEmpatraHostSubagentCommand,
	parseEmpatraHostSubagentEvent,
	parseEmpatraHostSubagentRequestEvent,
	parseEmpatraHostSubagentResponse,
	type EmpatraHostSubagentCommand,
	type EmpatraHostSubagentEvent,
	type EmpatraHostSubagentRequestEvent,
	type EmpatraHostSubagentRpcBootstrap,
	type EmpatraHostSubagentResponseCommand,
} from "./subagent-broker";
import {
	EMPATRA_HOST_MODEL_ROUTING_CAPABILITY,
	parseEmpatraHostModelRoutingReadCommand,
	parseEmpatraHostModelRoutingSnapshot,
	parseEmpatraHostModelRoutingWriteCommand,
	type EmpatraHostModelRoutingReadCommand,
	type EmpatraHostModelRoutingSnapshot,
	type EmpatraHostModelRoutingWriteCommand,
} from "./model-routing";
import {
	parseEmpatraHostAgentCatalog,
	type EmpatraHostAgentCatalog,
} from "./agent-catalog";

export const EMPATRA_HOST_PROTOCOL_VERSION = 6 as const;
export const EMPATRA_HOST_MAX_FRAME_BYTES = 1024 * 1024;
export const EMPATRA_HOST_MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
export const EMPATRA_HOST_MAX_MODELS = 1024;
export const EMPATRA_HOST_MAX_WORKSPACE_ROOTS = 128;
export const EMPATRA_HOST_MAX_SKILLS = 256;
export const EMPATRA_HOST_MAX_SKILL_NAME_BYTES = 128;
export const EMPATRA_HOST_MAX_SKILL_DESCRIPTION_BYTES = 8192;
export const EMPATRA_HOST_MAX_SKILL_SOURCE_BYTES = 128;
export const EMPATRA_HOST_MAX_HOST_TOOLS = 256;
export const EMPATRA_HOST_MAX_EXTENSIONS = 32;
export const EMPATRA_HOST_MAX_HOST_TOOL_ARGUMENT_BYTES = 256 * 1024;
export const EMPATRA_HOST_MAX_HOST_TOOL_RESULT_BYTES = 512 * 1024;
export const EMPATRA_HOST_MAX_ASSISTANT_MESSAGES_PER_TURN = 256;
export const EMPATRA_HOST_MAX_CONTENT_INDEX = 4095;
export const EMPATRA_HOST_MAX_IMAGES = 16;
export const EMPATRA_HOST_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const EMPATRA_HOST_MAX_IMAGE_BYTES_TOTAL = 64 * 1024 * 1024;
export const EMPATRA_HOST_MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
export const EMPATRA_HOST_MAX_PLAN_CONTENT_BYTES = 512 * 1024;
export const EMPATRA_HOST_MAX_PLAN_SUMMARY_BYTES = 4 * 1024;
export const EMPATRA_HOST_THREAD_READ_TARGET_BYTES = 896 * 1024;
/**
 * Versioned, product-owned contracts implemented by the isolated OMP host.
 *
 * Keep each version in the capability name: a controller must be able to
 * fail closed when a future wire shape changes.  This catalog deliberately
 * contains only contracts backed by the host's main-owned boundary.  In
 * particular, unrestricted execution and ambient OMP extension surfaces are
 * not capabilities of this host.
 */
export const EMPATRA_HOST_ATOMIC_THREAD_LIFECYCLE_CAPABILITY = "thread_lifecycle.atomic-v1" as const;
export const EMPATRA_HOST_NATIVE_PLAN_CAPABILITY = "plan.native-v1" as const;
export const EMPATRA_HOST_SCOPED_APPROVAL_CAPABILITY = "approval.scoped-v1" as const;
/** Bounded user feedback is carried with a denied/approved interaction response. */
export const EMPATRA_HOST_APPROVAL_FEEDBACK_CAPABILITY = "approval.feedback-v1" as const;
export const EMPATRA_HOST_DYNAMIC_TOOLS_CAPABILITY = "host_tools.dynamic-v1" as const;
/** Inline host-tool catalog admission for atomic lifecycle and turn start. */
export const EMPATRA_HOST_INLINE_TOOL_CATALOG_CAPABILITY = "host_tools.inline-v1" as const;
export const EMPATRA_HOST_IMAGE_INPUT_CAPABILITY = "images.input-v1" as const;
export const EMPATRA_HOST_THREAD_GOALS_CAPABILITY = "goals.thread-v1" as const;
export const EMPATRA_HOST_THREAD_READ_TURNS_V2_CAPABILITY = "thread_read.turns-v2" as const;
/** Explicit, hash-bound lifecycle extensions only; ambient discovery remains disabled. */
export const EMPATRA_HOST_EXPLICIT_EXTENSIONS_CAPABILITY = "extensions.explicit-v1" as const;
/** Per-turn model and system-prompt changes, committed by the host before dispatch. */
export const EMPATRA_HOST_TURN_CONFIGURATION_CAPABILITY = "turn_configuration.v1" as const;
/**
 * Strict image-generation DTO contract. It is not advertised until Electron
 * wires a main-owned provider executor; OMP must never resolve credentials or
 * use a sidecar-local provider as a fallback.
 */
export const EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY = "images.generation-v1" as const;
/** Lossless bounded JSONL chunking for logical frames above the physical ceiling. */
export const EMPATRA_HOST_FRAMING_CAPABILITY = "framing.chunked.v1" as const;
/**
 * Reserved for an Electron-main-owned filesystem/process broker. It is not
 * advertised in `EMPATRA_HOST_CAPABILITIES` until a platform adapter and its
 * approval/sandbox gates are wired end to end.
 */
export const EMPATRA_HOST_EXECUTION_BROKER_CAPABILITY = "execution_broker.v1" as const;
/** Main-owned MCP OAuth initiation; credentials never cross the host boundary. */
export const EMPATRA_HOST_MCP_OAUTH_CAPABILITY = "mcp.oauth.main-owned-v1" as const;
/** Main-owned resource catalog/read lane; config and credentials never cross the host boundary. */
export const EMPATRA_HOST_RESOURCES_CAPABILITY = "resources.main-owned-v1" as const;
/** Main-mediated OMP model role and task override settings. */
export { EMPATRA_HOST_MODEL_ROUTING_CAPABILITY } from "./model-routing";
export const EMPATRA_HOST_CAPABILITIES = [
	EMPATRA_HOST_ATOMIC_THREAD_LIFECYCLE_CAPABILITY,
	EMPATRA_HOST_NATIVE_PLAN_CAPABILITY,
	EMPATRA_HOST_SCOPED_APPROVAL_CAPABILITY,
	EMPATRA_HOST_APPROVAL_FEEDBACK_CAPABILITY,
	EMPATRA_HOST_DYNAMIC_TOOLS_CAPABILITY,
	EMPATRA_HOST_INLINE_TOOL_CATALOG_CAPABILITY,
	EMPATRA_HOST_IMAGE_INPUT_CAPABILITY,
	EMPATRA_HOST_THREAD_GOALS_CAPABILITY,
	EMPATRA_HOST_THREAD_READ_TURNS_V2_CAPABILITY,
	EMPATRA_HOST_EXPLICIT_EXTENSIONS_CAPABILITY,
	EMPATRA_HOST_TURN_CONFIGURATION_CAPABILITY,
	EMPATRA_HOST_IMAGE_GENERATION_CAPABILITY,
	EMPATRA_HOST_MODEL_ROUTING_CAPABILITY,
] as const;
export type EmpatraHostCapability = (typeof EMPATRA_HOST_CAPABILITIES)[number];
export type EmpatraHostAdvertisedCapability =
	| EmpatraHostCapability
	| typeof EMPATRA_HOST_SUBAGENT_CAPABILITY
	| typeof EMPATRA_HOST_FRAMING_CAPABILITY
	| typeof EMPATRA_HOST_MCP_OAUTH_CAPABILITY
	| typeof EMPATRA_HOST_RESOURCES_CAPABILITY
	| typeof EMPATRA_HOST_EXECUTION_BROKER_CAPABILITY
	| typeof EMPATRA_HOST_MODEL_ROUTING_CAPABILITY;
const EMPATRA_HOST_CAPABILITY_SET = new Set<string>(EMPATRA_HOST_CAPABILITIES);
const EMPATRA_HOST_ADVERTISED_CAPABILITY_SET = new Set<string>([
	...EMPATRA_HOST_CAPABILITIES,
	EMPATRA_HOST_SUBAGENT_CAPABILITY,
	EMPATRA_HOST_FRAMING_CAPABILITY,
	EMPATRA_HOST_MCP_OAUTH_CAPABILITY,
	EMPATRA_HOST_RESOURCES_CAPABILITY,
	EMPATRA_HOST_EXECUTION_BROKER_CAPABILITY,
	EMPATRA_HOST_MODEL_ROUTING_CAPABILITY,
]);

const textEncoder = new TextEncoder();
const CONTROL_CHARACTER = /\p{Cc}/u;
const DISPLAY_NAME_SEPARATOR = /[\\/]+/u;

export interface EmpatraHostModel {
	api: "openai-responses";
	contextWindow: number;
	id: string;
	input: ("image" | "text")[];
	maxTokens: number;
	name: string;
	reasoning: boolean;
	reasoningEfforts?: EmpatraHostReasoningEffort[];
	supportsTools: boolean;
}

/**
 * A main-process materialized skill. The host accepts only paths under the
 * private session directory; it never discovers arbitrary user directories.
 */
export interface EmpatraHostSkill {
	baseDir: string;
	description: string;
	filePath: string;
	hide?: boolean;
	name: string;
	source: string;
}

/**
 * Main-owned extension module staged under the private host session directory.
 * The digest makes the module identity explicit across the process boundary;
 * the host still canonicalizes and confines the path before loading it.
 */
export interface EmpatraHostExtensionDescriptor {
	filePath: string;
	id: string;
	sha256: string;
}

/**
 * Product-owned, explicit subset of OMP thinking selectors. `none` maps to
 * OMP's `off`; the host intentionally does not accept ambient OMP selectors.
 */
export type EmpatraHostReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Host-owned approval modes exposed to Empatra Studio.
 *
 * The host deliberately omits OMP's `write` mode: Studio currently exposes
 * only a workspace-write/on-request policy and a full-access/never policy.
 * Mapping those policies to this closed union keeps the trust boundary
 * explicit and prevents a controller from smuggling sandbox semantics into
 * the OMP process.
 */
export type EmpatraHostApprovalMode = "always-ask" | "yolo";

/** Explicit host-owned execution mode with a typed proposal/resolution lifecycle. */
export type EmpatraHostMode = "default" | "plan";

export type EmpatraHostImageMimeType = "image/gif" | "image/jpeg" | "image/png" | "image/webp";

export interface EmpatraHostImageDescriptor {
	byteLength: number;
	detail?: "auto" | "high" | "low";
	displayName?: string;
	mimeType: EmpatraHostImageMimeType;
	sha256: string;
}

export interface EmpatraHostProjectedImageBlock {
	blockType: "image";
	byteLength: number;
	detail?: "auto" | "high" | "low";
	displayName: string;
	heightPixels?: number;
	mimeType: EmpatraHostImageMimeType;
	sha256: string;
	widthPixels?: number;
}

export function sanitizeEmpatraHostImageDisplayName(value: string): string {
	const leaf =
		value
			.normalize("NFKC")
			.replaceAll(/\p{C}+/gu, " ")
			.split(DISPLAY_NAME_SEPARATOR)
			.at(-1)
			?.trim() ?? "";
	const sanitized = leaf.replaceAll(/\s+/gu, " ").slice(0, 160).trim();
	return sanitized === "" || sanitized === "." || sanitized === ".." ? "Изображение" : sanitized;
}

export interface EmpatraHostInitializeCommand {
	/** Optional explicit OMP task-agent metadata, accepted only with subagent RPC. */
	agentCatalog?: EmpatraHostAgentCatalog;
	capability: string;
	extensions?: EmpatraHostExtensionDescriptor[];
	gatewayBaseUrl: string;
	id: string;
	/** Optional main-owned model-routing snapshot; omitted means empty maps. */
	modelRouting?: EmpatraHostModelRoutingSnapshot;
	models: EmpatraHostModel[];
	skills?: EmpatraHostSkill[];
	protocolVersion: typeof EMPATRA_HOST_PROTOCOL_VERSION;
	sessionDirectory: string;
	subagentRpc?: EmpatraHostSubagentRpcBootstrap;
	type: "host_initialize";
	workspaceRoots: string[];
}

export interface EmpatraHostThreadCreateCommand {
	approvalMode?: EmpatraHostApprovalMode;
	cwd: string;
	id: string;
	modelId: string;
	mode?: EmpatraHostMode;
	operationId: string;
	systemPrompt: string;
	type: "thread_create";
}

export interface EmpatraHostThreadCreateAndStartCommand extends Omit<EmpatraHostThreadCreateCommand, "type"> {
	hostTools?: EmpatraHostToolCatalog;
	images?: EmpatraHostImageDescriptor[];
	message: string;
	reasoningEffort?: EmpatraHostReasoningEffort | null;
	turnId: string;
	type: "thread_create_and_start";
}

export interface EmpatraHostThreadForkCommand {
	approvalMode?: EmpatraHostApprovalMode;
	cwd?: string;
	id: string;
	mode?: EmpatraHostMode;
	operationId: string;
	threadId: string;
	type: "thread_fork";
}

export interface EmpatraHostThreadForkAndStartCommand extends Omit<EmpatraHostThreadForkCommand, "type"> {
	hostTools?: EmpatraHostToolCatalog;
	images?: EmpatraHostImageDescriptor[];
	message: string;
	reasoningEffort?: EmpatraHostReasoningEffort | null;
	turnId: string;
	type: "thread_fork_and_start";
}

export interface EmpatraHostThreadRollbackCommand {
	id: string;
	threadId: string;
	turns: number;
	type: "thread_rollback";
}

export interface EmpatraHostThreadCompactCommand {
	id: string;
	threadId: string;
	type: "thread_compact";
}

export interface EmpatraHostThreadReadCommand {
	cursor?: string;
	id: string;
	limit: number;
	/**
	 * Opts into turn-aligned, newest-first pagination. Omitting this field
	 * preserves the legacy message-offset contract for older controllers.
	 */
	pagination?: "turns-v2";
	threadId: string;
	type: "thread_read";
}

export interface EmpatraHostToolDefinition {
	description: string;
	hidden?: boolean;
	label?: string;
	loadMode?: "discoverable" | "essential";
	name: string;
	parameters: Record<string, unknown>;
}

export interface EmpatraHostToolCatalog {
	catalogRevision: string;
	tools: EmpatraHostToolDefinition[];
}

export interface EmpatraHostToolsReplaceCommand {
	catalogRevision: string;
	expectedGeneration?: number;
	id: string;
	threadId?: string;
	tools: EmpatraHostToolDefinition[];
	type: "host_tools_replace";
}

export type EmpatraHostToolResultContent =
	| Readonly<{ text: string; type: "text" }>
	| Readonly<{ data: string; mimeType: string; type: "image" }>;

export interface EmpatraHostToolResultValue {
	content: EmpatraHostToolResultContent[];
	details?: unknown;
}

interface EmpatraHostToolCorrelation {
	catalogRevision: string;
	generation: number;
	id: string;
	threadId: string;
	turnId: string;
}

export interface EmpatraHostToolResultFrame extends EmpatraHostToolCorrelation {
	failed: boolean;
	result: EmpatraHostToolResultValue;
	type: "host_tool_result";
}

export interface EmpatraHostToolCancelFrame extends EmpatraHostToolCorrelation {
	targetId: string;
	type: "host_tool_cancel";
}

export interface EmpatraHostToolCallFrame extends EmpatraHostToolCorrelation {
	arguments: Record<string, unknown>;
	toolCallId: string;
	toolName: string;
	type: "host_tool_call";
}

export type EmpatraHostToolOutboundFrame = EmpatraHostToolCallFrame | EmpatraHostToolCancelFrame;

export type EmpatraHostTurnStatus = "completed" | "failed" | "interrupted" | "running";

export interface EmpatraHostTurnSummary {
	completedAt?: number;
	durationMs?: number;
	id: string;
	itemCount: number;
	startedAt?: number;
	status: EmpatraHostTurnStatus;
}

export interface EmpatraHostThreadTurnsCommand {
	cursor?: string;
	id: string;
	limit: number;
	sortDirection?: "asc" | "desc";
	threadId: string;
	type: "thread_turns";
}

/**
 * Read-only reconciliation query for a previously submitted atomic operation.
 * This command is additive within protocol v6; it never resumes or replays the
 * operation and carries no request payload beyond its opaque operation id.
 */
export interface EmpatraHostAtomicOperationStatusCommand {
	id: string;
	operationId: string;
	type: "atomic_operation_status";
}

export type EmpatraHostGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export interface EmpatraHostThreadGoal {
	createdAt: number;
	objective: string;
	status: EmpatraHostGoalStatus;
	threadId: string;
	timeUsedSeconds: number;
	tokenBudget: number | null;
	tokensUsed: number;
	updatedAt: number;
}

export interface EmpatraHostGoalGetCommand {
	id: string;
	threadId: string;
	type: "goal_get";
}

export interface EmpatraHostGoalSetCommand {
	id: string;
	objective?: string | null;
	status?: EmpatraHostGoalStatus | null;
	threadId: string;
	tokenBudget?: number | null;
	type: "goal_set";
}

export interface EmpatraHostGoalClearCommand {
	id: string;
	threadId: string;
	type: "goal_clear";
}

export interface EmpatraHostThreadListCommand {
	archived?: boolean;
	id: string;
	limit: number;
	offset: number;
	searchTerm?: string;
	type: "thread_list";
}

export interface EmpatraHostThreadArchiveCommand {
	id: string;
	threadId: string;
	type: "thread_archive";
}

export interface EmpatraHostThreadUnarchiveCommand {
	id: string;
	threadId: string;
	type: "thread_unarchive";
}

export interface EmpatraHostThreadDeleteCommand {
	id: string;
	threadId: string;
	type: "thread_delete";
}

export interface EmpatraHostThreadRenameCommand {
	id: string;
	threadId: string;
	title: string;
	type: "thread_rename";
}

export interface EmpatraHostTurnStartCommand {
	approvalMode?: EmpatraHostApprovalMode;
	expectedGeneration: number;
	hostTools?: EmpatraHostToolCatalog;
	id: string;
	images?: EmpatraHostImageDescriptor[];
	message: string;
	mode?: EmpatraHostMode;
	/** Optional next-turn model; omitted means keep the persisted model. */
	modelId?: string;
	reasoningEffort?: EmpatraHostReasoningEffort | null;
	/** Optional next-turn system prompt; omitted means keep the persisted prompt. */
	systemPrompt?: string;
	threadId: string;
	turnId: string;
	type: "turn_start";
}

export interface EmpatraHostTurnInterruptCommand {
	expectedGeneration: number;
	id: string;
	threadId: string;
	turnId: string;
	type: "turn_interrupt";
}

export interface EmpatraHostTurnSteerCommand {
	approvalMode?: EmpatraHostApprovalMode;
	expectedGeneration: number;
	id: string;
	images?: EmpatraHostImageDescriptor[];
	message: string;
	mode?: EmpatraHostMode;
	threadId: string;
	turnId: string;
	type: "turn_steer";
}

interface EmpatraHostInteractionCommandBase {
	digest: string;
	expectedGeneration: number;
	id: string;
	requestId: string;
	threadId: string;
	turnId: string;
}

export interface EmpatraHostInteractionRespondCommand extends EmpatraHostInteractionCommandBase {
	response:
		| Omit<EmpatraHostApprovalResponse, "digest" | "requestId">
		| Omit<EmpatraHostUserInputResponse, "digest" | "requestId">;
	type: "interaction_respond";
}

export interface EmpatraHostInteractionCancelCommand extends EmpatraHostInteractionCommandBase {
	type: "interaction_cancel";
}

export interface EmpatraHostInteractionActivityCommand extends EmpatraHostInteractionCommandBase {
	type: "interaction_activity";
}

export interface EmpatraHostPlanResolutionCommand {
	action: "approve" | "dismiss" | "revise";
	digest: string;
	expectedGeneration: number;
	feedback?: string | null;
	id: string;
	requestId: string;
	threadId: string;
	turnId: string;
	type: "plan_resolution";
}

export interface EmpatraHostShutdownCommand {
	id: string;
	type: "host_shutdown";
}

export type EmpatraHostCommand =
	| EmpatraHostAtomicOperationStatusCommand
	| EmpatraHostGoalClearCommand
	| EmpatraHostGoalGetCommand
	| EmpatraHostGoalSetCommand
	| EmpatraHostExecutionBrokerResponseCommand
	| EmpatraHostMcpOAuthResponseCommand
	| EmpatraHostResourcesResponseCommand
	| EmpatraHostInitializeCommand
	| EmpatraHostModelRoutingReadCommand
	| EmpatraHostModelRoutingWriteCommand
	| EmpatraHostImageGenerationResponseCommand
	| EmpatraHostInteractionActivityCommand
	| EmpatraHostInteractionCancelCommand
	| EmpatraHostInteractionRespondCommand
	| EmpatraHostPlanResolutionCommand
	| EmpatraHostToolsReplaceCommand
	| EmpatraHostToolCancelFrame
	| EmpatraHostToolResultFrame
	| EmpatraHostShutdownCommand
	| EmpatraHostThreadArchiveCommand
	| EmpatraHostThreadCompactCommand
	| EmpatraHostThreadCreateCommand
	| EmpatraHostThreadCreateAndStartCommand
	| EmpatraHostThreadDeleteCommand
	| EmpatraHostThreadForkCommand
	| EmpatraHostThreadForkAndStartCommand
	| EmpatraHostThreadListCommand
	| EmpatraHostThreadReadCommand
	| EmpatraHostThreadRenameCommand
	| EmpatraHostThreadRollbackCommand
	| EmpatraHostThreadTurnsCommand
	| EmpatraHostThreadUnarchiveCommand
	| EmpatraHostTurnInterruptCommand
	| EmpatraHostTurnSteerCommand
	| EmpatraHostTurnStartCommand
	| EmpatraHostSubagentCommand
	| EmpatraHostSubagentResponseCommand;

export interface EmpatraHostReadyFrame {
	capabilities: readonly EmpatraHostAdvertisedCapability[];
	maxFrameBytes: number;
	protocolVersion: typeof EMPATRA_HOST_PROTOCOL_VERSION;
	type: "host_ready";
}

export interface EmpatraHostTurnCompletedEvent {
	event: "turn_completed";
	error?: Readonly<{ code: string; message: string }>;
	generation: number;
	outcome: "completed" | "failed" | "interrupted";
	threadId: string;
	turnId: string;
	type: "host_event";
}

export interface EmpatraHostTurnOutputEvent {
	contentIndex: number;
	delta: string;
	event: "turn_output";
	generation: number;
	kind: "text_delta" | "thinking_delta";
	messageIndex: number;
	sequence: number;
	threadId: string;
	turnId: string;
	type: "host_event";
}

export interface EmpatraHostTokenUsage {
	cachedInputTokens: number;
	inputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
}

export interface EmpatraHostContextUsage {
	modelContextWindow: number;
	observedAtMs: number | null;
	tokenUsage: Readonly<{
		last: EmpatraHostTokenUsage;
		total: EmpatraHostTokenUsage;
	}>;
	turnId: string | null;
}

export interface EmpatraHostTurnUsageUpdatedEvent {
	contextUsage: EmpatraHostContextUsage;
	event: "turn_usage_updated";
	generation: number;
	messageIndex: number;
	sequence: number;
	threadId: string;
	turnId: string;
	type: "host_event";
}

export interface EmpatraHostInteractionRequestedEvent {
	event: "interaction_requested";
	generation: number;
	request: EmpatraHostInteractionRequest;
	sequence: number;
	threadId: string;
	turnId: string;
	type: "host_event";
}

export type { EmpatraHostInteractionExpiredEvent } from "./interaction-broker";

/** A durable, digest-bound plan proposal emitted before execution can begin. */
export interface EmpatraHostPlanProposalEvent {
	digest: string;
	event: "plan_proposal";
	generation: number;
	planText: string;
	requestId: string;
	sequence: number;
	summary: string;
	threadId: string;
	turnId: string;
	type: "host_event";
}

export interface EmpatraHostToolFileChange {
	diff: string;
	diffTruncated: boolean;
	kind: "create" | "delete" | "modify" | "move";
	movePath?: string;
	path: string;
}

export interface EmpatraHostToolExecutionStartPayload {
	argumentsText: string;
	argumentsTruncated: boolean;
	phase: "start";
	toolCallId: string;
	toolName: string;
}

export type EmpatraHostToolExecutionUpdate =
	| Readonly<{ resultText: string; resultTruncated: boolean; type: "output_delta" | "output_snapshot" }>
	| Readonly<{
			changes: readonly EmpatraHostToolFileChange[];
			changesTruncated: boolean;
			type: "changes_snapshot";
	  }>;

export interface EmpatraHostToolExecutionUpdatePayload {
	phase: "update";
	toolCallId: string;
	toolName: string;
	update: EmpatraHostToolExecutionUpdate;
}

export interface EmpatraHostToolExecutionEndPayload {
	argumentsText: string;
	argumentsTruncated: boolean;
	failed: boolean;
	phase: "end";
	resultText: string;
	resultTruncated: boolean;
	toolCallId: string;
	toolName: string;
}

interface EmpatraHostToolEventBase {
	generation: number;
	sequence: number;
	threadId: string;
	turnId: string;
	type: "host_event";
}

export interface EmpatraHostToolExecutionStartEvent extends EmpatraHostToolEventBase {
	argumentsText: string;
	argumentsTruncated: boolean;
	event: "tool_execution_start";
	toolCallId: string;
	toolName: string;
}

export interface EmpatraHostToolExecutionUpdateEvent extends EmpatraHostToolEventBase {
	event: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	update: EmpatraHostToolExecutionUpdate;
}

export interface EmpatraHostToolExecutionEndEvent extends EmpatraHostToolEventBase {
	argumentsText: string;
	argumentsTruncated: boolean;
	event: "tool_execution_end";
	failed: boolean;
	resultText: string;
	resultTruncated: boolean;
	toolCallId: string;
	toolName: string;
}

export type EmpatraHostEvent =
	| EmpatraHostImageGenerationRequestedEvent
	| EmpatraHostImageGenerationEvent
	| EmpatraHostExecutionBrokerRequestEvent
	| EmpatraHostMcpOAuthRequestedEvent
	| EmpatraHostResourcesRequestedEvent
	| EmpatraHostInteractionRequestedEvent
	| EmpatraHostInteractionExpiredEvent
	| EmpatraHostPlanProposalEvent
	| EmpatraHostToolExecutionEndEvent
	| EmpatraHostToolExecutionStartEvent
	| EmpatraHostToolExecutionUpdateEvent
	| EmpatraHostTurnCompletedEvent
	| EmpatraHostTurnOutputEvent
	| EmpatraHostTurnUsageUpdatedEvent
	| EmpatraHostSubagentEvent
	| EmpatraHostSubagentRequestEvent;

export interface EmpatraHostSuccessResponse {
	data?: unknown;
	id: string;
	success: true;
	type: "host_response";
}

export interface EmpatraHostErrorResponse {
	code: string;
	error: string;
	id: string | null;
	success: false;
	type: "host_response";
}

export type EmpatraHostResponse = EmpatraHostErrorResponse | EmpatraHostSuccessResponse;
export type EmpatraHostFrame =
	| EmpatraHostEvent
	| EmpatraHostReadyFrame
	| EmpatraHostResponse
	| EmpatraHostToolOutboundFrame
	| EmpatraHostResourcesResponseCommand
	| EmpatraHostSubagentResponseCommand;

export type EmpatraHostAtomicOperationStatus = "accepted" | "completed" | "dispatching" | "missing";

/** Secret-free receipt projection returned by `atomic_operation_status`. */
export interface EmpatraHostAtomicOperationStatusResponse {
	generation?: number;
	inputSha256?: string;
	kind?: "create_and_start" | "fork_and_start";
	operationId: string;
	status: EmpatraHostAtomicOperationStatus;
	threadId?: string;
	turnId?: string;
}

export interface EmpatraHostFailure {
	code: string;
	message: string;
}

const SAFE_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
	already_initialized: "OMP host is already initialized",
	capacity_exhausted: "OMP host thread capacity is exhausted",
	disposed: "OMP host thread registry is unavailable",
	duplicate_request: "A host command with this id is already running",
	event_backpressure: "OMP host output exceeded the safe queue limit",
	event_sink_missing: "OMP host event transport is unavailable",
	frame_too_large: "OMP host frame exceeds the protocol limit",
	goal_missing: "The thread has no goal to update",
	goal_state_corrupt: "The persisted thread goal is invalid",
	image_capacity_exceeded: "OMP host image input capacity is exhausted",
	host_tool_capacity: "OMP host tool capacity is exhausted",
	host_tool_catalog_invalid: "OMP host tool catalog is invalid",
	host_tool_catalog_mismatch: "OMP host tool catalog revision does not match",
	host_tool_not_pending: "OMP host tool call is no longer pending",
	host_tool_protocol_violation: "OMP host tool response is invalid",
	host_disposed: "OMP host is shutting down",
	identity_mismatch: "OMP thread identity validation failed",
	interaction_not_pending: "OMP host interaction is no longer pending",
	interaction_response_invalid: "OMP host interaction response is invalid",
	image_input_invalid: "OMP host image input is invalid",
	invalid_cursor: "OMP host pagination cursor is invalid",
	invalid_json: "OMP host command is not valid JSON",
	invalid_limit: "OMP host limit is invalid",
	invalid_request: "OMP host command is invalid",
	model_denied: "The requested model is outside the injected catalog",
	model_input_unsupported: "The requested model does not support image input",
	model_not_found: "The requested model is unavailable",
	not_initialized: "OMP host is not initialized",
	operation_conflict: "The operation id is already bound to different inputs",
	atomic_operation_uncertain: "OMP cannot safely replay an accepted atomic operation",
	plan_not_supported: "OMP plan mode is not enabled for this host",
	plan_not_pending: "OMP plan proposal is no longer pending",
	rollback_unavailable: "OMP cannot roll back the requested number of turns",
	runtime_error: "OMP host operation failed",
	server_busy: "OMP host command queue is full",
	settings_conflict: "Model routing settings changed since the requested snapshot was read",
	settings_unavailable: "Model routing settings are unavailable for this host",
	subagent_unavailable: "OMP subagent lifecycle was not negotiated by the main host",
	stale_generation: "The command targets a stale thread generation",
	stale_cursor: "OMP host pagination cursor is stale",
	stale_turn: "The command does not match the active turn",
	thread_config_missing: "The thread is missing its OMP host configuration",
	thread_not_found: "The thread does not exist in this host",
	thread_not_loaded: "The thread is not loaded",
	thread_not_persisted: "The thread has no durable session",
	thread_rename_failed: "OMP rejected the thread title",
	turn_state_corrupt: "The persisted thread turn history is invalid",
	turn_active: "The thread has an active turn",
	turn_failed: "OMP turn failed",
	unknown_command: "OMP host command is not supported",
	workspace_denied: "The working directory is outside the authorized workspace",
	workspace_unavailable: "The authorized workspace is unavailable",
};

export function projectEmpatraHostFailure(error: unknown, fallbackCode = "runtime_error"): EmpatraHostFailure {
	const candidateCode =
		error instanceof EmpatraHostProtocolError || error instanceof EmpatraHostRegistryError
			? error.code
			: fallbackCode;
	const message = Object.hasOwn(SAFE_FAILURE_MESSAGES, candidateCode)
		? SAFE_FAILURE_MESSAGES[candidateCode]
		: undefined;
	if (message) return { code: candidateCode, message };
	return {
		code: fallbackCode === "turn_failed" ? "turn_failed" : "runtime_error",
		message: fallbackCode === "turn_failed" ? SAFE_FAILURE_MESSAGES.turn_failed : SAFE_FAILURE_MESSAGES.runtime_error,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse one host capability without accepting arbitrary controller-provided
 * labels.  Capability names are a closed wire contract, not presentation
 * metadata.
 */
export function parseEmpatraHostCapability(value: unknown): EmpatraHostCapability {
	if (typeof value !== "string" || !EMPATRA_HOST_CAPABILITY_SET.has(value)) {
		throw new EmpatraHostProtocolError("invalid_request", "host capability is invalid");
	}
	return value as EmpatraHostCapability;
}

function parseEmpatraHostAdvertisedCapability(value: unknown): EmpatraHostAdvertisedCapability {
	if (typeof value !== "string" || !EMPATRA_HOST_ADVERTISED_CAPABILITY_SET.has(value)) {
		throw new EmpatraHostProtocolError("invalid_request", "host capability is invalid");
	}
	return value as EmpatraHostAdvertisedCapability;
}

/**
 * Validate the capability list advertised by `host_ready`.  Subsets are
 * allowed so a host can expose only the contracts it actually wired, while
 * unknown names and duplicate claims fail closed.
 */
export function parseEmpatraHostCapabilities(value: unknown): readonly EmpatraHostAdvertisedCapability[] {
	if (!Array.isArray(value) || value.length > EMPATRA_HOST_ADVERTISED_CAPABILITY_SET.size) {
		throw new EmpatraHostProtocolError("invalid_request", "host capabilities are invalid");
	}
	const capabilities = value.map(parseEmpatraHostAdvertisedCapability);
	if (new Set(capabilities).size !== capabilities.length) {
		throw new EmpatraHostProtocolError("invalid_request", "host capabilities must be unique");
	}
	return capabilities;
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every(key => allowed.has(key));
}

function boundedString(value: unknown, field: string, minLength: number, maxLength: number): string {
	if (
		typeof value !== "string" ||
		value.length < minLength ||
		value.length > maxLength ||
		CONTROL_CHARACTER.test(value)
	) {
		throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
	}
	return value;
}

function boundedText(value: unknown, field: string, minLength: number, maxLength: number): string {
	if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
		throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
	}
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 32 && character !== "\n" && character !== "\r" && character !== "\t") {
			throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
		}
	}
	return value;
}

function identifier(value: unknown, field: string): string {
	return boundedString(value, field, 1, 256);
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
		throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
	}
	return value as number;
}

function imageDescriptor(value: unknown, index: number): EmpatraHostImageDescriptor {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["byteLength", "detail", "displayName", "mimeType", "sha256"]) ||
		typeof value.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.sha256) ||
		(value.mimeType !== "image/gif" &&
			value.mimeType !== "image/jpeg" &&
			value.mimeType !== "image/png" &&
			value.mimeType !== "image/webp") ||
		(value.detail !== undefined && value.detail !== "auto" && value.detail !== "high" && value.detail !== "low") ||
		(value.displayName !== undefined &&
			(typeof value.displayName !== "string" ||
				value.displayName.length === 0 ||
				value.displayName.length > 160 ||
				CONTROL_CHARACTER.test(value.displayName) ||
				sanitizeEmpatraHostImageDisplayName(value.displayName) !== value.displayName))
	) {
		throw new EmpatraHostProtocolError("invalid_request", `images[${index}] is invalid`);
	}
	return {
		byteLength: boundedInteger(value.byteLength, `images[${index}].byteLength`, 1, EMPATRA_HOST_MAX_IMAGE_BYTES),
		...(value.detail === undefined ? {} : { detail: value.detail }),
		...(value.displayName === undefined
			? {}
			: { displayName: sanitizeEmpatraHostImageDisplayName(value.displayName) }),
		mimeType: value.mimeType,
		sha256: value.sha256,
	};
}

function optionalImages(value: unknown): EmpatraHostImageDescriptor[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0 || value.length > EMPATRA_HOST_MAX_IMAGES) {
		throw new EmpatraHostProtocolError("invalid_request", "images is invalid");
	}
	const images = value.map(imageDescriptor);
	const totalBytes = images.reduce((total, image) => total + image.byteLength, 0);
	if (totalBytes > EMPATRA_HOST_MAX_IMAGE_BYTES_TOTAL) {
		throw new EmpatraHostProtocolError("invalid_request", "images exceeds its aggregate byte limit");
	}
	return images;
}

function promptMessage(value: unknown, images: readonly EmpatraHostImageDescriptor[] | undefined): string {
	return boundedText(value, "message", images ? 0 : 1, 786_432);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined || typeof value === "boolean") return value;
	throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
}

function optionalNullableGoalStatus(value: unknown): EmpatraHostGoalStatus | null | undefined {
	if (value === undefined || value === null) return value;
	if (
		value === "active" ||
		value === "paused" ||
		value === "blocked" ||
		value === "usageLimited" ||
		value === "budgetLimited" ||
		value === "complete"
	) {
		return value;
	}
	throw new EmpatraHostProtocolError("invalid_request", "status is invalid");
}

function optionalNullableObjective(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return value;
	if (typeof value !== "string" || value.length > 65_536 || value.trim().length === 0) {
		throw new EmpatraHostProtocolError("invalid_request", "objective is invalid");
	}
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 32 && character !== "\n" && character !== "\r" && character !== "\t") {
			throw new EmpatraHostProtocolError("invalid_request", "objective is invalid");
		}
	}
	return value;
}

function optionalNullableTokenBudget(value: unknown): number | null | undefined {
	if (value === undefined || value === null) return value;
	return boundedInteger(value, "tokenBudget", 1, 1_000_000_000);
}

function interactionDigest(value: unknown): string {
	if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
		throw new EmpatraHostProtocolError("invalid_request", "digest is invalid");
	}
	return value;
}

function optionalMode(value: unknown): EmpatraHostMode | undefined {
	if (value === undefined) return undefined;
	if (value === "default" || value === "plan") return value;
	throw new EmpatraHostProtocolError("invalid_request", "mode is invalid");
}

function optionalApprovalMode(value: unknown): EmpatraHostApprovalMode | undefined {
	if (value === undefined) return undefined;
	if (value === "always-ask" || value === "yolo") return value;
	throw new EmpatraHostProtocolError("invalid_request", "approvalMode is invalid");
}

function planResolutionFeedback(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return value;
	return boundedText(value, "feedback", 1, EMPATRA_HOST_MAX_PLAN_SUMMARY_BYTES);
}

function planProposalField(value: unknown, field: string, maxLength: number): string {
	return boundedText(value, field, 1, maxLength);
}

function planTextDigest(planText: string): string {
	return `sha256:${Bun.SHA256.hash(planText, "hex")}`;
}

function catalogRevision(value: unknown): string {
	if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
		throw new EmpatraHostProtocolError("invalid_request", "catalogRevision is invalid");
	}
	return value;
}

function hostToolName(value: unknown, field: string): string {
	const name = boundedString(value, field, 1, 64);
	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
		throw new EmpatraHostProtocolError("invalid_request", `${field} is invalid`);
	}
	return name;
}

function hostToolDefinition(value: unknown, index: number): EmpatraHostToolDefinition {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["description", "hidden", "label", "loadMode", "name", "parameters"]) ||
		!isRecord(value.parameters) ||
		(value.hidden !== undefined && typeof value.hidden !== "boolean") ||
		(value.loadMode !== undefined && value.loadMode !== "discoverable" && value.loadMode !== "essential")
	) {
		throw new EmpatraHostProtocolError("invalid_request", `tools[${index}] is invalid`);
	}
	return {
		description: boundedText(value.description, `tools[${index}].description`, 1, 4096),
		...(value.hidden === undefined ? {} : { hidden: value.hidden }),
		...(value.label === undefined ? {} : { label: boundedText(value.label, `tools[${index}].label`, 1, 512) }),
		...(value.loadMode === undefined ? {} : { loadMode: value.loadMode }),
		name: hostToolName(value.name, `tools[${index}].name`),
		parameters: value.parameters,
	};
}

function optionalHostToolCatalog(value: unknown): EmpatraHostToolCatalog | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !hasOnlyKeys(value, ["catalogRevision", "tools"]) || !Array.isArray(value.tools)
		|| value.tools.length > EMPATRA_HOST_MAX_HOST_TOOLS) {
		throw new EmpatraHostProtocolError("invalid_request", "hostTools is invalid");
	}
	return {
		catalogRevision: catalogRevision(value.catalogRevision),
		tools: value.tools.map(hostToolDefinition),
	};
}

function jsonValue(value: unknown, depth = 0): unknown {
	if (depth > 64) throw new EmpatraHostProtocolError("invalid_request", "JSON value is too deeply nested");
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1));
	if (!isRecord(value)) throw new EmpatraHostProtocolError("invalid_request", "JSON value is invalid");
	const result: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) result[key] = jsonValue(nested, depth + 1);
	return result;
}

function hostToolResult(value: unknown): EmpatraHostToolResultValue {
	if (!isRecord(value) || !hasOnlyKeys(value, ["content", "details"]) || !Array.isArray(value.content)) {
		throw new EmpatraHostProtocolError("invalid_request", "host tool result is invalid");
	}
	const content = value.content.map((block, index): EmpatraHostToolResultContent => {
		if (!isRecord(block) || typeof block.type !== "string") {
			throw new EmpatraHostProtocolError("invalid_request", `result.content[${index}] is invalid`);
		}
		if (block.type === "text" && hasOnlyKeys(block, ["text", "type"])) {
			return { text: boundedText(block.text, `result.content[${index}].text`, 0, 512 * 1024), type: "text" };
		}
		if (block.type === "image" && hasOnlyKeys(block, ["data", "mimeType", "type"])) {
			return {
				data: boundedString(block.data, `result.content[${index}].data`, 1, 512 * 1024),
				mimeType: boundedString(block.mimeType, `result.content[${index}].mimeType`, 1, 256),
				type: "image",
			};
		}
		throw new EmpatraHostProtocolError("invalid_request", `result.content[${index}] is invalid`);
	});
	const result = {
		content,
		...(value.details === undefined ? {} : { details: jsonValue(value.details) }),
	} satisfies EmpatraHostToolResultValue;
	if (textEncoder.encode(JSON.stringify(result)).byteLength > EMPATRA_HOST_MAX_HOST_TOOL_RESULT_BYTES) {
		throw new EmpatraHostProtocolError("frame_too_large", "Host tool result exceeds its limit");
	}
	return result;
}

function interactionResponse(
	value: unknown,
):
	| Omit<EmpatraHostApprovalResponse, "digest" | "requestId">
	| Omit<EmpatraHostUserInputResponse, "digest" | "requestId"> {
	if (!isRecord(value)) throw new EmpatraHostProtocolError("invalid_request", "interaction response is invalid");
	if (value.kind === "approval_response") {
		if (
			!hasOnlyKeys(value, ["decision", "feedback", "kind"]) ||
			(value.decision !== "approve" && value.decision !== "deny")
		) {
			throw new EmpatraHostProtocolError("invalid_request", "interaction response is invalid");
		}
		const feedback = planResolutionFeedback(value.feedback);
		return {
			decision: value.decision,
			kind: "approval_response",
			...(feedback === undefined || feedback === null ? {} : { feedback }),
		};
	}
	if (
		value.kind !== "user_input_response" ||
		!hasOnlyKeys(value, ["inputKind", "kind", "value"]) ||
		(value.inputKind !== "ask_dialog" &&
			value.inputKind !== "confirm" &&
			value.inputKind !== "editor" &&
			value.inputKind !== "input" &&
			value.inputKind !== "select")
	) {
		throw new EmpatraHostProtocolError("invalid_request", "interaction response is invalid");
	}
	return {
		inputKind: value.inputKind,
		kind: "user_input_response",
		value: value.value as EmpatraHostUserInputResponse["value"],
	};
}

function absolutePath(value: unknown, field: string): string {
	const result = boundedString(value, field, 1, 32_768);
	if (!path.isAbsolute(result)) {
		throw new EmpatraHostProtocolError("invalid_request", `${field} must be absolute`);
	}
	return path.normalize(result);
}

function gatewayBaseUrl(value: unknown): string {
	const raw = boundedString(value, "gatewayBaseUrl", 1, 2048);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new EmpatraHostProtocolError("invalid_request", "gatewayBaseUrl is invalid");
	}
	if (
		url.protocol !== "http:" ||
		(url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "::1") ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new EmpatraHostProtocolError("invalid_request", "gatewayBaseUrl must be credential-free HTTP loopback");
	}
	return url.toString().replace(/\/$/, "");
}

function reasoningEfforts(value: unknown): EmpatraHostReasoningEffort[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 7 || new Set(value).size !== value.length) {
		throw new EmpatraHostProtocolError("invalid_request", "model.reasoningEfforts is invalid");
	}
	const allowed = new Set<EmpatraHostReasoningEffort>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
	if (value.some(effort => typeof effort !== "string" || !allowed.has(effort as EmpatraHostReasoningEffort))) {
		throw new EmpatraHostProtocolError("invalid_request", "model.reasoningEfforts is invalid");
	}
	return value as EmpatraHostReasoningEffort[];
}

function optionalReasoningEffort(value: unknown): EmpatraHostReasoningEffort | null {
	if (value === undefined || value === null) return null;
	return reasoningEfforts([value])[0]!;
}

function model(value: unknown): EmpatraHostModel {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"api",
			"contextWindow",
			"id",
			"input",
			"maxTokens",
			"name",
			"reasoning",
			"reasoningEfforts",
			"supportsTools",
		]) ||
		value.api !== "openai-responses" ||
		typeof value.reasoning !== "boolean" ||
		typeof value.supportsTools !== "boolean" ||
		!Array.isArray(value.input) ||
		value.input.length === 0 ||
		value.input.length > 2 ||
		value.input.some(input => input !== "text" && input !== "image") ||
		new Set(value.input).size !== value.input.length ||
		value.input[0] !== "text"
	) {
		throw new EmpatraHostProtocolError("invalid_request", "models contains an invalid model");
	}
	return {
		api: "openai-responses",
		contextWindow: boundedInteger(value.contextWindow, "model.contextWindow", 1, 10_000_000),
		id: identifier(value.id, "model.id"),
		input: value.input as ("image" | "text")[],
		maxTokens: boundedInteger(value.maxTokens, "model.maxTokens", 1, 10_000_000),
		name: boundedString(value.name, "model.name", 1, 512),
		reasoning: value.reasoning,
		...(value.reasoningEfforts === undefined ? {} : { reasoningEfforts: reasoningEfforts(value.reasoningEfforts) }),
		supportsTools: value.supportsTools,
	};
}

function skill(value: unknown): EmpatraHostSkill {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["baseDir", "description", "filePath", "hide", "name", "source"]) ||
		(value.hide !== undefined && typeof value.hide !== "boolean")
	) {
		throw new EmpatraHostProtocolError("invalid_request", "skills contains an invalid skill");
	}
	return {
		baseDir: absolutePath(value.baseDir, "skill.baseDir"),
		description: boundedString(value.description, "skill.description", 0, EMPATRA_HOST_MAX_SKILL_DESCRIPTION_BYTES),
		filePath: absolutePath(value.filePath, "skill.filePath"),
		...(value.hide === undefined ? {} : { hide: value.hide === true }),
		name: boundedString(value.name, "skill.name", 1, EMPATRA_HOST_MAX_SKILL_NAME_BYTES),
		source: boundedString(value.source, "skill.source", 1, EMPATRA_HOST_MAX_SKILL_SOURCE_BYTES),
	};
}

function extensionDescriptor(value: unknown): EmpatraHostExtensionDescriptor {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["filePath", "id", "sha256"]) ||
		typeof value.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/u.test(value.sha256)
	) {
		throw new EmpatraHostProtocolError("invalid_request", "extensions contains an invalid extension");
	}
	return {
		filePath: absolutePath(value.filePath, "extension.filePath"),
		id: boundedString(value.id, "extension.id", 1, 256),
		sha256: value.sha256,
	};
}

function parseInitialize(value: Record<string, unknown>): EmpatraHostInitializeCommand {
	if (
		!hasOnlyKeys(value, [
			"agentCatalog",
			"capability",
			"extensions",
			"gatewayBaseUrl",
			"id",
			"modelRouting",
			"models",
			"skills",
			"protocolVersion",
			"sessionDirectory",
			"subagentRpc",
			"type",
			"workspaceRoots",
		]) ||
		value.protocolVersion !== EMPATRA_HOST_PROTOCOL_VERSION ||
		!Array.isArray(value.models) ||
		value.models.length === 0 ||
		value.models.length > EMPATRA_HOST_MAX_MODELS ||
		(value.extensions !== undefined &&
			(!Array.isArray(value.extensions) || value.extensions.length > EMPATRA_HOST_MAX_EXTENSIONS)) ||
		(value.skills !== undefined && (!Array.isArray(value.skills) || value.skills.length > EMPATRA_HOST_MAX_SKILLS)) ||
		!Array.isArray(value.workspaceRoots) ||
		value.workspaceRoots.length === 0 ||
		value.workspaceRoots.length > EMPATRA_HOST_MAX_WORKSPACE_ROOTS
	) {
		throw new EmpatraHostProtocolError("invalid_request", "host_initialize is invalid");
	}
	const models = value.models.map(model);
	if (new Set(models.map(entry => entry.id)).size !== models.length) {
		throw new EmpatraHostProtocolError("invalid_request", "model ids must be unique");
	}
	const workspaceRoots = value.workspaceRoots.map((root, index) => absolutePath(root, `workspaceRoots[${index}]`));
	if (new Set(workspaceRoots).size !== workspaceRoots.length) {
		throw new EmpatraHostProtocolError("invalid_request", "workspaceRoots must be unique");
	}
	const skills = value.skills === undefined ? [] : value.skills.map(skill);
	if (new Set(skills.map(entry => entry.name)).size !== skills.length) {
		throw new EmpatraHostProtocolError("invalid_request", "skill names must be unique");
	}
	let subagentRpc: EmpatraHostSubagentRpcBootstrap | undefined;
	if (value.subagentRpc !== undefined) {
		if (
			!isRecord(value.subagentRpc) ||
			!hasOnlyKeys(value.subagentRpc, ["capability"]) ||
			value.subagentRpc.capability !== EMPATRA_HOST_SUBAGENT_CAPABILITY
		) {
			throw new EmpatraHostProtocolError("invalid_request", "subagentRpc bootstrap is invalid");
		}
		subagentRpc = { capability: EMPATRA_HOST_SUBAGENT_CAPABILITY };
	}
	let agentCatalog: EmpatraHostAgentCatalog | undefined;
	if (value.agentCatalog !== undefined) {
		if (subagentRpc === undefined) {
			throw new EmpatraHostProtocolError(
				"invalid_request",
				"agentCatalog requires the negotiated subagent RPC bootstrap",
			);
		}
		agentCatalog = parseEmpatraHostAgentCatalog(value.agentCatalog);
	}
	return {
		...(agentCatalog === undefined ? {} : { agentCatalog }),
		capability: boundedString(value.capability, "capability", 32, 512),
		...(value.extensions === undefined ? {} : { extensions: value.extensions.map(extensionDescriptor) }),
		gatewayBaseUrl: gatewayBaseUrl(value.gatewayBaseUrl),
		id: identifier(value.id, "id"),
		...(value.modelRouting === undefined ? {} : { modelRouting: parseEmpatraHostModelRoutingSnapshot(value.modelRouting) }),
		models,
		protocolVersion: EMPATRA_HOST_PROTOCOL_VERSION,
		sessionDirectory: absolutePath(value.sessionDirectory, "sessionDirectory"),
		...(subagentRpc === undefined ? {} : { subagentRpc }),
		skills,
		type: "host_initialize",
		workspaceRoots,
	};
}

export function parseEmpatraHostCommand(frame: string): EmpatraHostCommand {
	if (textEncoder.encode(frame).byteLength > EMPATRA_HOST_MAX_FRAME_BYTES) {
		throw new EmpatraHostProtocolError("frame_too_large", "Host command exceeds the physical frame limit");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(frame);
	} catch {
		throw new EmpatraHostProtocolError("invalid_json", "Host command is not valid JSON");
	}
	if (!isRecord(parsed) || typeof parsed.type !== "string") {
		throw new EmpatraHostProtocolError("invalid_request", "Host command must be an object with a type");
	}
	if (parsed.type === "host_initialize") return parseInitialize(parsed);
	if (parsed.type === "subagent_response") return parseEmpatraHostSubagentResponse(parsed);
	if (parsed.type.startsWith("subagent_")) return parseEmpatraHostSubagentCommand(parsed);
	const id = identifier(parsed.id, "id");

	switch (parsed.type) {
		case "image_generation_response": {
			const response = parseEmpatraHostImageGenerationResponseCommand(parsed);
			if (!response) {
				throw new EmpatraHostProtocolError("invalid_request", "image_generation_response is invalid");
			}
			return { ...response, id };
		}
		case "host_tools_replace":
			if (
				!hasOnlyKeys(parsed, ["catalogRevision", "expectedGeneration", "id", "threadId", "tools", "type"]) ||
				!Array.isArray(parsed.tools) ||
				parsed.tools.length > EMPATRA_HOST_MAX_HOST_TOOLS ||
				(parsed.threadId !== undefined && typeof parsed.threadId !== "string") ||
				(parsed.expectedGeneration !== undefined && (typeof parsed.expectedGeneration !== "number" || !Number.isSafeInteger(parsed.expectedGeneration) || parsed.expectedGeneration < 0))
			) {
				throw new EmpatraHostProtocolError("invalid_request", "host_tools_replace is invalid");
			}
			return {
				catalogRevision: catalogRevision(parsed.catalogRevision),
				...(parsed.expectedGeneration === undefined ? {} : { expectedGeneration: boundedInteger(parsed.expectedGeneration, "expectedGeneration", 0, Number.MAX_SAFE_INTEGER) }),
				id,
				...(parsed.threadId === undefined ? {} : { threadId: identifier(parsed.threadId, "threadId") }),
				tools: parsed.tools.map(hostToolDefinition),
				type: "host_tools_replace",
			};
		case "host_tool_result":
			if (
				!hasOnlyKeys(parsed, [
					"catalogRevision",
					"failed",
					"generation",
					"id",
					"result",
					"threadId",
					"turnId",
					"type",
				]) ||
				typeof parsed.failed !== "boolean"
			) {
				throw new EmpatraHostProtocolError("invalid_request", "host_tool_result is invalid");
			}
			return {
				catalogRevision: catalogRevision(parsed.catalogRevision),
				failed: parsed.failed,
				generation: boundedInteger(parsed.generation, "generation", 1, Number.MAX_SAFE_INTEGER),
				id,
				result: hostToolResult(parsed.result),
				threadId: identifier(parsed.threadId, "threadId"),
				turnId: identifier(parsed.turnId, "turnId"),
				type: "host_tool_result",
			};
		case "host_tool_cancel":
			if (!hasOnlyKeys(parsed, ["catalogRevision", "generation", "id", "targetId", "threadId", "turnId", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", "host_tool_cancel is invalid");
			}
			return {
				catalogRevision: catalogRevision(parsed.catalogRevision),
				generation: boundedInteger(parsed.generation, "generation", 1, Number.MAX_SAFE_INTEGER),
				id,
				targetId: identifier(parsed.targetId, "targetId"),
				threadId: identifier(parsed.threadId, "threadId"),
				turnId: identifier(parsed.turnId, "turnId"),
				type: "host_tool_cancel",
			};
		case "execution_broker_response":
			return parseEmpatraHostExecutionBrokerResponse(parsed);
		case "mcp_oauth_response":
			return parseEmpatraHostMcpOAuthResponseCommand(parsed);
		case "resources_response":
			return parseEmpatraHostResourcesResponseCommand(parsed);
		case "settings_model_routing_read":
			return parseEmpatraHostModelRoutingReadCommand(parsed, id);
		case "settings_model_routing_write":
			return parseEmpatraHostModelRoutingWriteCommand(parsed, id);
		case "host_shutdown":
			if (!hasOnlyKeys(parsed, ["id", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", `${parsed.type} contains unknown fields`);
			}
			return { id, type: parsed.type };
		case "interaction_activity":
		case "interaction_cancel":
			if (!hasOnlyKeys(parsed, ["digest", "expectedGeneration", "id", "requestId", "threadId", "turnId", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", `${parsed.type} contains unknown fields`);
			}
			return {
				digest: interactionDigest(parsed.digest),
				expectedGeneration: boundedInteger(
					parsed.expectedGeneration,
					"expectedGeneration",
					1,
					Number.MAX_SAFE_INTEGER,
				),
				id,
				requestId: identifier(parsed.requestId, "requestId"),
				threadId: identifier(parsed.threadId, "threadId"),
				turnId: identifier(parsed.turnId, "turnId"),
				type: parsed.type,
			};
		case "interaction_respond":
			if (
				!hasOnlyKeys(parsed, [
					"digest",
					"expectedGeneration",
					"id",
					"requestId",
					"response",
					"threadId",
					"turnId",
					"type",
				])
			) {
				throw new EmpatraHostProtocolError("invalid_request", "interaction_respond contains unknown fields");
			}
			return {
				digest: interactionDigest(parsed.digest),
				expectedGeneration: boundedInteger(
					parsed.expectedGeneration,
					"expectedGeneration",
					1,
					Number.MAX_SAFE_INTEGER,
				),
				id,
				requestId: identifier(parsed.requestId, "requestId"),
				response: interactionResponse(parsed.response),
				threadId: identifier(parsed.threadId, "threadId"),
				turnId: identifier(parsed.turnId, "turnId"),
				type: "interaction_respond",
			};
		case "plan_resolution":
			if (
				!hasOnlyKeys(parsed, [
					"action",
					"digest",
					"expectedGeneration",
					"feedback",
					"id",
					"requestId",
					"threadId",
					"turnId",
					"type",
				]) ||
				(parsed.action !== "approve" && parsed.action !== "dismiss" && parsed.action !== "revise")
			) {
				throw new EmpatraHostProtocolError("invalid_request", "plan_resolution is invalid");
			}
			{
				const feedback = planResolutionFeedback(parsed.feedback);
				if (parsed.action === "revise" && !feedback) {
					throw new EmpatraHostProtocolError("invalid_request", "feedback is required for plan revision");
				}
				return {
					action: parsed.action,
					digest: interactionDigest(parsed.digest),
					expectedGeneration: boundedInteger(
						parsed.expectedGeneration,
						"expectedGeneration",
						1,
						Number.MAX_SAFE_INTEGER,
					),
					...(feedback === undefined ? {} : { feedback }),
					id,
					requestId: identifier(parsed.requestId, "requestId"),
					threadId: identifier(parsed.threadId, "threadId"),
					turnId: identifier(parsed.turnId, "turnId"),
					type: "plan_resolution",
				};
			}
		case "thread_list":
			if (!hasOnlyKeys(parsed, ["archived", "id", "limit", "offset", "searchTerm", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", "thread_list contains unknown fields");
			}
			return {
				...(optionalBoolean(parsed.archived, "archived") === undefined
					? {}
					: { archived: optionalBoolean(parsed.archived, "archived") }),
				id,
				limit: boundedInteger(parsed.limit, "limit", 1, 200),
				offset: boundedInteger(parsed.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
				...(parsed.searchTerm === undefined
					? {}
					: { searchTerm: boundedString(parsed.searchTerm, "searchTerm", 1, 1024) }),
				type: "thread_list",
			};
		case "thread_turns":
			if (!hasOnlyKeys(parsed, ["cursor", "id", "limit", "sortDirection", "threadId", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", "thread_turns contains unknown fields");
			}
			if (parsed.sortDirection !== undefined && parsed.sortDirection !== "asc" && parsed.sortDirection !== "desc") {
				throw new EmpatraHostProtocolError("invalid_request", "sortDirection is invalid");
			}
			return {
				...(parsed.cursor === undefined ? {} : { cursor: boundedString(parsed.cursor, "cursor", 1, 4096) }),
				id,
				limit: boundedInteger(parsed.limit, "limit", 1, 200),
				...(parsed.sortDirection === undefined ? {} : { sortDirection: parsed.sortDirection }),
				threadId: identifier(parsed.threadId, "threadId"),
				type: "thread_turns",
			};
		case "atomic_operation_status":
			if (!hasOnlyKeys(parsed, ["id", "operationId", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", "atomic_operation_status contains unknown fields");
			}
			return {
				id,
				operationId: identifier(parsed.operationId, "operationId"),
				type: "atomic_operation_status",
			};
		case "goal_get":
		case "goal_clear":
			if (!hasOnlyKeys(parsed, ["id", "threadId", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", `${parsed.type} contains unknown fields`);
			}
			return { id, threadId: identifier(parsed.threadId, "threadId"), type: parsed.type };
		case "goal_set": {
			if (!hasOnlyKeys(parsed, ["id", "objective", "status", "threadId", "tokenBudget", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", "goal_set contains unknown fields");
			}
			const objective = optionalNullableObjective(parsed.objective);
			const status = optionalNullableGoalStatus(parsed.status);
			const tokenBudget = optionalNullableTokenBudget(parsed.tokenBudget);
			if (objective === undefined && status === undefined && tokenBudget === undefined) {
				throw new EmpatraHostProtocolError("invalid_request", "goal_set patch is empty");
			}
			return {
				id,
				...(objective === undefined ? {} : { objective }),
				...(status === undefined ? {} : { status }),
				threadId: identifier(parsed.threadId, "threadId"),
				...(tokenBudget === undefined ? {} : { tokenBudget }),
				type: "goal_set",
			};
		}
		case "thread_archive":
		case "thread_compact":
		case "thread_delete":
		case "thread_unarchive":
			if (!hasOnlyKeys(parsed, ["id", "threadId", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", `${parsed.type} contains unknown fields`);
			}
			return { id, threadId: identifier(parsed.threadId, "threadId"), type: parsed.type };
		case "thread_rollback":
			if (!hasOnlyKeys(parsed, ["id", "threadId", "turns", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", "thread_rollback contains unknown fields");
			}
			return {
				id,
				threadId: identifier(parsed.threadId, "threadId"),
				turns: boundedInteger(parsed.turns, "turns", 1, 10_000),
				type: "thread_rollback",
			};
		case "thread_fork":
			if (!hasOnlyKeys(parsed, ["approvalMode", "cwd", "id", "mode", "operationId", "threadId", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", "thread_fork contains unknown fields");
			}
			return {
				...(optionalApprovalMode(parsed.approvalMode) === undefined
					? {}
					: { approvalMode: optionalApprovalMode(parsed.approvalMode) }),
				...(parsed.cwd === undefined ? {} : { cwd: absolutePath(parsed.cwd, "cwd") }),
				id,
				...(optionalMode(parsed.mode) === undefined ? {} : { mode: optionalMode(parsed.mode) }),
				operationId: identifier(parsed.operationId, "operationId"),
				threadId: identifier(parsed.threadId, "threadId"),
				type: "thread_fork",
			};
		case "thread_rename":
			if (!hasOnlyKeys(parsed, ["id", "threadId", "title", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", "thread_rename contains unknown fields");
			}
			return {
				id,
				threadId: identifier(parsed.threadId, "threadId"),
				title: boundedString(parsed.title, "title", 1, 1024),
				type: "thread_rename",
			};
		case "thread_read":
			if (!hasOnlyKeys(parsed, ["cursor", "id", "limit", "pagination", "threadId", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", "thread_read contains unknown fields");
			}
			if (parsed.pagination !== undefined && parsed.pagination !== "turns-v2") {
				throw new EmpatraHostProtocolError("invalid_request", "pagination is invalid");
			}
			return {
				...(parsed.cursor === undefined ? {} : { cursor: boundedString(parsed.cursor, "cursor", 1, 4096) }),
				id,
				limit: boundedInteger(parsed.limit, "limit", 1, 200),
				...(parsed.pagination === undefined ? {} : { pagination: parsed.pagination }),
				threadId: identifier(parsed.threadId, "threadId"),
				type: "thread_read",
			};
		case "thread_create":
			if (
				!hasOnlyKeys(parsed, [
					"approvalMode",
					"cwd",
					"id",
					"mode",
					"modelId",
					"operationId",
					"systemPrompt",
					"type",
				])
			) {
				throw new EmpatraHostProtocolError("invalid_request", "thread_create contains unknown fields");
			}
			return {
				...(optionalApprovalMode(parsed.approvalMode) === undefined
					? {}
					: { approvalMode: optionalApprovalMode(parsed.approvalMode) }),
				cwd: absolutePath(parsed.cwd, "cwd"),
				id,
				...(optionalMode(parsed.mode) === undefined ? {} : { mode: optionalMode(parsed.mode) }),
				modelId: identifier(parsed.modelId, "modelId"),
				operationId: identifier(parsed.operationId, "operationId"),
				systemPrompt: boundedText(parsed.systemPrompt, "systemPrompt", 1, 262_144),
				type: "thread_create",
			};
		case "thread_create_and_start":
			if (
				!hasOnlyKeys(parsed, [
					"approvalMode",
					"cwd",
					"id",
					"images",
					"hostTools",
					"message",
					"mode",
					"modelId",
					"operationId",
					"reasoningEffort",
					"systemPrompt",
					"turnId",
					"type",
				])
			) {
				throw new EmpatraHostProtocolError("invalid_request", "thread_create_and_start contains unknown fields");
			}
			{
				const images = optionalImages(parsed.images);
				const hostTools = optionalHostToolCatalog(parsed.hostTools);
				return {
					...(optionalApprovalMode(parsed.approvalMode) === undefined
						? {}
						: { approvalMode: optionalApprovalMode(parsed.approvalMode) }),
					cwd: absolutePath(parsed.cwd, "cwd"),
					...(hostTools ? { hostTools } : {}),
					id,
					...(images ? { images } : {}),
					message: promptMessage(parsed.message, images),
					...(optionalMode(parsed.mode) === undefined ? {} : { mode: optionalMode(parsed.mode) }),
					modelId: identifier(parsed.modelId, "modelId"),
					operationId: identifier(parsed.operationId, "operationId"),
					...(parsed.reasoningEffort === undefined
						? {}
						: { reasoningEffort: optionalReasoningEffort(parsed.reasoningEffort) }),
					systemPrompt: boundedText(parsed.systemPrompt, "systemPrompt", 1, 262_144),
					turnId: identifier(parsed.turnId, "turnId"),
					type: "thread_create_and_start",
				};
			}
		case "thread_fork_and_start":
			if (
				!hasOnlyKeys(parsed, [
					"approvalMode",
					"cwd",
					"id",
					"images",
					"hostTools",
					"message",
					"mode",
					"operationId",
					"reasoningEffort",
					"threadId",
					"turnId",
					"type",
				])
			) {
				throw new EmpatraHostProtocolError("invalid_request", "thread_fork_and_start contains unknown fields");
			}
			{
				const images = optionalImages(parsed.images);
				const hostTools = optionalHostToolCatalog(parsed.hostTools);
				return {
					...(optionalApprovalMode(parsed.approvalMode) === undefined
						? {}
						: { approvalMode: optionalApprovalMode(parsed.approvalMode) }),
					...(parsed.cwd === undefined ? {} : { cwd: absolutePath(parsed.cwd, "cwd") }),
					...(hostTools ? { hostTools } : {}),
					id,
					...(images ? { images } : {}),
					message: promptMessage(parsed.message, images),
					...(optionalMode(parsed.mode) === undefined ? {} : { mode: optionalMode(parsed.mode) }),
					operationId: identifier(parsed.operationId, "operationId"),
					...(parsed.reasoningEffort === undefined
						? {}
						: { reasoningEffort: optionalReasoningEffort(parsed.reasoningEffort) }),
					threadId: identifier(parsed.threadId, "threadId"),
					turnId: identifier(parsed.turnId, "turnId"),
					type: "thread_fork_and_start",
				};
			}
		case "turn_start":
			if (
				!hasOnlyKeys(parsed, [
					"approvalMode",
					"expectedGeneration",
					"id",
					"images",
					"hostTools",
					"message",
					"mode",
					"modelId",
					"reasoningEffort",
					"threadId",
					"turnId",
					"type",
					"systemPrompt",
				])
			) {
				throw new EmpatraHostProtocolError("invalid_request", "turn_start contains unknown fields");
			}
			{
				const images = optionalImages(parsed.images);
				const hostTools = optionalHostToolCatalog(parsed.hostTools);
				return {
					...(optionalApprovalMode(parsed.approvalMode) === undefined
						? {}
						: { approvalMode: optionalApprovalMode(parsed.approvalMode) }),
					expectedGeneration: boundedInteger(
						parsed.expectedGeneration,
						"expectedGeneration",
						0,
						Number.MAX_SAFE_INTEGER,
					),
					id,
					...(hostTools ? { hostTools } : {}),
					...(images ? { images } : {}),
					message: promptMessage(parsed.message, images),
					...(optionalMode(parsed.mode) === undefined ? {} : { mode: optionalMode(parsed.mode) }),
					...(parsed.modelId === undefined ? {} : { modelId: identifier(parsed.modelId, "modelId") }),
					...(parsed.reasoningEffort === undefined
						? {}
						: { reasoningEffort: optionalReasoningEffort(parsed.reasoningEffort) }),
					...(parsed.systemPrompt === undefined
						? {}
						: { systemPrompt: boundedText(parsed.systemPrompt, "systemPrompt", 1, 262_144) }),
					threadId: identifier(parsed.threadId, "threadId"),
					turnId: identifier(parsed.turnId, "turnId"),
					type: "turn_start",
				};
			}
		case "turn_interrupt":
			if (!hasOnlyKeys(parsed, ["expectedGeneration", "id", "threadId", "turnId", "type"])) {
				throw new EmpatraHostProtocolError("invalid_request", "turn_interrupt contains unknown fields");
			}
			return {
				expectedGeneration: boundedInteger(
					parsed.expectedGeneration,
					"expectedGeneration",
					0,
					Number.MAX_SAFE_INTEGER,
				),
				id,
				threadId: identifier(parsed.threadId, "threadId"),
				turnId: identifier(parsed.turnId, "turnId"),
				type: "turn_interrupt",
			};
		case "turn_steer":
			if (
				!hasOnlyKeys(parsed, [
					"approvalMode",
					"expectedGeneration",
					"id",
					"images",
					"message",
					"mode",
					"threadId",
					"turnId",
					"type",
				])
			) {
				throw new EmpatraHostProtocolError("invalid_request", "turn_steer contains unknown fields");
			}
			{
				const images = optionalImages(parsed.images);
				return {
					...(optionalApprovalMode(parsed.approvalMode) === undefined
						? {}
						: { approvalMode: optionalApprovalMode(parsed.approvalMode) }),
					expectedGeneration: boundedInteger(
						parsed.expectedGeneration,
						"expectedGeneration",
						0,
						Number.MAX_SAFE_INTEGER,
					),
					id,
					...(images ? { images } : {}),
					message: promptMessage(parsed.message, images),
					...(optionalMode(parsed.mode) === undefined ? {} : { mode: optionalMode(parsed.mode) }),
					threadId: identifier(parsed.threadId, "threadId"),
					turnId: identifier(parsed.turnId, "turnId"),
					type: "turn_steer",
				};
			}
		default:
			throw new EmpatraHostProtocolError("unknown_command", `Unknown host command: ${parsed.type}`);
	}
}

export function serializeEmpatraHostFrame(
	frame: EmpatraHostFrame,
	options: { allowChunking?: boolean } = {},
): string {
	if (frame.type === "host_ready") {
		if (
			frame.protocolVersion !== EMPATRA_HOST_PROTOCOL_VERSION ||
			frame.maxFrameBytes !== EMPATRA_HOST_MAX_FRAME_BYTES
		) {
			throw new EmpatraHostProtocolError("invalid_request", "host_ready is invalid");
		}
		parseEmpatraHostCapabilities(frame.capabilities);
	}
	if (frame.type === "host_event" && frame.event === "execution_broker_request") {
		parseEmpatraHostExecutionBrokerRequestEvent(frame);
	}
	if (frame.type === "host_event" && frame.event === "mcp_oauth_requested") {
		parseEmpatraHostMcpOAuthRequestedEvent(frame);
	}
	if (frame.type === "host_event" && frame.event === "resources_requested") {
		parseEmpatraHostResourcesRequestedEvent(frame);
	}
	if (frame.type === "host_event" && frame.event === "interaction_expired") {
		if (
			!hasOnlyKeys(frame, ["digest", "event", "generation", "requestId", "sequence", "threadId", "turnId", "type"])
			|| typeof frame.digest !== "string"
			|| !/^sha256:[a-f0-9]{64}$/.test(frame.digest)
		) {
			throw new EmpatraHostProtocolError("invalid_request", "interaction_expired is invalid");
		}
		boundedInteger(frame.generation, "generation", 1, Number.MAX_SAFE_INTEGER);
		boundedInteger(frame.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER);
		identifier(frame.requestId, "requestId");
		identifier(frame.threadId, "threadId");
		identifier(frame.turnId, "turnId");
	}
	if (frame.type === "host_event" && frame.event === "image_generation_requested") {
		if (!parseEmpatraHostImageGenerationRequestedEvent(frame)) {
			throw new EmpatraHostProtocolError("invalid_request", "image_generation_requested is invalid");
		}
	}
	if (frame.type === "host_event" && frame.event === "image_generation") {
		parseEmpatraHostImageGenerationEvent(frame);
	}
	if (
		frame.type === "host_event" &&
		(frame.event === "subagent_lifecycle" || frame.event === "subagent_progress" || frame.event === "subagent_result")
	) {
		parseEmpatraHostSubagentEvent(frame);
	}
	if (frame.type === "host_event" && frame.event === "subagent_request") {
		parseEmpatraHostSubagentRequestEvent(frame);
	}
	if (frame.type === "subagent_response") parseEmpatraHostSubagentResponse(frame);
	if (frame.type === "resources_response") parseEmpatraHostResourcesResponseCommand(frame);
	if (frame.type === "host_event" && frame.event === "plan_proposal") {
		interactionDigest(frame.digest);
		boundedInteger(frame.generation, "generation", 1, Number.MAX_SAFE_INTEGER);
		boundedInteger(frame.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER);
		identifier(frame.requestId, "requestId");
		identifier(frame.threadId, "threadId");
		identifier(frame.turnId, "turnId");
		planProposalField(frame.planText, "planText", EMPATRA_HOST_MAX_PLAN_CONTENT_BYTES);
		if (frame.digest !== planTextDigest(frame.planText)) {
			throw new EmpatraHostProtocolError("identity_mismatch", "Plan proposal digest does not match its content");
		}
		planProposalField(frame.summary, "summary", EMPATRA_HOST_MAX_PLAN_SUMMARY_BYTES);
	}
	const serialized = JSON.stringify(frame);
	if (!options.allowChunking && textEncoder.encode(serialized).byteLength > EMPATRA_HOST_MAX_FRAME_BYTES) {
		throw new EmpatraHostProtocolError("frame_too_large", "Host response exceeds the physical frame limit");
	}
	return `${serialized}\n`;
}
