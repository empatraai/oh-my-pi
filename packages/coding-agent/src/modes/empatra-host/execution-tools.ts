import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult, ToolTier } from "@oh-my-pi/pi-agent-core";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import { EmpatraHostProtocolError } from "./errors";
import {
	EMPATRA_HOST_MAX_EXECUTION_OUTPUT_BYTES,
	EMPATRA_HOST_MAX_EXECUTION_TIMEOUT_MS,
	type EmpatraHostExecutionBroker,
	type EmpatraHostExecutionResult,
	type EmpatraHostExecutionScope,
} from "./execution-broker";
import { tokenizeShellSegments } from "../../tools/shell-tokenize";

const readParameters = type({
	path: "string",
	"maxBytes?": "number",
	"offsetBytes?": "number",
});
const writeParameters = type({
	path: "string",
	content: "string",
	"expectedSha256?": "string",
});
const bashParameters = type({
	command: "string",
	"timeout?": "number",
	"maxOutputBytes?": "number",
});

function result(result: EmpatraHostExecutionResult): AgentToolResult<EmpatraHostExecutionResult> {
	return {
		content: [{ type: "text", text: result.output || "(no output)" }],
		details: result,
	};
}

function scopeOrThrow(getScope: () => EmpatraHostExecutionScope | undefined): EmpatraHostExecutionScope {
		const scope = getScope();
		if (!scope) throw new EmpatraHostProtocolError("stale_turn", "Native execution is only available during an active turn");
		return scope;
}

function boundedNumber(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new EmpatraHostProtocolError("execution_request_invalid", "Execution limit is invalid");
	}
	return value;
}

/** Main-owned native tools for restricted Empatra host sessions. */
export function createEmpatraHostExecutionTools(
	broker: EmpatraHostExecutionBroker,
	getScope: () => EmpatraHostExecutionScope | undefined,
): CustomTool[] {
	const read: CustomTool<typeof readParameters, EmpatraHostExecutionResult> = {
		name: "read",
		label: "Read",
		description: "Read a UTF-8 file through the approved Empatra desktop workspace boundary.",
		parameters: readParameters,
		approval: "read" satisfies ToolTier,
		strict: true,
		async execute(_id, params, _update, _ctx, signal) {
			const scope = scopeOrThrow(getScope);
			return result(await broker.execute({
				...scope,
				maxBytes: boundedNumber(params.maxBytes, EMPATRA_HOST_MAX_EXECUTION_OUTPUT_BYTES, EMPATRA_HOST_MAX_EXECUTION_OUTPUT_BYTES),
				...(params.offsetBytes === undefined ? {} : { offsetBytes: params.offsetBytes }),
				operation: "filesystem.read",
				path: params.path,
			}, signal));
		},
	};
	const write: CustomTool<typeof writeParameters, EmpatraHostExecutionResult> = {
		name: "write",
		label: "Write",
		description: "Write a file atomically through the approved Empatra desktop workspace boundary.",
		parameters: writeParameters,
		approval: "write" satisfies ToolTier,
		strict: true,
		async execute(_id, params, _update, _ctx, signal) {
			const scope = scopeOrThrow(getScope);
			return result(await broker.execute({
				...scope,
				content: params.content,
				...(params.expectedSha256 === undefined ? {} : { expectedSha256: params.expectedSha256 }),
				operation: "filesystem.write",
				path: params.path,
			}, signal));
		},
	};
	const bash: CustomTool<typeof bashParameters, EmpatraHostExecutionResult> = {
		name: "bash",
		label: "Bash",
		description: "Run one non-shell command through the approved Empatra desktop sandbox. Shell operators and environment overrides are not supported.",
		parameters: bashParameters,
		approval: "exec" satisfies ToolTier,
		strict: true,
		async execute(_id, params, _update, _ctx, signal) {
			const scope = scopeOrThrow(getScope);
			const segments = tokenizeShellSegments(params.command);
			if (segments.length !== 1 || segments[0]?.length === 0) {
				throw new EmpatraHostProtocolError("execution_request_invalid", "Only one direct command without shell operators is allowed");
			}
			const [command, ...args] = segments[0];
			return result(await broker.execute({
				...scope,
				args,
				command,
				maxOutputBytes: boundedNumber(params.maxOutputBytes, EMPATRA_HOST_MAX_EXECUTION_OUTPUT_BYTES, EMPATRA_HOST_MAX_EXECUTION_OUTPUT_BYTES),
				operation: "process.exec",
				timeoutMs: boundedNumber(params.timeout, 30_000, EMPATRA_HOST_MAX_EXECUTION_TIMEOUT_MS),
			}, signal));
		},
	};
	return [read, write, bash];
}
