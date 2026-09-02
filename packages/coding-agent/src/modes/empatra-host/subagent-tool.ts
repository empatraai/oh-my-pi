import { type as arkType } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ModelSubagentRpcBroker, ModelSubagentRpcScope, ToolSession } from "../../tools";
import { EMPATRA_HOST_SUBAGENT_CAPABILITY } from "./subagent-broker";

const subagentSchema = arkType({
	"agent?": arkType("string").describe("Optional agent selector from the main-owned catalog"),
	"model?": arkType("string").describe("Optional managed model selector"),
	task: arkType("string").describe("Self-contained assignment for the delegated agent"),
});

type SubagentInput = typeof subagentSchema.infer;

export interface EmpatraHostSubagentToolDetails {
	childId?: string;
	index?: number;
	status: "failed" | "running";
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
	readonly summary = "Delegate a bounded assignment to a main-owned subagent";
	readonly description =
		"Delegate one self-contained assignment to a managed subagent. The desktop host chooses the workspace, environment, credentials, and execution policy. Only an optional agent/model selector and the assignment are accepted.";
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
		if (typeof value.agent === "string" && value.agent.trim()) details.push(`Agent: ${value.agent.trim()}`);
		if (typeof value.model === "string" && value.model.trim()) details.push(`Model: ${value.model.trim()}`);
		if (typeof value.task === "string") details.push(`Task:\n${value.task.trim()}`);
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
			const assignment = params.task.trim();
			if (assignment.length === 0) return failed("Task assignment must not be empty.");
			const result = await broker.spawn(scope, {
				agentName: params.agent?.trim() || undefined,
				assignment,
				modelId: params.model?.trim() || undefined,
			});
			return {
				content: [{ type: "text", text: `Subagent ${result.childId} started.` }],
				details: { childId: result.childId, index: result.index, status: result.status },
			};
		} catch (error) {
			return failed(error instanceof Error ? error.message : String(error));
		}
	}
}
