import { Database } from "bun:sqlite";

import { EmpatraHostProtocolError } from "./errors";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS empatra_host_atomic_operations (
	operation_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('create_and_start', 'fork_and_start')),
	input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
	thread_id TEXT NOT NULL,
	turn_id TEXT NOT NULL,
	generation INTEGER NOT NULL CHECK (generation >= 0),
	phase TEXT NOT NULL CHECK (phase IN ('accepted', 'dispatching', 'completed')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS empatra_host_atomic_operations_thread_idx
	ON empatra_host_atomic_operations (thread_id, updated_at DESC);
`;

export type EmpatraHostAtomicOperationKind = "create_and_start" | "fork_and_start";
export type EmpatraHostAtomicOperationPhase = "accepted" | "completed" | "dispatching";

interface AtomicOperationRow {
	created_at: number;
	generation: number;
	input_sha256: string;
	kind: EmpatraHostAtomicOperationKind;
	operation_id: string;
	phase: EmpatraHostAtomicOperationPhase;
	thread_id: string;
	turn_id: string;
	updated_at: number;
}

export interface EmpatraHostAtomicOperation {
	createdAt: number;
	generation: number;
	inputSha256: string;
	kind: EmpatraHostAtomicOperationKind;
	operationId: string;
	phase: EmpatraHostAtomicOperationPhase;
	threadId: string;
	turnId: string;
	updatedAt: number;
}

function projectRow(row: AtomicOperationRow): EmpatraHostAtomicOperation {
	return {
		createdAt: row.created_at,
		generation: row.generation,
		inputSha256: row.input_sha256,
		kind: row.kind,
		operationId: row.operation_id,
		phase: row.phase,
		threadId: row.thread_id,
		turnId: row.turn_id,
		updatedAt: row.updated_at,
	};
}

function assertSameOperation(
	existing: EmpatraHostAtomicOperation,
	requested: Pick<EmpatraHostAtomicOperation, "inputSha256" | "kind" | "operationId" | "threadId" | "turnId">,
): void {
	if (
		existing.inputSha256 !== requested.inputSha256 ||
		existing.kind !== requested.kind ||
		existing.threadId !== requested.threadId ||
		existing.turnId !== requested.turnId
	) {
		throw new EmpatraHostProtocolError(
			"operation_conflict",
			"The atomic operation id is already bound to different inputs",
		);
	}
}

/**
 * Secret-free durable receipt journal. Only an input digest and opaque runtime
 * identities are persisted; prompts, messages, workspace paths, and credentials
 * never enter this database.
 */
export class EmpatraHostAtomicOperationStore {
	readonly #database: Database;

	constructor(databasePath: string) {
		this.#database = new Database(databasePath, { create: true, strict: true });
		this.#database.run("PRAGMA busy_timeout = 5000");
		this.#database.run(`PRAGMA journal_mode=WAL;\nPRAGMA synchronous=FULL;\n${SCHEMA}`);
	}

	accept(
		operation: Pick<
			EmpatraHostAtomicOperation,
			"generation" | "inputSha256" | "kind" | "operationId" | "threadId" | "turnId"
		>,
	): EmpatraHostAtomicOperation {
		const now = Date.now();
		this.#database
			.query<never, [string, string, string, string, string, number, number, number]>(`
INSERT INTO empatra_host_atomic_operations (
	operation_id, kind, input_sha256, thread_id, turn_id, generation, phase, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)
ON CONFLICT(operation_id) DO NOTHING
			`)
			.run(
				operation.operationId,
				operation.kind,
				operation.inputSha256,
				operation.threadId,
				operation.turnId,
				operation.generation,
				now,
				now,
			);
		const accepted = this.get(operation.operationId);
		if (!accepted) throw new EmpatraHostProtocolError("runtime_error", "Atomic operation receipt was not persisted");
		assertSameOperation(accepted, operation);
		return accepted;
	}

	close(): void {
		this.#database.close();
	}

	get(operationId: string): EmpatraHostAtomicOperation | undefined {
		const row = this.#database
			.query<AtomicOperationRow, [string]>(`
SELECT operation_id, kind, input_sha256, thread_id, turn_id, generation, phase, created_at, updated_at
FROM empatra_host_atomic_operations
WHERE operation_id = ?
			`)
			.get(operationId);
		return row ? projectRow(row) : undefined;
	}

	markCompleted(operationId: string, inputSha256: string): void {
		this.#advance(operationId, inputSha256, "completed");
	}

	markDispatching(operationId: string, inputSha256: string): void {
		this.#advance(operationId, inputSha256, "dispatching");
	}

	#advance(
		operationId: string,
		inputSha256: string,
		phase: Exclude<EmpatraHostAtomicOperationPhase, "accepted">,
	): void {
		const existing = this.get(operationId);
		if (!existing || existing.inputSha256 !== inputSha256) {
			throw new EmpatraHostProtocolError("operation_conflict", "Atomic operation receipt does not match its input");
		}
		if (existing.phase === "completed" || existing.phase === phase) return;
		if (existing.phase === "dispatching" && phase !== "completed") {
			throw new EmpatraHostProtocolError("atomic_operation_uncertain", "Atomic operation dispatch is uncertain");
		}
		this.#database
			.query<never, [string, number, string, string]>(`
UPDATE empatra_host_atomic_operations
SET phase = ?, updated_at = ?
WHERE operation_id = ? AND input_sha256 = ?
			`)
			.run(phase, Date.now(), operationId, inputSha256);
	}
}

export function digestEmpatraHostAtomicInput(parts: readonly string[]): string {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const part of parts) {
		hasher.update(String(Buffer.byteLength(part, "utf8")));
		hasher.update(":");
		hasher.update(part);
		hasher.update(";");
	}
	return hasher.digest("hex");
}

export function digestEmpatraHostText(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
