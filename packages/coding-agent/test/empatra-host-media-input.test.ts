import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

import {
	EMPATRA_HOST_IMAGE_ADMISSION_MAX_COMMANDS,
	loadEmpatraHostImages,
	reserveEmpatraHostImageAdmission,
} from "../src/modes/empatra-host/media-input";
import type { EmpatraHostImageDescriptor } from "../src/modes/empatra-host/protocol";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);
const temporaryRoots: string[] = [];

function model(input: ("image" | "text")[]) {
	return buildModel({
		api: "openai-responses",
		baseUrl: "http://127.0.0.1:43123/v1",
		contextWindow: 200_000,
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
		id: "managed-model",
		input,
		maxTokens: 32_000,
		name: "Managed Model",
		provider: "empatra-gateway",
		reasoning: true,
		supportsTools: true,
	});
}

async function temporarySessionDirectory(): Promise<string> {
	const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "empatra-media-input-"));
	temporaryRoots.push(root);
	return root;
}

function descriptor(bytes: Uint8Array, mimeType: EmpatraHostImageDescriptor["mimeType"] = "image/png") {
	return {
		byteLength: bytes.byteLength,
		mimeType,
		sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
	} satisfies EmpatraHostImageDescriptor;
}

async function stage(sessionDirectory: string, bytes: Uint8Array, override?: EmpatraHostImageDescriptor) {
	const image = override ?? descriptor(bytes);
	const shard = path.join(sessionDirectory, "media-input-v1", "sha256", image.sha256.slice(0, 2));
	await mkdir(shard, { recursive: true });
	await writeFile(path.join(shard, image.sha256), bytes);
	return image;
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function oversizedPngHeader(): Buffer {
	const type = Buffer.from("IHDR");
	const data = Buffer.alloc(13);
	data.writeUInt32BE(65_536, 0);
	data.writeUInt32BE(65_536, 4);
	data.set([8, 6, 0, 0, 0], 8);
	const chunk = Buffer.alloc(4 + type.length + data.length + 4);
	chunk.writeUInt32BE(data.length, 0);
	type.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), chunk.length - 4);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk]);
}

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("Empatra host media input", () => {
	it("fails fast on weighted process capacity and bounded concurrent commands, then releases idempotently", () => {
		const weighted = (nibble: string): EmpatraHostImageDescriptor => ({
			byteLength: 20 * 1024 * 1024,
			mimeType: "image/png",
			sha256: nibble.repeat(64),
		});
		const releaseWeighted = reserveEmpatraHostImageAdmission([weighted("a"), weighted("b")]);
		expect(() => reserveEmpatraHostImageAdmission([weighted("c"), weighted("d")])).toThrow(
			"Image input capacity is exhausted",
		);
		releaseWeighted();
		releaseWeighted();
		const releaseAfterCapacity = reserveEmpatraHostImageAdmission([weighted("c"), weighted("d")]);
		releaseAfterCapacity();

		const tiny = descriptor(TINY_PNG);
		const releases = Array.from({ length: EMPATRA_HOST_IMAGE_ADMISSION_MAX_COMMANDS }, () =>
			reserveEmpatraHostImageAdmission([tiny]),
		);
		expect(() => reserveEmpatraHostImageAdmission([tiny])).toThrow("Image input capacity is exhausted");
		for (const release of releases) release();
	});

	it("loads a digest-addressed image and preserves the ordered detail contract", async () => {
		const sessionDirectory = await temporarySessionDirectory();
		const first = await stage(sessionDirectory, TINY_PNG);
		const second = { ...first, detail: "high" as const };
		const images = await loadEmpatraHostImages(sessionDirectory, model(["text", "image"]), [first, second]);
		expect(images).toHaveLength(2);
		expect(images?.map(image => image.detail)).toEqual([undefined, "high"]);
		expect(Buffer.from(images?.[0]?.data ?? "", "base64")).toEqual(TINY_PNG);
	});

	it("rejects non-vision models before touching the media store", async () => {
		const sessionDirectory = await temporarySessionDirectory();
		await expect(
			loadEmpatraHostImages(sessionDirectory, model(["text"]), [descriptor(TINY_PNG)]),
		).rejects.toMatchObject({
			code: "model_input_unsupported",
		});
	});

	it("rejects size, digest, magic, decode, and pixel-limit violations without leaking paths", async () => {
		const sessionDirectory = await temporarySessionDirectory();
		const valid = await stage(sessionDirectory, TINY_PNG);
		const invalidCases: EmpatraHostImageDescriptor[] = [
			{ ...valid, byteLength: valid.byteLength - 1 },
			{ ...valid, sha256: `${valid.sha256.slice(0, 63)}1` },
			await stage(sessionDirectory, Buffer.from("not a png"), descriptor(Buffer.from("not a png"), "image/png")),
			await stage(sessionDirectory, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
			await stage(sessionDirectory, oversizedPngHeader()),
		];
		for (const image of invalidCases) {
			try {
				await loadEmpatraHostImages(sessionDirectory, model(["text", "image"]), [image]);
				throw new Error("Expected image validation to fail");
			} catch (error) {
				expect(error).toMatchObject({ code: "image_input_invalid", message: "Image input validation failed" });
				expect(String(error)).not.toContain(sessionDirectory);
			}
		}
	});

	it.skipIf(process.platform === "win32")("rejects symlinked CAS files and shard directories", async () => {
		const sessionDirectory = await temporarySessionDirectory();
		const image = descriptor(TINY_PNG);
		const external = path.join(sessionDirectory, "external.png");
		await writeFile(external, TINY_PNG);
		const shard = path.join(sessionDirectory, "media-input-v1", "sha256", image.sha256.slice(0, 2));
		await mkdir(shard, { recursive: true });
		await symlink(external, path.join(shard, image.sha256));
		await expect(loadEmpatraHostImages(sessionDirectory, model(["text", "image"]), [image])).rejects.toMatchObject({
			code: "image_input_invalid",
		});

		await rm(path.join(sessionDirectory, "media-input-v1"), { force: true, recursive: true });
		const externalDirectory = path.join(sessionDirectory, "external-directory");
		await mkdir(externalDirectory);
		await writeFile(path.join(externalDirectory, image.sha256), TINY_PNG);
		await mkdir(path.join(sessionDirectory, "media-input-v1", "sha256"), { recursive: true });
		await symlink(externalDirectory, shard);
		await expect(loadEmpatraHostImages(sessionDirectory, model(["text", "image"]), [image])).rejects.toMatchObject({
			code: "image_input_invalid",
		});
	});
});
