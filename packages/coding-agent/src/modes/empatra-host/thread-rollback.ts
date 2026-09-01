import type { SessionEntry } from "../../session/session-entries";
import type { SessionManager } from "../../session/session-manager";
import { EmpatraHostProtocolError } from "./errors";

const EMPATRA_TURN_ENTRY = "empatra.host.turn.v1";
const EMPATRA_THREAD_ROLLBACK_MARKER = "empatra.host.thread-rollback.v1";

interface TurnStartEntry {
	entry: SessionEntry;
	turnId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectTurnStarts(branch: readonly SessionEntry[]): TurnStartEntry[] {
	const firstMarker = branch.findIndex(entry => entry.type === "custom" && entry.customType === EMPATRA_TURN_ENTRY);
	const starts: TurnStartEntry[] = [];
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index];
		if (index < firstMarker || firstMarker < 0) {
			if (entry.type === "message" && entry.message.role === "user" && !entry.message.synthetic) {
				starts.push({ entry, turnId: entry.id });
			}
			continue;
		}
		if (
			entry.type === "custom" &&
			entry.customType === EMPATRA_TURN_ENTRY &&
			isRecord(entry.data) &&
			entry.data.phase === "started" &&
			typeof entry.data.turnId === "string"
		) {
			starts.push({ entry, turnId: entry.data.turnId });
		}
	}
	return starts;
}

/**
 * Moves the active leaf before the requested turns and appends a durable marker.
 * Existing entries are intentionally retained as an abandoned sibling branch.
 */
export async function rollbackEmpatraHostThread(
	manager: SessionManager,
	turns: number,
): Promise<{ abandonedLeafId: string; rollbackMarkerId: string; rolledBackTurnIds: string[] }> {
	const abandonedLeafId = manager.getLeafId();
	if (!abandonedLeafId) {
		throw new EmpatraHostProtocolError("rollback_unavailable", "Thread has no turns to roll back");
	}
	const starts = collectTurnStarts(manager.getBranch());
	if (starts.length < turns) {
		throw new EmpatraHostProtocolError("rollback_unavailable", "Thread has fewer turns than requested");
	}
	const rolledBack = starts.slice(starts.length - turns);
	const boundary = rolledBack[0]?.entry.parentId ?? null;
	const rolledBackTurnIds = rolledBack.map(turn => turn.turnId);
	const rollbackMarkerId = manager.branchWithSummary(boundary, "", {
		abandonedLeafId,
		kind: EMPATRA_THREAD_ROLLBACK_MARKER,
		rolledBackTurnIds,
		turns,
	});
	await manager.flush();
	return { abandonedLeafId, rollbackMarkerId, rolledBackTurnIds };
}
