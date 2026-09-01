import type { SessionEntry } from "../../session/session-entries";
import { EmpatraHostProtocolError } from "./errors";
import type {
	EmpatraHostProjectedImageBlock,
	EmpatraHostToolExecutionEndPayload,
	EmpatraHostToolExecutionStartPayload,
} from "./protocol";
import { EMPATRA_HOST_TOOL_ENTRY, parseEmpatraHostPersistedToolEvent } from "./tool-projection";
import { parseEmpatraHostTurnMarker } from "./turn-marker";
import {
	type EmpatraHostPersistedUserMedia,
	parseEmpatraHostUserMediaCancellation,
	parseEmpatraHostUserMediaMarker,
	projectEmpatraHostFallbackImages,
} from "./user-media-projection";

export type EmpatraHostProjectedBlock =
	| Readonly<{ blockType: "reasoning" | "text"; text: string }>
	| Readonly<EmpatraHostProjectedImageBlock>
	| Readonly<{
			blockType: "tool_call";
			failed: boolean;
			hasResult: true;
			id: string;
			toolArgumentsText: string;
			toolArgumentsTruncated: boolean;
			toolName: string;
			toolResultText: string;
			toolResultTruncated: boolean;
	  }>;

export type EmpatraHostProjectedMessage = Readonly<{
	blocks: readonly EmpatraHostProjectedBlock[];
	id: string;
	parentId: string | null;
	role: "assistant" | "user";
	timestamp: string;
	turnId?: string;
}>;

interface DurableToolState {
	end?: Readonly<{ entry: SessionEntry; payload: EmpatraHostToolExecutionEndPayload }>;
	start: Readonly<{ entry: SessionEntry; payload: EmpatraHostToolExecutionStartPayload }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
		.map(block => (typeof block.text === "string" ? block.text : ""))
		.join("");
}

function digestUserMessage(content: unknown): string {
	return new Bun.CryptoHasher("sha256").update(userMessageText(content)).digest("hex");
}

function projectBlocks(
	content: unknown,
	role: "assistant" | "user",
	media?: EmpatraHostPersistedUserMedia,
): readonly EmpatraHostProjectedBlock[] {
	if (typeof content === "string") return [{ blockType: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const projected: EmpatraHostProjectedBlock[] = [];
	for (const block of content) {
		if (!isRecord(block) || typeof block.type !== "string") continue;
		if (block.type === "text" && typeof block.text === "string") {
			projected.push({ blockType: "text", text: block.text });
		} else if (role === "assistant" && block.type === "thinking" && typeof block.thinking === "string") {
			projected.push({ blockType: "reasoning", text: block.thinking });
		}
	}
	if (role === "user") {
		projected.push(
			...(media
				? media.images.map(image => ({ ...image, blockType: "image" as const }))
				: projectEmpatraHostFallbackImages(content)),
		);
	}
	return projected;
}

export function projectThreadMessages(entries: readonly SessionEntry[]): readonly EmpatraHostProjectedMessage[] {
	const tools = new Map<string, DurableToolState>();
	const sequences = new Set<string>();
	const turnIdsByEntry = new Map<string, string>();
	const mediaByEntry = new Map<string, EmpatraHostPersistedUserMedia>();
	const pendingMediaByTurn = new Map<string, Array<{ entryId: string; media: EmpatraHostPersistedUserMedia }>>();
	const seenTurnIds = new Set<string>();
	let markerMode = false;
	let activeTurn: Readonly<{ id: string; startedAt: number }> | undefined;
	let legacyTurnId: string | undefined;
	for (const entry of entries) {
		const media = parseEmpatraHostUserMediaMarker(entry);
		if (media) {
			if (activeTurn?.id === media.turnId) {
				const pending = pendingMediaByTurn.get(media.turnId) ?? [];
				pending.push({ entryId: entry.id, media });
				pendingMediaByTurn.set(media.turnId, pending);
			}
			continue;
		}
		const mediaCancellation = parseEmpatraHostUserMediaCancellation(entry);
		if (mediaCancellation) {
			const pending = pendingMediaByTurn.get(mediaCancellation.turnId);
			const cancelledIndex = pending?.findIndex(candidate => candidate.entryId === mediaCancellation.markerEntryId);
			if (pending && cancelledIndex !== undefined && cancelledIndex >= 0) pending.splice(cancelledIndex, 1);
			continue;
		}
		const marker = parseEmpatraHostTurnMarker(entry);
		if (marker?.phase === "started") {
			markerMode = true;
			if (seenTurnIds.has(marker.turnId)) {
				throw new EmpatraHostProtocolError("turn_state_corrupt", "Persisted turn start is duplicated");
			}
			seenTurnIds.add(marker.turnId);
			activeTurn = { id: marker.turnId, startedAt: marker.startedAt };
			continue;
		}
		if (marker?.phase === "completed") {
			markerMode = true;
			if (!activeTurn || activeTurn.id !== marker.turnId || marker.completedAt < activeTurn.startedAt) {
				throw new EmpatraHostProtocolError("turn_state_corrupt", "Turn completion has no matching start marker");
			}
			pendingMediaByTurn.delete(marker.turnId);
			activeTurn = undefined;
			continue;
		}
		if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "user")) {
			if (markerMode) {
				if (!activeTurn) {
					throw new EmpatraHostProtocolError("turn_state_corrupt", "Persisted message is outside a turn marker");
				}
				turnIdsByEntry.set(entry.id, activeTurn.id);
			} else {
				if (entry.message.role === "user" && !entry.message.synthetic) {
					legacyTurnId = entry.id;
					seenTurnIds.add(entry.id);
				}
				if (legacyTurnId) turnIdsByEntry.set(entry.id, legacyTurnId);
			}
			if (entry.message.role === "user" && !entry.message.synthetic && "content" in entry.message) {
				const turnId = turnIdsByEntry.get(entry.id);
				const pending = turnId ? pendingMediaByTurn.get(turnId) : undefined;
				const messageSha256 = digestUserMessage(entry.message.content);
				const matchIndex = pending?.findIndex(candidate => candidate.media.messageSha256 === messageSha256);
				if (pending && matchIndex !== undefined && matchIndex >= 0) {
					const [matched] = pending.splice(matchIndex, 1);
					if (matched) mediaByEntry.set(entry.id, matched.media);
				}
			}
		}
		if (entry.type !== "custom" || entry.customType !== EMPATRA_HOST_TOOL_ENTRY) continue;
		const projected = parseEmpatraHostPersistedToolEvent(entry.data);
		if (!projected) throw new EmpatraHostProtocolError("turn_state_corrupt", "Persisted tool event is invalid");
		if (markerMode && (!activeTurn || activeTurn.id !== projected.turnId)) {
			throw new EmpatraHostProtocolError("turn_state_corrupt", "Persisted tool event is outside its turn marker");
		}
		const payload = projected.payload;
		const toolKey = `${projected.turnId}\0${payload.toolCallId}`;
		const sequenceKey = `${projected.turnId}\0${projected.generation}\0${projected.sequence}`;
		if (sequences.has(sequenceKey)) {
			throw new EmpatraHostProtocolError("turn_state_corrupt", "Persisted tool event sequence is duplicated");
		}
		sequences.add(sequenceKey);
		const state = tools.get(toolKey);
		if (payload.phase === "start") {
			if (state) throw new EmpatraHostProtocolError("turn_state_corrupt", "Persisted tool start is duplicated");
			tools.set(toolKey, { start: { entry, payload } });
			continue;
		}
		if (!state || state.end) {
			throw new EmpatraHostProtocolError("turn_state_corrupt", "Persisted tool event has no active start");
		}
		if (payload.toolName !== state.start.payload.toolName) {
			throw new EmpatraHostProtocolError("turn_state_corrupt", "Persisted tool identity changed");
		}
		if (payload.phase === "end") state.end = { entry, payload };
	}

	const completedByEntry = new Map<string, Readonly<{ end: NonNullable<DurableToolState["end"]>; turnId: string }>>();
	for (const [key, state] of tools) {
		if (!state.end) continue;
		const separator = key.indexOf("\0");
		completedByEntry.set(state.end.entry.id, { end: state.end, turnId: key.slice(0, separator) });
	}

	const messages: EmpatraHostProjectedMessage[] = [];
	for (const entry of entries) {
		const completed = completedByEntry.get(entry.id);
		if (completed) {
			const payload = completed.end.payload;
			messages.push({
				blocks: [
					{
						blockType: "tool_call",
						failed: payload.failed,
						hasResult: true,
						id: payload.toolCallId,
						toolArgumentsText: payload.argumentsText,
						toolArgumentsTruncated: payload.argumentsTruncated,
						toolName: payload.toolName,
						toolResultText: payload.resultText,
						toolResultTruncated: payload.resultTruncated,
					},
				],
				id: `tool:${completed.turnId}:${payload.toolCallId}`,
				parentId: entry.parentId,
				role: "assistant",
				timestamp: entry.timestamp,
				turnId: completed.turnId,
			});
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant" && message.role !== "user") continue;
		const turnId = turnIdsByEntry.get(entry.id);
		messages.push({
			blocks: projectBlocks(message.content, message.role, mediaByEntry.get(entry.id)),
			id: entry.id,
			parentId: entry.parentId,
			role: message.role,
			timestamp: entry.timestamp,
			...(turnId ? { turnId } : {}),
		});
	}
	return messages;
}
