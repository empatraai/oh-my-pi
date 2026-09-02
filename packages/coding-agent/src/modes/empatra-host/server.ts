import { LineTooLongError, readLines } from "@oh-my-pi/pi-utils";

import { EmpatraHostProtocolError } from "./errors";
import {
	EMPATRA_HOST_MAX_FRAME_BYTES,
	EMPATRA_HOST_PROTOCOL_VERSION,
	type EmpatraHostCommand,
	type EmpatraHostEvent,
	type EmpatraHostInitializeCommand,
	type EmpatraHostToolOutboundFrame,
	parseEmpatraHostCommand,
	projectEmpatraHostFailure,
	serializeEmpatraHostFrame,
} from "./protocol";

export interface EmpatraHostRuntime {
	archiveThread(command: Extract<EmpatraHostCommand, { type: "thread_archive" }>): Promise<unknown>;
	clearThreadGoal(command: Extract<EmpatraHostCommand, { type: "goal_clear" }>): Promise<unknown>;
	compactThread(command: Extract<EmpatraHostCommand, { type: "thread_compact" }>): Promise<unknown>;
	deleteThread(command: Extract<EmpatraHostCommand, { type: "thread_delete" }>): Promise<unknown>;
	dispose(): Promise<void>;
	initialize(command: EmpatraHostInitializeCommand): Promise<unknown>;
	handleHostToolCancel(command: Extract<EmpatraHostCommand, { type: "host_tool_cancel" }>): void;
	handleHostToolResult(command: Extract<EmpatraHostCommand, { type: "host_tool_result" }>): void;
	noteInteractionActivity(command: Extract<EmpatraHostCommand, { type: "interaction_activity" }>): Promise<unknown>;
	resolvePlan(command: Extract<EmpatraHostCommand, { type: "plan_resolution" }>): Promise<unknown>;
	cancelInteraction(command: Extract<EmpatraHostCommand, { type: "interaction_cancel" }>): Promise<unknown>;
	respondToInteraction(command: Extract<EmpatraHostCommand, { type: "interaction_respond" }>): Promise<unknown>;
	interruptTurn(command: Extract<EmpatraHostCommand, { type: "turn_interrupt" }>): Promise<unknown>;
	steerTurn(command: Extract<EmpatraHostCommand, { type: "turn_steer" }>): Promise<unknown>;
	getThreadGoal(command: Extract<EmpatraHostCommand, { type: "goal_get" }>): Promise<unknown>;
	listThreads(command: Extract<EmpatraHostCommand, { type: "thread_list" }>): Promise<unknown>;
	listThreadTurns(command: Extract<EmpatraHostCommand, { type: "thread_turns" }>): Promise<unknown>;
	readThread(command: Extract<EmpatraHostCommand, { type: "thread_read" }>): Promise<unknown>;
	renameThread(command: Extract<EmpatraHostCommand, { type: "thread_rename" }>): Promise<unknown>;
	setEventSink(sink: (event: EmpatraHostEvent) => Promise<void>): void;
	setHostToolSink(sink: (frame: EmpatraHostToolOutboundFrame) => Promise<void>): void;
	replaceHostTools(command: Extract<EmpatraHostCommand, { type: "host_tools_replace" }>): Promise<unknown>;
	setThreadGoal(command: Extract<EmpatraHostCommand, { type: "goal_set" }>): Promise<unknown>;
	forkThread(command: Extract<EmpatraHostCommand, { type: "thread_fork" }>): Promise<unknown>;
	forkThreadAndStart(command: Extract<EmpatraHostCommand, { type: "thread_fork_and_start" }>): Promise<unknown>;
	rollbackThread(command: Extract<EmpatraHostCommand, { type: "thread_rollback" }>): Promise<unknown>;
	startThread(command: Extract<EmpatraHostCommand, { type: "thread_create" }>): Promise<unknown>;
	startThreadAndTurn(command: Extract<EmpatraHostCommand, { type: "thread_create_and_start" }>): Promise<unknown>;
	startTurn(command: Extract<EmpatraHostCommand, { type: "turn_start" }>): Promise<unknown>;
	unarchiveThread(command: Extract<EmpatraHostCommand, { type: "thread_unarchive" }>): Promise<unknown>;
}

export interface EmpatraHostServerOptions {
	input: ReadableStream<Uint8Array>;
	maxInflightCommands?: number;
	runtime: EmpatraHostRuntime;
	write: (frame: string) => Promise<void>;
}

const MAX_ACTIVATION_BARRIER_BYTES = 2 * EMPATRA_HOST_MAX_FRAME_BYTES;

interface ActivationBarrier {
	bytes: number;
	key: string;
	pending: Array<{
		frame: string;
		reject: (error: unknown) => void;
		resolve: () => void;
	}>;
	threadId: string | null;
	turnId: string;
}

function turnKey(threadId: string, turnId: string): string {
	return `${threadId}\u0000${turnId}`;
}

function commandActivationBarrier(command: EmpatraHostCommand): ActivationBarrier | undefined {
	if (command.type === "turn_start") {
		return {
			bytes: 0,
			key: `thread:${turnKey(command.threadId, command.turnId)}`,
			pending: [],
			threadId: command.threadId,
			turnId: command.turnId,
		};
	}
	if (command.type === "thread_create_and_start" || command.type === "thread_fork_and_start") {
		return {
			bytes: 0,
			key: `operation:${turnKey(command.operationId, command.turnId)}`,
			pending: [],
			threadId: null,
			turnId: command.turnId,
		};
	}
	if (
		command.type === "interaction_respond" ||
		command.type === "interaction_cancel" ||
		command.type === "plan_resolution"
	) {
		return {
			bytes: 0,
			key: `interaction:${command.id}`,
			pending: [],
			threadId: command.threadId,
			turnId: command.turnId,
		};
	}
	return undefined;
}

export async function runEmpatraHostServer(options: EmpatraHostServerOptions): Promise<void> {
	const maxInflightCommands = options.maxInflightCommands ?? 64;
	if (!Number.isSafeInteger(maxInflightCommands) || maxInflightCommands < 1 || maxInflightCommands > 1024) {
		throw new RangeError("maxInflightCommands must be between 1 and 1024");
	}
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const inflight = new Map<string, Promise<void>>();
	const activationBarriers = new Map<string, ActivationBarrier>();
	let initialized = false;
	let stopped = false;
	let writeTail = Promise.resolve();

	const writeSerialized = (frame: string): Promise<void> => {
		const next = writeTail.then(() => options.write(frame));
		writeTail = next.catch(() => undefined);
		return next;
	};
	const writeError = (id: string | null, error: unknown) => {
		const failure = projectEmpatraHostFailure(error);
		return writeSerialized(
			serializeEmpatraHostFrame({
				code: failure.code,
				error: failure.message,
				id,
				success: false,
				type: "host_response",
			}),
		);
	};
	const writeSuccess = (id: string, data?: unknown) => {
		return writeSerialized(
			serializeEmpatraHostFrame({
				...(data === undefined ? {} : { data }),
				id,
				success: true,
				type: "host_response",
			}),
		);
	};
	const writeTurnFrame = (frame: string, threadId: string, turnId: string): Promise<void> => {
		const barrier = [...activationBarriers.values()].find(
			candidate => candidate.turnId === turnId && (candidate.threadId === null || candidate.threadId === threadId),
		);
		if (!barrier) return writeSerialized(frame);
		const frameBytes = new TextEncoder().encode(frame).byteLength;
		if (barrier.bytes + frameBytes > MAX_ACTIVATION_BARRIER_BYTES) {
			return Promise.reject(
				new EmpatraHostProtocolError("event_backpressure", "Turn activation barrier exceeded its byte limit"),
			);
		}
		barrier.bytes += frameBytes;
		return new Promise<void>((resolve, reject) => {
			barrier.pending.push({ frame, reject, resolve });
		});
	};
	options.runtime.setEventSink(event => {
		try {
			const frame = serializeEmpatraHostFrame(event);
			return writeTurnFrame(frame, event.threadId, event.turnId);
		} catch (error) {
			return writeError(null, error);
		}
	});
	options.runtime.setHostToolSink(frame => {
		try {
			return writeTurnFrame(serializeEmpatraHostFrame(frame), frame.threadId, frame.turnId);
		} catch (error) {
			return writeError(null, error);
		}
	});
	const releaseActivationBarrier = async (barrier: ActivationBarrier): Promise<void> => {
		activationBarriers.delete(barrier.key);
		for (const pending of barrier.pending) {
			try {
				await writeSerialized(pending.frame);
				pending.resolve();
			} catch (error) {
				pending.reject(error);
			}
		}
	};
	const rejectActivationBarrier = (barrier: ActivationBarrier, error: unknown): void => {
		activationBarriers.delete(barrier.key);
		for (const pending of barrier.pending) pending.reject(error);
	};
	const dispatch = (
		command: Exclude<EmpatraHostCommand, EmpatraHostInitializeCommand | { type: "host_shutdown" }>,
	) => {
		switch (command.type) {
			case "thread_create":
				return options.runtime.startThread(command);
			case "thread_create_and_start":
				return options.runtime.startThreadAndTurn(command);
			case "thread_fork":
				return options.runtime.forkThread(command);
			case "thread_fork_and_start":
				return options.runtime.forkThreadAndStart(command);
			case "thread_rollback":
				return options.runtime.rollbackThread(command);
			case "thread_compact":
				return options.runtime.compactThread(command);
			case "thread_archive":
				return options.runtime.archiveThread(command);
			case "thread_unarchive":
				return options.runtime.unarchiveThread(command);
			case "thread_delete":
				return options.runtime.deleteThread(command);
			case "thread_rename":
				return options.runtime.renameThread(command);
			case "thread_list":
				return options.runtime.listThreads(command);
			case "thread_read":
				return options.runtime.readThread(command);
			case "thread_turns":
				return options.runtime.listThreadTurns(command);
			case "goal_get":
				return options.runtime.getThreadGoal(command);
			case "goal_set":
				return options.runtime.setThreadGoal(command);
			case "goal_clear":
				return options.runtime.clearThreadGoal(command);
			case "interaction_activity":
				return options.runtime.noteInteractionActivity(command);
			case "interaction_cancel":
				return options.runtime.cancelInteraction(command);
			case "interaction_respond":
				return options.runtime.respondToInteraction(command);
			case "plan_resolution":
				return options.runtime.resolvePlan(command);
			case "host_tools_replace":
				return options.runtime.replaceHostTools(command);
			case "host_tool_cancel":
				return options.runtime.handleHostToolCancel(command);
			case "host_tool_result":
				return options.runtime.handleHostToolResult(command);
			case "turn_start":
				return options.runtime.startTurn(command);
			case "turn_interrupt":
				return options.runtime.interruptTurn(command);
			case "turn_steer":
				return options.runtime.steerTurn(command);
		}
	};

	await writeSerialized(
		serializeEmpatraHostFrame({
			maxFrameBytes: EMPATRA_HOST_MAX_FRAME_BYTES,
			protocolVersion: EMPATRA_HOST_PROTOCOL_VERSION,
			type: "host_ready",
		}),
	);

	try {
		for await (const line of readLines(options.input, undefined, EMPATRA_HOST_MAX_FRAME_BYTES)) {
			if (stopped) break;
			let command: EmpatraHostCommand;
			try {
				command = parseEmpatraHostCommand(decoder.decode(line).trim());
			} catch (error) {
				await writeError(null, error);
				continue;
			}

			if (command.type === "host_shutdown") {
				stopped = true;
				await Promise.allSettled(inflight.values());
				await options.runtime.dispose();
				await writeSuccess(command.id);
				break;
			}
			if (command.type === "host_initialize") {
				if (initialized) {
					await writeError(
						command.id,
						new EmpatraHostProtocolError("already_initialized", "Host is already initialized"),
					);
					continue;
				}
				try {
					const data = await options.runtime.initialize(command);
					initialized = true;
					await writeSuccess(command.id, data);
				} catch (error) {
					await writeError(command.id, error);
				}
				continue;
			}
			if (!initialized) {
				await writeError(
					command.id,
					new EmpatraHostProtocolError("not_initialized", "host_initialize must complete first"),
				);
				continue;
			}
			if (command.type === "host_tool_result" || command.type === "host_tool_cancel") {
				try {
					if (command.type === "host_tool_result") options.runtime.handleHostToolResult(command);
					else options.runtime.handleHostToolCancel(command);
				} catch (error) {
					await writeError(command.id, error);
				}
				continue;
			}
			if (inflight.has(command.id)) {
				await writeError(
					command.id,
					new EmpatraHostProtocolError("duplicate_request", "A command with this id is already running"),
				);
				continue;
			}
			if (inflight.size >= maxInflightCommands) {
				await writeError(command.id, new EmpatraHostProtocolError("server_busy", "The host command queue is full"));
				continue;
			}

			const barrier = commandActivationBarrier(command);
			if (barrier && [...activationBarriers.values()].some(candidate => candidate.turnId === barrier.turnId)) {
				await writeError(
					command.id,
					new EmpatraHostProtocolError("duplicate_request", "A matching turn activation is already pending"),
				);
				continue;
			}
			if (barrier) activationBarriers.set(barrier.key, barrier);
			const task = (async () => {
				let data: unknown;
				try {
					data = await dispatch(command);
				} catch (error) {
					await writeError(command.id, error);
					if (barrier) rejectActivationBarrier(barrier, error);
					return;
				}
				try {
					await writeSuccess(command.id, data);
				} catch (error) {
					await writeError(command.id, error);
					if (barrier) rejectActivationBarrier(barrier, error);
					return;
				}
				if (barrier) await releaseActivationBarrier(barrier);
			})().finally(() => inflight.delete(command.id));
			inflight.set(command.id, task);
		}
	} catch (error) {
		if (error instanceof LineTooLongError)
			await writeError(null, new EmpatraHostProtocolError("frame_too_large", error.message));
		else throw error;
	} finally {
		await Promise.allSettled(inflight.values());
		if (!stopped) await options.runtime.dispose();
		await writeTail;
	}
}
