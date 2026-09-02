import { createHash } from "node:crypto";

import { isRecord } from "@oh-my-pi/pi-utils";

import {
	EMPATRA_HOST_MAX_FRAME_BYTES,
	EMPATRA_HOST_MAX_REASSEMBLED_FRAME_BYTES,
	serializeEmpatraHostFrame,
	type EmpatraHostFrame,
} from "./protocol";

export const EMPATRA_HOST_FRAME_CAPABILITY = "framing.chunked.v1" as const;
export const EMPATRA_HOST_CHUNK_PAYLOAD_BYTES = 256 * 1024;
export const EMPATRA_HOST_CHUNK_TIMEOUT_MS = 30_000;

type ChunkFrame = {
	type: "rpc_chunk";
	version: 1;
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	digest: string;
	data: string;
};

const DIGEST = /^[a-f0-9]{64}$/u;

export function encodeEmpatraHostFrames(frame: EmpatraHostFrame, chunkId: string): readonly string[] {
	const serialized = serializeEmpatraHostFrame(frame, { allowChunking: true });
	const json = serialized.slice(0, -1);
	const bytes = Buffer.from(json, "utf8");
	if (bytes.byteLength <= EMPATRA_HOST_MAX_FRAME_BYTES) return [serialized];
	if (bytes.byteLength > EMPATRA_HOST_MAX_REASSEMBLED_FRAME_BYTES) {
		throw new Error("Host response exceeds the reassembled frame limit");
	}
	const digest = createHash("sha256").update(bytes).digest("hex");
	const count = Math.ceil(bytes.byteLength / EMPATRA_HOST_CHUNK_PAYLOAD_BYTES);
	const lines: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const chunk: ChunkFrame = {
			type: "rpc_chunk",
			version: 1,
			chunkId,
			index,
			count,
			byteLength: bytes.byteLength,
			digest,
			data: bytes.subarray(index * EMPATRA_HOST_CHUNK_PAYLOAD_BYTES, (index + 1) * EMPATRA_HOST_CHUNK_PAYLOAD_BYTES).toString("base64"),
		};
		const line = `${JSON.stringify(chunk)}\n`;
		if (Buffer.byteLength(line, "utf8") > EMPATRA_HOST_MAX_FRAME_BYTES) throw new Error("RPC chunk exceeded the transport limit");
		lines.push(line);
	}
	return lines;
}

export class EmpatraHostFrameDecoder {
	#pending?: { chunkId: string; count: number; byteLength: number; digest: string; nextIndex: number; chunks: Buffer[]; receivedBytes: number };
	#timer?: ReturnType<typeof setTimeout>;
	readonly #timeoutMs: number;
	readonly #onTimeout: () => void;

	constructor(options: { timeoutMs?: number; onTimeout?: () => void } = {}) {
		this.#timeoutMs = options.timeoutMs ?? EMPATRA_HOST_CHUNK_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) throw new RangeError("timeoutMs must be a positive integer");
		this.#onTimeout = options.onTimeout ?? (() => undefined);
	}

	#clear(): void {
		this.#pending = undefined;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#arm(): void {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#pending = undefined;
			this.#timer = undefined;
			this.#onTimeout();
		}, this.#timeoutMs);
		this.#timer.unref?.();
	}

	push(line: Uint8Array): Record<string, unknown> | undefined {
		if (line.byteLength === 0 || line.byteLength > EMPATRA_HOST_MAX_FRAME_BYTES) throw new Error("invalid physical frame length");
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
		} catch (error) {
			this.#clear();
			throw new Error("invalid UTF-8 or JSON frame", { cause: error });
		}
		if (!isRecord(parsed) || parsed.type !== "rpc_chunk") {
			if (this.#pending) throw new Error("rpc chunk sequence interrupted");
			if (!isRecord(parsed)) throw new Error("frame must be an object");
			return parsed;
		}
		const { version, chunkId, index, count, byteLength, digest, data } = parsed;
		const chunkIndex = typeof index === "number" ? index : -1;
		const chunkCount = typeof count === "number" ? count : -1;
		const chunkByteLength = typeof byteLength === "number" ? byteLength : -1;
		const maxCount = Math.ceil(EMPATRA_HOST_MAX_REASSEMBLED_FRAME_BYTES / EMPATRA_HOST_CHUNK_PAYLOAD_BYTES);
		if (version !== 1 || typeof chunkId !== "string" || chunkId.length === 0 || chunkId.length > 128 ||
			!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength) ||
			chunkIndex < 0 || chunkCount < 2 || chunkCount > maxCount || chunkIndex >= chunkCount || chunkByteLength < EMPATRA_HOST_MAX_FRAME_BYTES ||
			chunkByteLength > EMPATRA_HOST_MAX_REASSEMBLED_FRAME_BYTES || typeof digest !== "string" || !DIGEST.test(digest) || typeof data !== "string" || data.length === 0) {
			throw new Error("invalid rpc chunk metadata");
		}
		let bytes: Buffer;
		try { bytes = Buffer.from(data, "base64"); } catch (error) { throw new Error("invalid rpc chunk data", { cause: error }); }
		if (bytes.toString("base64") !== data || bytes.byteLength > EMPATRA_HOST_CHUNK_PAYLOAD_BYTES) throw new Error("invalid rpc chunk data");
		if (!this.#pending) {
			if (chunkIndex !== 0) throw new Error("rpc chunk sequence must start at index 0");
			this.#pending = { chunkId, count: chunkCount, byteLength: chunkByteLength, digest, nextIndex: 0, chunks: [], receivedBytes: 0 };
			this.#arm();
		}
		const pending = this.#pending;
		if (!pending) throw new Error("rpc chunk sequence state missing");
		if (pending.chunkId !== chunkId || pending.count !== count || pending.byteLength !== byteLength || pending.digest !== digest || pending.nextIndex !== index) throw new Error("rpc chunk sequence mismatch");
		pending.chunks.push(bytes);
		pending.receivedBytes += bytes.byteLength;
		pending.nextIndex += 1;
		if (pending.receivedBytes > pending.byteLength) throw new Error("rpc chunk sequence exceeds declared length");
		if (pending.nextIndex < pending.count) return undefined;
		if (pending.receivedBytes !== pending.byteLength) throw new Error("rpc chunk sequence length mismatch");
		const assembled = Buffer.concat(pending.chunks);
		if (createHash("sha256").update(assembled).digest("hex") !== pending.digest) { this.#clear(); throw new Error("rpc chunk digest mismatch"); }
		this.#clear();
		let frame: unknown;
		try { frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(assembled)); } catch (error) { throw new Error("invalid reassembled UTF-8 or JSON frame", { cause: error }); }
		if (!isRecord(frame)) throw new Error("reassembled frame must be an object");
		return frame;
	}
}
