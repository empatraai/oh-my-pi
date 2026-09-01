import * as path from "node:path";

import type { AgentSessionEvent } from "../../session/agent-session-events";
import type {
	EmpatraHostToolExecutionEndPayload,
	EmpatraHostToolExecutionStartPayload,
	EmpatraHostToolExecutionUpdatePayload,
	EmpatraHostToolFileChange,
} from "./protocol";

export const EMPATRA_HOST_TOOL_ENTRY = "empatra.host.tool.v1";
export const EMPATRA_HOST_TOOL_ENTRY_VERSION = 1 as const;

export const EMPATRA_HOST_MAX_TOOL_ARGUMENT_BYTES = 16 * 1024;
export const EMPATRA_HOST_MAX_TOOL_RESULT_BYTES = 60 * 1024;
export const EMPATRA_HOST_MAX_TOOL_CHANGE_BYTES = 256 * 1024;
export const EMPATRA_HOST_MAX_TOOL_FILE_CHANGE_BYTES = 60 * 1024;
const EMPATRA_HOST_MAX_LIVE_CHANGE_BYTES = 56 * 1024;
const EMPATRA_HOST_MAX_END_TEXT_BYTES = 56 * 1024;

const REDACTED = "[REDACTED]";
const OUTSIDE_WORKSPACE = "[OUTSIDE_WORKSPACE]";
const encoder = new TextEncoder();
const PATH_KEY =
	/(?:^|[_-])(cwd|directory|file|file[_-]?path|from|path|source|source[_-]?path|target|target[_-]?path|to|workspace)(?:$|[_-])/iu;

type JsonSafe = boolean | number | string | null | JsonSafe[] | { [key: string]: JsonSafe };

export type EmpatraHostPersistedToolEvent = Readonly<{
	generation: number;
	payload:
		| EmpatraHostToolExecutionEndPayload
		| EmpatraHostToolExecutionStartPayload
		| EmpatraHostToolExecutionUpdatePayload;
	sequence: number;
	turnId: string;
	version: typeof EMPATRA_HOST_TOOL_ENTRY_VERSION;
}>;

export type EmpatraHostProjectedToolEvent = Readonly<{
	payload:
		| EmpatraHostToolExecutionEndPayload
		| EmpatraHostToolExecutionStartPayload
		| EmpatraHostToolExecutionUpdatePayload;
	outputText: string;
}>;

export interface EmpatraHostToolProjectionContext {
	previousOutputText?: string;
	startPayload?: EmpatraHostToolExecutionStartPayload;
	workspaceRoots: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
	const words = key
		.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter(Boolean);
	return (
		words.some(word =>
			[
				"auth",
				"authorization",
				"cookie",
				"cost",
				"credential",
				"credentials",
				"env",
				"header",
				"headers",
				"metadata",
				"passwd",
				"password",
				"passphrase",
				"provider",
				"secret",
				"token",
				"usage",
			].includes(word),
		) ||
		(words.includes("key") && (words.includes("api") || words.includes("private") || words.includes("access")))
	);
}

function redactText(value: string, workspaceRoots: readonly string[]): string {
	const credentialSafe = value
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/giu, "$1[REDACTED]@")
		.replace(
			/\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)\s*:\s*[^\r\n'"|&]+/giu,
			"$1: [REDACTED]",
		)
		.replace(
			/\b(api[_-]?key|auth|authorization|token|access[_-]?token|refresh[_-]?token|password|passwd|passphrase|client[_-]?secret|secret|credential(?:s)?|cookie)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/giu,
			"$1=[REDACTED]",
		)
		.replace(
			/(["']?(?:api[_-]?key|auth|authorization|token|access[_-]?token|refresh[_-]?token|password|passwd|passphrase|client[_-]?secret|secret|credential(?:s)?|cookie)["']?\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,}\s]+)/giu,
			'$1"[REDACTED]"',
		)
		.replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, REDACTED)
		.replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED)
		.replace(
			/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/gu,
			REDACTED,
		);
	return credentialSafe.replace(
		/(^|[\s'"`(=,:])((?:[A-Za-z]:\\[^\s'"`]+|\/(?:[^\s'"`/]+\/)*[^\s'"`,;)]*))/gu,
		(_match, prefix: string, candidate: string) => {
			const safe = projectWorkspacePath(candidate, workspaceRoots);
			return `${prefix}${safe ?? OUTSIDE_WORKSPACE}`;
		},
	);
}

function projectWorkspacePath(value: string, workspaceRoots: readonly string[]): string | undefined {
	if (value.includes("\0")) return undefined;
	const windowsAbsolute = !path.isAbsolute(value) && path.win32.isAbsolute(value);
	if (!path.isAbsolute(value) && !windowsAbsolute) {
		const normalizedRelative = path.normalize(value);
		if (
			normalizedRelative === ".." ||
			normalizedRelative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(normalizedRelative)
		)
			return undefined;
		return normalizedRelative === "." ? "." : normalizedRelative.split(path.sep).join("/");
	}
	const normalized = windowsAbsolute ? path.win32.resolve(value) : path.resolve(value);
	for (const root of workspaceRoots) {
		if (windowsAbsolute ? !path.win32.isAbsolute(root) : !path.isAbsolute(root)) continue;
		const normalizedRoot = windowsAbsolute ? path.win32.resolve(root) : path.resolve(root);
		const relative = windowsAbsolute
			? path.win32.relative(normalizedRoot, normalized)
			: path.relative(normalizedRoot, normalized);
		const separator = windowsAbsolute ? path.win32.sep : path.sep;
		if (relative === "") return ".";
		if (
			relative !== ".." &&
			!relative.startsWith(`..${separator}`) &&
			!path.isAbsolute(relative) &&
			!path.win32.isAbsolute(relative)
		) {
			return relative.split(separator).join("/");
		}
	}
	return undefined;
}

function redactJson(value: unknown, workspaceRoots: readonly string[], key?: string): JsonSafe {
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") {
		if (key && PATH_KEY.test(key)) return projectWorkspacePath(value, workspaceRoots) ?? OUTSIDE_WORKSPACE;
		return redactText(value, workspaceRoots);
	}
	if (Array.isArray(value)) return value.map(item => redactJson(item, workspaceRoots));
	if (!isRecord(value)) throw new Error("Tool projection rejected a non-JSON value");
	const result: { [key: string]: JsonSafe } = {};
	for (const [nestedKey, nested] of Object.entries(value)) {
		result[nestedKey] = isSensitiveKey(nestedKey) ? REDACTED : redactJson(nested, workspaceRoots, nestedKey);
	}
	return result;
}

function truncateJsonString(value: string, maxBytes: number): Readonly<{ text: string; truncated: boolean }> {
	if (encoder.encode(JSON.stringify(value)).byteLength <= maxBytes) return { text: value, truncated: false };
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (encoder.encode(JSON.stringify(value.slice(0, middle))).byteLength <= maxBytes) low = middle;
		else high = middle - 1;
	}
	let end = low;
	if (end > 0) {
		const code = value.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	}
	return { text: value.slice(0, end), truncated: true };
}

function isSafePersistedText(value: string): boolean {
	return redactText(value, []) === value;
}

function isValidIdentity(value: string): boolean {
	return value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
}

function projectArguments(value: unknown, workspaceRoots: readonly string[]) {
	const serialized = JSON.stringify(redactJson(value, workspaceRoots));
	return truncateJsonString(serialized, EMPATRA_HOST_MAX_TOOL_ARGUMENT_BYTES);
}

function textContent(
	value: unknown,
	workspaceRoots: readonly string[],
): Readonly<{ text: string; omittedImages: boolean }> {
	if (!isRecord(value) || !Array.isArray(value.content)) return { text: "", omittedImages: false };
	const text: string[] = [];
	let omittedImages = false;
	for (const block of value.content) {
		if (!isRecord(block) || typeof block.type !== "string") continue;
		if (block.type === "text" && typeof block.text === "string") text.push(redactText(block.text, workspaceRoots));
		else if (block.type === "image") omittedImages = true;
	}
	return { text: text.join("\n"), omittedImages };
}

function changeKind(value: unknown): EmpatraHostToolFileChange["kind"] {
	return value === "create" || value === "delete" || value === "move" || value === "modify" ? value : "modify";
}

function projectChange(value: unknown, workspaceRoots: readonly string[]): EmpatraHostToolFileChange | undefined {
	if (!isRecord(value) || typeof value.path !== "string" || typeof value.diff !== "string") return undefined;
	const safePath = projectWorkspacePath(value.path, workspaceRoots);
	if (!safePath) return undefined;
	const projected = truncateJsonString(
		redactText(value.diff, workspaceRoots),
		EMPATRA_HOST_MAX_TOOL_FILE_CHANGE_BYTES,
	);
	return {
		diff: projected.text,
		diffTruncated: projected.truncated,
		kind: changeKind(value.op),
		path: safePath,
	};
}

function projectChanges(
	value: unknown,
	workspaceRoots: readonly string[],
): Readonly<{ changes: readonly EmpatraHostToolFileChange[]; rejected: boolean }> {
	if (!isRecord(value)) return { changes: [], rejected: false };
	const details = isRecord(value.details) ? value.details : undefined;
	if (!details) return { changes: [], rejected: false };
	const candidates = Array.isArray(details.perFileResults)
		? details.perFileResults
		: typeof details.path === "string" && typeof details.diff === "string"
			? [details]
			: [];
	const changes = candidates
		.map(candidate => projectChange(candidate, workspaceRoots))
		.filter(change => change !== undefined);
	return { changes, rejected: changes.length !== candidates.length };
}

function boundChanges(changes: readonly EmpatraHostToolFileChange[]) {
	const result: EmpatraHostToolFileChange[] = [];
	let bytes = 0;
	let truncated = false;
	for (const change of changes) {
		const changeBytes = encoder.encode(JSON.stringify(change)).byteLength;
		if (bytes + changeBytes > Math.min(EMPATRA_HOST_MAX_TOOL_CHANGE_BYTES, EMPATRA_HOST_MAX_LIVE_CHANGE_BYTES)) {
			truncated = true;
			break;
		}
		result.push(change);
		bytes += changeBytes;
	}
	return { changes: result, truncated };
}

export function projectEmpatraHostToolEvent(
	event: Extract<AgentSessionEvent, { type: "tool_execution_end" | "tool_execution_start" | "tool_execution_update" }>,
	context: EmpatraHostToolProjectionContext,
): EmpatraHostProjectedToolEvent {
	if (!isValidIdentity(event.toolCallId) || !isValidIdentity(event.toolName)) {
		throw new Error("Tool projection rejected an invalid identity");
	}
	if (event.type === "tool_execution_start") {
		const projected = projectArguments(event.args, context.workspaceRoots);
		return {
			outputText: "",
			payload: {
				argumentsText: projected.text,
				argumentsTruncated: projected.truncated,
				phase: "start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
			},
		};
	}
	if (event.type === "tool_execution_update") {
		const projectedChanges = projectChanges(event.partialResult, context.workspaceRoots);
		if (projectedChanges.changes.length > 0 || projectedChanges.rejected) {
			const bounded = boundChanges(projectedChanges.changes);
			return {
				outputText: context.previousOutputText ?? "",
				payload: {
					phase: "update",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					update: {
						changes: bounded.changes,
						changesTruncated: bounded.truncated || projectedChanges.rejected,
						type: "changes_snapshot",
					},
				},
			};
		}
		const content = textContent(event.partialResult, context.workspaceRoots);
		const projected = truncateJsonString(content.text, EMPATRA_HOST_MAX_TOOL_RESULT_BYTES);
		const previous = context.previousOutputText ?? "";
		if (!projected.truncated && projected.text.startsWith(previous)) {
			return {
				outputText: projected.text,
				payload: {
					phase: "update",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					update: {
						resultText: projected.text.slice(previous.length),
						resultTruncated: false,
						type: "output_delta",
					},
				},
			};
		}
		return {
			outputText: projected.text,
			payload: {
				phase: "update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				update: {
					resultText: projected.text,
					resultTruncated: projected.truncated || content.omittedImages,
					type: "output_snapshot",
				},
			},
		};
	}
	const content = textContent(event.result, context.workspaceRoots);
	if (!context.startPayload) throw new Error("Tool projection end is missing its safe start payload");
	const argumentBytes = encoder.encode(JSON.stringify(context.startPayload.argumentsText)).byteLength;
	const resultBudget = Math.max(2, EMPATRA_HOST_MAX_END_TEXT_BYTES - argumentBytes);
	const projected = truncateJsonString(content.text, Math.min(EMPATRA_HOST_MAX_TOOL_RESULT_BYTES, resultBudget));
	return {
		outputText: projected.text,
		payload: {
			argumentsText: context.startPayload.argumentsText,
			argumentsTruncated: context.startPayload.argumentsTruncated,
			failed: event.isError === true,
			phase: "end",
			resultText: projected.text,
			resultTruncated: projected.truncated || content.omittedImages,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
		},
	};
}

export function parseEmpatraHostPersistedToolEvent(value: unknown): EmpatraHostPersistedToolEvent | undefined {
	if (
		!isRecord(value) ||
		value.version !== EMPATRA_HOST_TOOL_ENTRY_VERSION ||
		!Number.isSafeInteger(value.generation) ||
		(value.generation as number) < 0 ||
		!Number.isSafeInteger(value.sequence) ||
		(value.sequence as number) < 1 ||
		typeof value.turnId !== "string" ||
		!isValidIdentity(value.turnId) ||
		!isRecord(value.payload)
	) {
		return undefined;
	}
	const payload = value.payload;
	if (payload.phase === "start") {
		if (
			typeof payload.toolCallId !== "string" ||
			!isValidIdentity(payload.toolCallId) ||
			typeof payload.toolName !== "string" ||
			!isValidIdentity(payload.toolName) ||
			typeof payload.argumentsText !== "string" ||
			typeof payload.argumentsTruncated !== "boolean" ||
			encoder.encode(JSON.stringify(payload.argumentsText)).byteLength > EMPATRA_HOST_MAX_TOOL_ARGUMENT_BYTES ||
			!isSafePersistedText(payload.argumentsText)
		)
			return undefined;
		return value as EmpatraHostPersistedToolEvent;
	}
	if (payload.phase === "end") {
		if (
			typeof payload.toolCallId !== "string" ||
			!isValidIdentity(payload.toolCallId) ||
			typeof payload.toolName !== "string" ||
			!isValidIdentity(payload.toolName) ||
			typeof payload.argumentsText !== "string" ||
			typeof payload.argumentsTruncated !== "boolean" ||
			encoder.encode(JSON.stringify(payload.argumentsText)).byteLength > EMPATRA_HOST_MAX_TOOL_ARGUMENT_BYTES ||
			!isSafePersistedText(payload.argumentsText) ||
			typeof payload.resultText !== "string" ||
			typeof payload.resultTruncated !== "boolean" ||
			encoder.encode(JSON.stringify(payload.resultText)).byteLength > EMPATRA_HOST_MAX_TOOL_RESULT_BYTES ||
			!isSafePersistedText(payload.resultText) ||
			typeof payload.failed !== "boolean"
		)
			return undefined;
		return value as EmpatraHostPersistedToolEvent;
	}
	if (
		payload.phase !== "update" ||
		typeof payload.toolCallId !== "string" ||
		!isValidIdentity(payload.toolCallId) ||
		typeof payload.toolName !== "string" ||
		!isValidIdentity(payload.toolName) ||
		!isRecord(payload.update)
	) {
		return undefined;
	}
	const update = payload.update;
	if (
		(update.type === "output_delta" || update.type === "output_snapshot") &&
		typeof update.resultText === "string" &&
		typeof update.resultTruncated === "boolean" &&
		encoder.encode(JSON.stringify(update.resultText)).byteLength <= EMPATRA_HOST_MAX_TOOL_RESULT_BYTES &&
		isSafePersistedText(update.resultText)
	)
		return value as EmpatraHostPersistedToolEvent;
	if (
		update.type === "changes_snapshot" &&
		Array.isArray(update.changes) &&
		typeof update.changesTruncated === "boolean"
	) {
		for (const change of update.changes) {
			if (
				!isRecord(change) ||
				typeof change.path !== "string" ||
				typeof change.diff !== "string" ||
				typeof change.diffTruncated !== "boolean" ||
				!isSafePersistedText(change.diff) ||
				path.isAbsolute(change.path) ||
				projectWorkspacePath(change.path, []) !== change.path ||
				(change.kind !== "create" && change.kind !== "delete" && change.kind !== "modify" && change.kind !== "move")
			)
				return undefined;
		}
		return value as EmpatraHostPersistedToolEvent;
	}
	return undefined;
}
