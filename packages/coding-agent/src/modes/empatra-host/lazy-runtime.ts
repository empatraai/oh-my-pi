import type {
	EmpatraHostCommand,
	EmpatraHostEvent,
	EmpatraHostInitializeCommand,
	EmpatraHostToolOutboundFrame,
} from "./protocol";
import type { EmpatraHostRuntime } from "./server";

type RuntimeFactory = () => Promise<EmpatraHostRuntime>;

async function loadEmpatraHostRuntime(): Promise<EmpatraHostRuntime> {
	const { EmpatraHostAgentRuntime } = await import("./runtime");
	return new EmpatraHostAgentRuntime();
}

/**
 * Preserves the host server boundary while deferring the agent/session graph
 * until the only command that is allowed to initialize it. This keeps the
 * process ready to receive framed input without constructing provider, plugin,
 * or session infrastructure before Electron grants the host capability.
 */
export class LazyEmpatraHostRuntime implements EmpatraHostRuntime {
	#eventSink?: (event: EmpatraHostEvent) => Promise<void>;
	#hostToolSink?: (frame: EmpatraHostToolOutboundFrame) => Promise<void>;
	#runtime?: EmpatraHostRuntime;
	readonly #runtimeFactory: RuntimeFactory;

	constructor(runtimeFactory: RuntimeFactory = loadEmpatraHostRuntime) {
		this.#runtimeFactory = runtimeFactory;
	}

	async #load(): Promise<EmpatraHostRuntime> {
		if (!this.#runtime) {
			const runtime = await this.#runtimeFactory();
			if (this.#eventSink) runtime.setEventSink(this.#eventSink);
			if (this.#hostToolSink) runtime.setHostToolSink(this.#hostToolSink);
			this.#runtime = runtime;
		}
		return this.#runtime;
	}

	#requireRuntime(): EmpatraHostRuntime {
		if (!this.#runtime) throw new Error("Empatra host runtime is not initialized");
		return this.#runtime;
	}

	archiveThread(command: Extract<EmpatraHostCommand, { type: "thread_archive" }>): Promise<unknown> {
		return this.#requireRuntime().archiveThread(command);
	}

	getAtomicOperationStatus(
		command: Extract<EmpatraHostCommand, { type: "atomic_operation_status" }>,
	): Promise<unknown> {
		return this.#requireRuntime().getAtomicOperationStatus(command);
	}

	cancelInteraction(command: Extract<EmpatraHostCommand, { type: "interaction_cancel" }>): Promise<unknown> {
		return this.#requireRuntime().cancelInteraction(command);
	}

	clearThreadGoal(command: Extract<EmpatraHostCommand, { type: "goal_clear" }>): Promise<unknown> {
		return this.#requireRuntime().clearThreadGoal(command);
	}

	compactThread(command: Extract<EmpatraHostCommand, { type: "thread_compact" }>): Promise<unknown> {
		return this.#requireRuntime().compactThread(command);
	}

	deleteThread(command: Extract<EmpatraHostCommand, { type: "thread_delete" }>): Promise<unknown> {
		return this.#requireRuntime().deleteThread(command);
	}

	dispose(): Promise<void> {
		return this.#runtime?.dispose() ?? Promise.resolve();
	}

	async initialize(command: EmpatraHostInitializeCommand): Promise<unknown> {
		return (await this.#load()).initialize(command);
	}

	handleHostToolCancel(command: Extract<EmpatraHostCommand, { type: "host_tool_cancel" }>): void {
		this.#requireRuntime().handleHostToolCancel(command);
	}

	handleHostToolResult(command: Extract<EmpatraHostCommand, { type: "host_tool_result" }>): void {
		this.#requireRuntime().handleHostToolResult(command);
	}

	handleExecutionBrokerResponse(command: Extract<EmpatraHostCommand, { type: "execution_broker_response" }>): void {
		this.#requireRuntime().handleExecutionBrokerResponse(command);
	}

	interruptTurn(command: Extract<EmpatraHostCommand, { type: "turn_interrupt" }>): Promise<unknown> {
		return this.#requireRuntime().interruptTurn(command);
	}

	listThreadTurns(command: Extract<EmpatraHostCommand, { type: "thread_turns" }>): Promise<unknown> {
		return this.#requireRuntime().listThreadTurns(command);
	}

	listThreads(command: Extract<EmpatraHostCommand, { type: "thread_list" }>): Promise<unknown> {
		return this.#requireRuntime().listThreads(command);
	}

	noteInteractionActivity(command: Extract<EmpatraHostCommand, { type: "interaction_activity" }>): Promise<unknown> {
		return this.#requireRuntime().noteInteractionActivity(command);
	}

	readThread(command: Extract<EmpatraHostCommand, { type: "thread_read" }>): Promise<unknown> {
		return this.#requireRuntime().readThread(command);
	}

	renameThread(command: Extract<EmpatraHostCommand, { type: "thread_rename" }>): Promise<unknown> {
		return this.#requireRuntime().renameThread(command);
	}

	respondToInteraction(command: Extract<EmpatraHostCommand, { type: "interaction_respond" }>): Promise<unknown> {
		return this.#requireRuntime().respondToInteraction(command);
	}

	resolvePlan(command: Extract<EmpatraHostCommand, { type: "plan_resolution" }>): Promise<unknown> {
		return this.#requireRuntime().resolvePlan(command);
	}

	rollbackThread(command: Extract<EmpatraHostCommand, { type: "thread_rollback" }>): Promise<unknown> {
		return this.#requireRuntime().rollbackThread(command);
	}

	setEventSink(sink: (event: EmpatraHostEvent) => Promise<void>): void {
		this.#eventSink = sink;
		this.#runtime?.setEventSink(sink);
	}

	setHostToolSink(sink: (frame: EmpatraHostToolOutboundFrame) => Promise<void>): void {
		this.#hostToolSink = sink;
		this.#runtime?.setHostToolSink(sink);
	}

	setThreadGoal(command: Extract<EmpatraHostCommand, { type: "goal_set" }>): Promise<unknown> {
		return this.#requireRuntime().setThreadGoal(command);
	}

	getThreadGoal(command: Extract<EmpatraHostCommand, { type: "goal_get" }>): Promise<unknown> {
		return this.#requireRuntime().getThreadGoal(command);
	}

	steerTurn(command: Extract<EmpatraHostCommand, { type: "turn_steer" }>): Promise<unknown> {
		return this.#requireRuntime().steerTurn(command);
	}

	startThread(command: Extract<EmpatraHostCommand, { type: "thread_create" }>): Promise<unknown> {
		return this.#requireRuntime().startThread(command);
	}

	startThreadAndTurn(command: Extract<EmpatraHostCommand, { type: "thread_create_and_start" }>): Promise<unknown> {
		return this.#requireRuntime().startThreadAndTurn(command);
	}

	startTurn(command: Extract<EmpatraHostCommand, { type: "turn_start" }>): Promise<unknown> {
		return this.#requireRuntime().startTurn(command);
	}

	forkThread(command: Extract<EmpatraHostCommand, { type: "thread_fork" }>): Promise<unknown> {
		return this.#requireRuntime().forkThread(command);
	}

	forkThreadAndStart(command: Extract<EmpatraHostCommand, { type: "thread_fork_and_start" }>): Promise<unknown> {
		return this.#requireRuntime().forkThreadAndStart(command);
	}

	replaceHostTools(command: Extract<EmpatraHostCommand, { type: "host_tools_replace" }>): Promise<unknown> {
		return this.#requireRuntime().replaceHostTools(command);
	}

	unarchiveThread(command: Extract<EmpatraHostCommand, { type: "thread_unarchive" }>): Promise<unknown> {
		return this.#requireRuntime().unarchiveThread(command);
	}
}
