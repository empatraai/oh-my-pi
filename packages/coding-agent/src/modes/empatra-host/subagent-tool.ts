import { type as arkType } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ModelSubagentRpcBroker, ModelSubagentRpcScope, ToolSession } from "../../tools";
import {
	EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN,
	EMPATRA_HOST_MAX_SUBAGENT_ASSIGNMENT_BYTES,
	EMPATRA_HOST_SUBAGENT_CAPABILITY,
} from "./subagent-broker";

const subagentItemSchema = arkType({
	"agent?": arkType("string").describe("Optional agent selector from the main-owned catalog"),
	"model?": arkType("string").describe("Optional managed model selector"),
	task: arkType("string").describe("Self-contained assignment for the delegated agent"),
	"+": "delete",
});

/**
 * Keep the native OMP task shapes while routing each eventual spawn through
 * Electron main. ArkType cannot infer a deterministic union for two open
 * object morphs, so the wire schema keeps both shapes optional and the
 * executor enforces the exact one-of rule. It is deliberately limited to selectors and text;
 * isolation, cwd, env, credentials, executable paths, and output schemas are
 * main-owned and therefore cannot cross this boundary.
 */
const subagentSchema = arkType({
	"operation?": arkType("'spawn' | 'list' | 'steer' | 'interrupt' | 'close'").describe(
		"Lifecycle operation; omit (or use spawn) to start delegated work",
	),
	"agent?": arkType("string").describe("Optional agent selector from the main-owned catalog"),
	"model?": arkType("string").describe("Optional managed model selector"),
	"childId?": arkType("string").describe("Existing main-owned child id for lifecycle operations"),
	"message?": arkType("string").describe("Steering message for an existing child"),
	"task?": arkType("string").describe("Self-contained assignment for the delegated agent"),
	"context?": arkType("string").describe("Shared background prepended to every delegated assignment"),
	"tasks?": subagentItemSchema.array().describe("Independent assignments to start in parallel (maximum 16)"),
	"+": "delete",
});

type SubagentInput = typeof subagentSchema.infer;
type LifecycleOperation = "close" | "interrupt" | "list" | "spawn" | "steer";

export interface EmpatraHostSubagentToolDetails {
	operation?: "close" | "interrupt" | "list" | "spawn" | "steer";
	childId?: string;
	index?: number;
	status: "aborted" | "completed" | "failed" | "running";
	children?: readonly EmpatraHostSubagentChildDetails[];
	error?: string;
}

export interface EmpatraHostSubagentChildDetails {
	agentName?: string;
	childId?: string;
	index: number;
	status: "aborted" | "completed" | "failed" | "running";
	updatedAtMs?: number;
	error?: string;
}

function failed(message: string): AgentToolResult<EmpatraHostSubagentToolDetails> {
	return {
		content: [{ type: "text", text: message }],
		details: { error: message, status: "failed" },
		isError: true,
	};
}

/**
 * Model-facing OMP task bridge for the explicitly bootstrapped Empatra host.
 *
 * This intentionally implements only the model contract. It never accepts a
 * cwd, command, environment, credentials, or executable path. The negotiated
 * broker sends selectors and the bounded assignment to Electron main, which
 * owns child creation and all lifecycle authority.
 */
export class EmpatraHostSubagentTool implements AgentTool<typeof subagentSchema, EmpatraHostSubagentToolDetails> {
	readonly name = "task";
	readonly label = "Task";
	readonly summary = "Delegate work and control main-owned subagent lifecycles";
	readonly description =
		"Delegate one assignment or a parallel batch of independent assignments to managed subagents. For a batch use {context, tasks:[{task, agent?, model?}]}. To coordinate an active child, use {operation:'list'}, {operation:'steer', childId, message}, {operation:'interrupt', childId}, or {operation:'close', childId}. The desktop host chooses workspace, environment, credentials, isolation, and execution policy; those fields are never accepted by this tool.";
	readonly parameters = subagentSchema;
	readonly approval = "exec" as const;
	readonly intent = "omit" as const;
	readonly loadMode = "essential" as const;
	readonly strict = false;
	readonly mergeCallAndResult = true;

	readonly formatApprovalDetails = (args: unknown): string[] => {
		if (!args || typeof args !== "object" || Array.isArray(args)) return [];
		const value = args as Partial<SubagentInput>;
		const details: string[] = [];
		if (typeof value.operation === "string") details.push(`Operation: ${value.operation}`);
		if (typeof value.childId === "string") details.push(`Child: ${value.childId}`);
		if (typeof value.message === "string") details.push(`Message:\n${value.message.trim()}`);
		if (typeof value.context === "string" && value.context.trim()) details.push(`Context:\n${value.context.trim()}`);
		if (typeof value.agent === "string" && value.agent.trim()) details.push(`Agent: ${value.agent.trim()}`);
		if (typeof value.model === "string" && value.model.trim()) details.push(`Model: ${value.model.trim()}`);
		if (typeof value.task === "string") details.push(`Task:\n${value.task.trim()}`);
		if (Array.isArray(value.tasks)) {
			details.push(`Batch: ${value.tasks.length} assignments (maximum ${EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN})`);
			const first = value.tasks[0];
			if (first && typeof first === "object" && typeof first.task === "string") {
				details.push(`First task:\n${first.task.trim()}`);
			}
		}
		return details;
	};

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: SubagentInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<EmpatraHostSubagentToolDetails, SubagentInput>,
	): Promise<AgentToolResult<EmpatraHostSubagentToolDetails>> {
		if (signal?.aborted) return failed("Subagent assignment was cancelled before dispatch.");
		const broker: ModelSubagentRpcBroker | undefined = this.session.subagentRpcBroker;
		const scope: ModelSubagentRpcScope | undefined = this.session.subagentRpcScope?.();
		if (!broker || broker.capability !== EMPATRA_HOST_SUBAGENT_CAPABILITY || !scope) {
			return failed("Subagent lifecycle is unavailable until the main host completes explicit RPC bootstrap.");
		}
		try {
			const operation = normalizeOperation(params.operation);
			if (operation !== "spawn") return await executeLifecycleOperation(broker, scope, operation, params, signal);
			const requests = normalizeSpawnRequests(params);
			if (requests.length === 0) return failed("Provide a task assignment or a non-empty tasks batch.");
			if (requests.length > EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN) {
				return failed(`Task batch exceeds the maximum of ${EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN} assignments.`);
			}
			const children = await Promise.all(
				requests.map(async (request, index): Promise<EmpatraHostSubagentChildDetails> => {
					try {
						if (signal?.aborted) return { index, status: "failed", error: "Subagent assignment was cancelled before dispatch." };
						const result = await broker.spawn(scope, request);
						if (signal?.aborted) {
							await broker.interrupt(scope, result.childId).catch(() => undefined);
							return { childId: result.childId, index: result.index, status: "failed", error: "Subagent assignment was cancelled." };
						}
						return { childId: result.childId, index: result.index, status: result.status };
					} catch (error) {
						return { index, status: "failed", error: error instanceof Error ? error.message : String(error) };
					}
				}),
			);
			const failures = children.filter(child => child.status === "failed");
			const started = children.filter(child => child.status === "running");
			const status = started.length > 0 ? "running" : "failed";
			const summary =
				started.length === 1 && children.length === 1
					? `Subagent ${started[0]!.childId} started.`
					: `Started ${started.length} of ${children.length} subagents.`;
			const failureText = failures.length > 0 ? ` ${failures.length} assignment(s) failed to start.` : "";
			return {
				content: [{ type: "text", text: `${summary}${failureText}` }],
				details: {
					...(children.length === 1 && children[0]!.childId !== undefined
						? { childId: children[0]!.childId, index: children[0]!.index }
						: {}),
					children,
					status,
				},
				...(failures.length === children.length ? { isError: true } : {}),
			};
		} catch (error) {
			return failed(error instanceof Error ? error.message : String(error));
		}
	}
}

type SpawnRequest = { agentName?: string; assignment: string; modelId?: string };

const textEncoder = new TextEncoder();

function normalizeOperation(value: unknown): LifecycleOperation {
	if (value === undefined || value === "spawn") return "spawn";
	if (value === "list" || value === "steer" || value === "interrupt" || value === "close") return value;
	throw new Error("Operation must be one of spawn, list, steer, interrupt, or close.");
}

function boundedIdentifier(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string.`);
	const normalized = value.trim();
	if (normalized.length === 0 || textEncoder.encode(normalized).byteLength > 256) {
		throw new Error(`${label} is invalid.`);
	}
	for (const character of normalized) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 32 || codePoint === 127 || /\s/u.test(character)) throw new Error(`${label} is invalid.`);
	}
	return normalized;
}

function boundedAssignment(value: string, label: string): string {
	const assignment = value.trim();
	if (assignment.length === 0) throw new Error(`${label} must not be empty.`);
	if (textEncoder.encode(assignment).byteLength > EMPATRA_HOST_MAX_SUBAGENT_ASSIGNMENT_BYTES) {
		throw new Error(`${label} exceeds the ${EMPATRA_HOST_MAX_SUBAGENT_ASSIGNMENT_BYTES}-byte limit.`);
	}
	return assignment;
}

function selector(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${label} must be a string.`);
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeSpawnRequests(params: SubagentInput): SpawnRequest[] {
	if (params.childId !== undefined || params.message !== undefined) {
		throw new Error("Spawn shape cannot include childId or message.");
	}
	if (Array.isArray(params.tasks)) {
		if (params.tasks.length === 0) return [];
		if (params.tasks.length > EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN) {
			throw new Error(`Task batch exceeds the maximum of ${EMPATRA_HOST_MAX_SUBAGENTS_PER_TURN} assignments.`);
		}
		if (params.context === undefined) throw new Error("Batch context is required.");
		if (params.task !== undefined || params.agent !== undefined || params.model !== undefined) {
			throw new Error("Batch shape cannot include top-level agent, model, or task fields.");
		}
		const context = params.context.trim();
		const contextBytes = textEncoder.encode(context).byteLength;
		if (contextBytes > EMPATRA_HOST_MAX_SUBAGENT_ASSIGNMENT_BYTES) {
			throw new Error(`Batch context exceeds the ${EMPATRA_HOST_MAX_SUBAGENT_ASSIGNMENT_BYTES}-byte limit.`);
		}
		return params.tasks.map((item, index) => {
			const task = boundedAssignment(item.task, `Task ${index + 1}`);
			const assignment = context.length > 0 ? `${context}\n\nAssignment:\n${task}` : task;
			return {
				agentName: selector(item.agent, `Task ${index + 1} agent`),
				assignment: boundedAssignment(assignment, `Task ${index + 1} assignment`),
				modelId: selector(item.model, `Task ${index + 1} model`),
			};
		});
	}
	if (params.context !== undefined) throw new Error("Single task shape cannot include context.");
	if (params.task === undefined) return [];
	return [
		{
			agentName: selector(params.agent, "Agent"),
			assignment: boundedAssignment(params.task, "Task assignment"),
			modelId: selector(params.model, "Model"),
		},
	];
}

function lifecycleResult(
	operation: Exclude<LifecycleOperation, "spawn">,
	status: EmpatraHostSubagentToolDetails["status"],
	text: string,
	input: Partial<SubagentInput>,
): AgentToolResult<EmpatraHostSubagentToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: {
			operation,
			status,
			...(typeof input.childId === "string" ? { childId: input.childId } : {}),
		},
	};
}

async function executeLifecycleOperation(
	broker: ModelSubagentRpcBroker,
	scope: ModelSubagentRpcScope,
	operation: Exclude<LifecycleOperation, "spawn">,
	params: SubagentInput,
	signal?: AbortSignal,
): Promise<AgentToolResult<EmpatraHostSubagentToolDetails>> {
	if (signal?.aborted) return failed(`Subagent ${operation} was cancelled before dispatch.`);
	const hasSpawnFields =
		params.agent !== undefined ||
		params.model !== undefined ||
		params.task !== undefined ||
		params.context !== undefined ||
		params.tasks !== undefined;
	if (hasSpawnFields) return failed(`${operation} cannot include spawn fields.`);
	if (operation === "list") {
		if (params.childId !== undefined || params.message !== undefined) {
			return failed("List does not accept childId or message.");
		}
		const result = await broker.list(scope);
		const children = result.subagents.map(child => ({
			agentName: child.agentName,
			childId: child.childId,
			index: child.index,
			status: child.status,
			updatedAtMs: child.updatedAtMs,
		}));
		const text =
			children.length === 0
				? "No active subagents in this parent turn."
				: children.map(child => `- ${child.childId} [${child.agentName}] — ${child.status}`).join("\n");
		return {
			content: [{ type: "text", text }],
			details: { children, operation: "list", status: "completed" },
		};
	}
	const childId = boundedIdentifier(params.childId, "childId");
	if (operation === "steer") {
		if (params.message === undefined) return failed("Steer requires a non-empty message.");
		const message = boundedAssignment(params.message, "Steering message");
		await broker.steer(scope, childId, message);
		return lifecycleResult("steer", "running", `Steering message queued for subagent ${childId}.`, { childId });
	}
	if (params.message !== undefined) return failed(`${operation} does not accept message.`);
	if (operation === "interrupt") {
		await broker.interrupt(scope, childId);
		return lifecycleResult("interrupt", "aborted", `Interrupt requested for subagent ${childId}.`, { childId });
	}
	await broker.close(scope, childId);
	return lifecycleResult("close", "aborted", `Subagent ${childId} was closed.`, { childId });
}
