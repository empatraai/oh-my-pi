import type { SessionEntry } from "../../session/session-entries";
import { EmpatraHostProtocolError } from "./errors";
import type { EmpatraHostTurnStatus } from "./protocol";

export const EMPATRA_TURN_ENTRY = "empatra.host.turn.v1";
export const EMPATRA_TURN_ENTRY_VERSION = 1 as const;

export type EmpatraHostPersistedTurnMarker =
	| Readonly<{
			phase: "started";
			startedAt: number;
			turnId: string;
			version: typeof EMPATRA_TURN_ENTRY_VERSION;
	  }>
	| Readonly<{
			completedAt: number;
			outcome: Exclude<EmpatraHostTurnStatus, "running">;
			phase: "completed";
			turnId: string;
			version: typeof EMPATRA_TURN_ENTRY_VERSION;
	  }>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const expected = new Set(keys);
	return Object.keys(value).length === expected.size && Object.keys(value).every(key => expected.has(key));
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseEmpatraHostTurnMarker(entry: SessionEntry): EmpatraHostPersistedTurnMarker | undefined {
	if (entry.type !== "custom" || entry.customType !== EMPATRA_TURN_ENTRY) return undefined;
	const value = entry.data;
	if (
		!isRecord(value) ||
		value.version !== EMPATRA_TURN_ENTRY_VERSION ||
		typeof value.turnId !== "string" ||
		value.turnId.length === 0
	) {
		throw new EmpatraHostProtocolError("turn_state_corrupt", "Persisted turn marker is invalid");
	}
	if (
		value.phase === "started" &&
		hasExactKeys(value, ["phase", "startedAt", "turnId", "version"]) &&
		isNonNegativeInteger(value.startedAt)
	) {
		return { phase: "started", startedAt: value.startedAt, turnId: value.turnId, version: 1 };
	}
	if (
		value.phase === "completed" &&
		hasExactKeys(value, ["completedAt", "outcome", "phase", "turnId", "version"]) &&
		isNonNegativeInteger(value.completedAt) &&
		(value.outcome === "completed" || value.outcome === "failed" || value.outcome === "interrupted")
	) {
		return {
			completedAt: value.completedAt,
			outcome: value.outcome,
			phase: "completed",
			turnId: value.turnId,
			version: 1,
		};
	}
	throw new EmpatraHostProtocolError("turn_state_corrupt", "Persisted turn marker is invalid");
}
