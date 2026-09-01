import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS empatra_host_threads (
	thread_id TEXT PRIMARY KEY,
	session_path TEXT NOT NULL UNIQUE,
	operation_id TEXT NOT NULL UNIQUE,
	archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS empatra_host_threads_archived_updated_idx
	ON empatra_host_threads (archived, updated_at DESC);
`;

interface ThreadMetadataRow {
	archived: number;
	operation_id: string;
	session_path: string;
	thread_id: string;
}

export interface EmpatraHostThreadMetadata {
	archived: boolean;
	operationId: string;
	sessionPath: string;
	threadId: string;
}

function projectRow(row: ThreadMetadataRow): EmpatraHostThreadMetadata {
	if (row.archived !== 0 && row.archived !== 1) {
		throw new Error(`Invalid archived state for Empatra thread ${row.thread_id}`);
	}
	return {
		archived: row.archived === 1,
		operationId: row.operation_id,
		sessionPath: row.session_path,
		threadId: row.thread_id,
	};
}

/**
 * Durable, secret-free projection for host lifecycle lookups. OMP session JSONL
 * remains authoritative; this index can be reconstructed from persisted custom
 * entries and never contains prompts, provider credentials, or transcript text.
 */
export class EmpatraHostThreadMetadataStore {
	readonly #database: Database;

	constructor(databasePath: string) {
		this.#database = new Database(databasePath, { create: true, strict: true });
		this.#database.run("PRAGMA busy_timeout = 5000");
		this.#database.run(`PRAGMA journal_mode=WAL;\nPRAGMA synchronous=NORMAL;\n${SCHEMA}`);
	}

	close(): void {
		this.#database.close();
	}

	delete(threadId: string): void {
		this.#database.query<never, [string]>("DELETE FROM empatra_host_threads WHERE thread_id = ?").run(threadId);
	}

	findByOperation(operationId: string): EmpatraHostThreadMetadata | undefined {
		const row = this.#database
			.query<ThreadMetadataRow, [string]>(
				"SELECT thread_id, session_path, operation_id, archived FROM empatra_host_threads WHERE operation_id = ?",
			)
			.get(operationId);
		return row ? projectRow(row) : undefined;
	}

	get(threadId: string): EmpatraHostThreadMetadata | undefined {
		const row = this.#database
			.query<ThreadMetadataRow, [string]>(
				"SELECT thread_id, session_path, operation_id, archived FROM empatra_host_threads WHERE thread_id = ?",
			)
			.get(threadId);
		return row ? projectRow(row) : undefined;
	}

	upsert(metadata: EmpatraHostThreadMetadata): void {
		this.#database
			.query<never, [string, string, string, number, number]>(`
INSERT INTO empatra_host_threads (thread_id, session_path, operation_id, archived, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET
	session_path = excluded.session_path,
	operation_id = excluded.operation_id,
	archived = excluded.archived,
	updated_at = excluded.updated_at
			`)
			.run(metadata.threadId, metadata.sessionPath, metadata.operationId, metadata.archived ? 1 : 0, Date.now());
	}
}
