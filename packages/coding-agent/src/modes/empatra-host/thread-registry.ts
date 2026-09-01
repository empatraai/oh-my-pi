import { EmpatraHostRegistryError } from "./errors";

export interface EmpatraHostThreadHandle {
	dispose(): Promise<void>;
	threadId: string;
}

interface ResidentThread<Handle extends EmpatraHostThreadHandle> {
	activeTurnId: string | null;
	generation: number;
	handle: Handle;
	lastAccess: number;
}

export interface EmpatraHostThreadState<Handle extends EmpatraHostThreadHandle> {
	activeTurnId: string | null;
	generation: number;
	handle: Handle;
}

export class EmpatraHostThreadRegistry<Handle extends EmpatraHostThreadHandle> {
	readonly #maxResidentThreads: number;
	readonly #opening = new Map<string, Promise<Handle>>();
	readonly #creating = new Map<string, Promise<Handle>>();
	readonly #threads = new Map<string, ResidentThread<Handle>>();
	#clock = 0;
	#disposed = false;

	constructor(maxResidentThreads = 32) {
		if (!Number.isSafeInteger(maxResidentThreads) || maxResidentThreads < 1 || maxResidentThreads > 1024) {
			throw new EmpatraHostRegistryError("invalid_limit", "maxResidentThreads must be between 1 and 1024");
		}
		this.#maxResidentThreads = maxResidentThreads;
	}

	async open(threadId: string, load: () => Promise<Handle>): Promise<EmpatraHostThreadState<Handle>> {
		this.#requireLive();
		const resident = this.#threads.get(threadId);
		if (resident) return this.#touch(resident);
		const inFlight = this.#opening.get(threadId);
		const handle = inFlight ?? load();
		if (!inFlight) this.#opening.set(threadId, handle);
		try {
			const loaded = await handle;
			if (loaded.threadId !== threadId) {
				await loaded.dispose();
				throw new EmpatraHostRegistryError("identity_mismatch", "Loaded thread changed its identity");
			}
			return await this.#adopt(loaded);
		} finally {
			if (!inFlight) this.#opening.delete(threadId);
		}
	}

	async create(operationId: string, create: () => Promise<Handle>): Promise<EmpatraHostThreadState<Handle>> {
		this.#requireLive();
		const inFlight = this.#creating.get(operationId);
		const handle = inFlight ?? create();
		if (!inFlight) this.#creating.set(operationId, handle);
		try {
			return await this.#adopt(await handle);
		} finally {
			if (!inFlight) this.#creating.delete(operationId);
		}
	}

	get(threadId: string): EmpatraHostThreadState<Handle> | null {
		this.#requireLive();
		const resident = this.#threads.get(threadId);
		return resident ? this.#touch(resident) : null;
	}

	beginTurn(threadId: string, turnId: string, expectedGeneration: number): number {
		const resident = this.#requireThread(threadId);
		if (resident.generation !== expectedGeneration) {
			throw new EmpatraHostRegistryError("stale_generation", "Turn command targets a stale thread generation");
		}
		if (resident.activeTurnId) {
			throw new EmpatraHostRegistryError("turn_active", "Thread already has an active turn");
		}
		resident.activeTurnId = turnId;
		resident.generation += 1;
		this.#touch(resident);
		return resident.generation;
	}

	requireActiveTurn(threadId: string, turnId: string, expectedGeneration: number): Handle {
		const resident = this.#requireThread(threadId);
		if (resident.generation !== expectedGeneration || resident.activeTurnId !== turnId) {
			throw new EmpatraHostRegistryError("stale_turn", "Turn command does not match the active generation");
		}
		this.#touch(resident);
		return resident.handle;
	}

	finishTurn(threadId: string, turnId: string, expectedGeneration: number): number {
		const resident = this.#requireThread(threadId);
		if (resident.generation !== expectedGeneration || resident.activeTurnId !== turnId) {
			throw new EmpatraHostRegistryError("stale_turn", "Turn completion does not match the active generation");
		}
		resident.activeTurnId = null;
		resident.generation += 1;
		this.#touch(resident);
		return resident.generation;
	}

	advanceGeneration(threadId: string): number {
		const resident = this.#requireThread(threadId);
		if (resident.activeTurnId) {
			throw new EmpatraHostRegistryError("turn_active", "Cannot mutate a thread with an active turn");
		}
		resident.generation += 1;
		this.#touch(resident);
		return resident.generation;
	}

	async close(threadId: string): Promise<void> {
		const resident = this.#threads.get(threadId);
		if (!resident) return;
		if (resident.activeTurnId) {
			throw new EmpatraHostRegistryError("turn_active", "Cannot close a thread with an active turn");
		}
		this.#threads.delete(threadId);
		await resident.handle.dispose();
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const residents = [...this.#threads.values()];
		this.#threads.clear();
		await Promise.allSettled(residents.map(resident => resident.handle.dispose()));
	}

	async #adopt(handle: Handle): Promise<EmpatraHostThreadState<Handle>> {
		const existing = this.#threads.get(handle.threadId);
		if (existing) {
			if (existing.handle !== handle) await handle.dispose();
			return this.#touch(existing);
		}
		try {
			await this.#evictIfNeeded();
		} catch (error) {
			await handle.dispose();
			throw error;
		}
		const resident: ResidentThread<Handle> = {
			activeTurnId: null,
			generation: 0,
			handle,
			lastAccess: ++this.#clock,
		};
		this.#threads.set(handle.threadId, resident);
		return this.#state(resident);
	}

	async #evictIfNeeded(): Promise<void> {
		if (this.#threads.size < this.#maxResidentThreads) return;
		const candidate = [...this.#threads.values()]
			.filter(resident => resident.activeTurnId === null)
			.sort((left, right) => left.lastAccess - right.lastAccess)[0];
		if (!candidate) {
			throw new EmpatraHostRegistryError("capacity_exhausted", "All resident threads have active turns");
		}
		this.#threads.delete(candidate.handle.threadId);
		await candidate.handle.dispose();
	}

	#requireLive(): void {
		if (this.#disposed) throw new EmpatraHostRegistryError("disposed", "Thread registry is disposed");
	}

	#requireThread(threadId: string): ResidentThread<Handle> {
		this.#requireLive();
		const resident = this.#threads.get(threadId);
		if (!resident) throw new EmpatraHostRegistryError("thread_not_loaded", `Thread is not loaded: ${threadId}`);
		return resident;
	}

	#state(resident: ResidentThread<Handle>): EmpatraHostThreadState<Handle> {
		return {
			activeTurnId: resident.activeTurnId,
			generation: resident.generation,
			handle: resident.handle,
		};
	}

	#touch(resident: ResidentThread<Handle>): EmpatraHostThreadState<Handle> {
		resident.lastAccess = ++this.#clock;
		return this.#state(resident);
	}
}
