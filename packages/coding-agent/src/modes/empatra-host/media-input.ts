import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";

import { EmpatraHostProtocolError } from "./errors";
import {
	EMPATRA_HOST_MAX_IMAGE_BYTES,
	EMPATRA_HOST_MAX_IMAGE_BYTES_TOTAL,
	EMPATRA_HOST_MAX_IMAGE_PIXELS,
	EMPATRA_HOST_MAX_IMAGES,
	type EmpatraHostImageDescriptor,
	type EmpatraHostImageMimeType,
	type EmpatraHostProjectedImageBlock,
	sanitizeEmpatraHostImageDisplayName,
} from "./protocol";

const MEDIA_DIRECTORY = "media-input-v1";
export const EMPATRA_HOST_IMAGE_ADMISSION_MAX_BYTES = EMPATRA_HOST_MAX_IMAGE_BYTES_TOTAL;
export const EMPATRA_HOST_IMAGE_ADMISSION_MAX_COMMANDS = 2;

let admittedBytes = 0;
let admittedCommands = 0;

export interface EmpatraHostPreparedImages {
	images: ImageContent[];
	projection: EmpatraHostProjectedImageBlock[];
	release(): void;
}

interface LoadedImage {
	content: ImageContent;
	projection: EmpatraHostProjectedImageBlock;
}

export function reserveEmpatraHostImageAdmission(descriptors: readonly EmpatraHostImageDescriptor[]): () => void {
	if (
		descriptors.length === 0 ||
		descriptors.length > EMPATRA_HOST_MAX_IMAGES ||
		descriptors.some(
			descriptor =>
				!Number.isSafeInteger(descriptor.byteLength) ||
				descriptor.byteLength <= 0 ||
				descriptor.byteLength > EMPATRA_HOST_MAX_IMAGE_BYTES,
		)
	) {
		throw imageInputError();
	}
	const bytes = descriptors.reduce((total, descriptor) => total + descriptor.byteLength, 0);
	if (bytes > EMPATRA_HOST_IMAGE_ADMISSION_MAX_BYTES) throw imageInputError();
	if (
		admittedCommands >= EMPATRA_HOST_IMAGE_ADMISSION_MAX_COMMANDS ||
		admittedBytes + bytes > EMPATRA_HOST_IMAGE_ADMISSION_MAX_BYTES
	) {
		throw new EmpatraHostProtocolError("image_capacity_exceeded", "Image input capacity is exhausted");
	}
	admittedCommands += 1;
	admittedBytes += bytes;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		admittedCommands -= 1;
		admittedBytes -= bytes;
	};
}

function isInsideDirectory(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function hasExpectedMagic(bytes: Uint8Array, mimeType: EmpatraHostImageMimeType): boolean {
	if (mimeType === "image/png") {
		return Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	}
	if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (mimeType === "image/gif") {
		const signature = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
		return signature === "GIF87a" || signature === "GIF89a";
	}
	return (
		Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
		Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
	);
}

function imageInputError(): EmpatraHostProtocolError {
	return new EmpatraHostProtocolError("image_input_invalid", "Image input validation failed");
}

async function requirePrivateDirectory(directory: string, allowedRoot: string): Promise<string> {
	const stat = await lstat(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw imageInputError();
	const canonical = await realpath(directory);
	if (!isInsideDirectory(allowedRoot, canonical)) throw imageInputError();
	return canonical;
}

async function loadDescriptor(
	sessionDirectory: string,
	descriptor: EmpatraHostImageDescriptor,
	index: number,
): Promise<LoadedImage> {
	const canonicalSessionDirectory = await realpath(sessionDirectory);
	const mediaRoot = path.join(sessionDirectory, MEDIA_DIRECTORY, "sha256");
	const canonicalMediaRoot = await requirePrivateDirectory(mediaRoot, canonicalSessionDirectory);
	const shard = path.join(mediaRoot, descriptor.sha256.slice(0, 2));
	const canonicalShard = await requirePrivateDirectory(shard, canonicalMediaRoot);
	const candidate = path.join(canonicalShard, descriptor.sha256);
	const before = await lstat(candidate, { bigint: true });
	if (before.isSymbolicLink() || !before.isFile() || before.size !== BigInt(descriptor.byteLength)) {
		throw imageInputError();
	}
	const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
	const handle = await open(candidate, flags);
	try {
		const opened = await handle.stat({ bigint: true });
		if (
			!opened.isFile() ||
			opened.dev !== before.dev ||
			opened.ino !== before.ino ||
			opened.size !== before.size ||
			opened.size !== BigInt(descriptor.byteLength)
		) {
			throw imageInputError();
		}
		const bytes = Buffer.allocUnsafe(descriptor.byteLength);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
			if (result.bytesRead === 0) throw imageInputError();
			offset += result.bytesRead;
		}
		const tail = Buffer.allocUnsafe(1);
		if ((await handle.read(tail, 0, 1, offset)).bytesRead !== 0) throw imageInputError();
		const after = await handle.stat({ bigint: true });
		if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) throw imageInputError();
		const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		if (digest !== descriptor.sha256 || !hasExpectedMagic(bytes, descriptor.mimeType)) throw imageInputError();
		const metadata = await new Bun.Image(bytes, { maxPixels: EMPATRA_HOST_MAX_IMAGE_PIXELS }).metadata();
		if (
			!Number.isSafeInteger(metadata.width) ||
			!Number.isSafeInteger(metadata.height) ||
			metadata.width <= 0 ||
			metadata.height <= 0 ||
			metadata.width * metadata.height > EMPATRA_HOST_MAX_IMAGE_PIXELS
		) {
			throw imageInputError();
		}
		const extension = descriptor.mimeType === "image/jpeg" ? "jpg" : descriptor.mimeType.slice("image/".length);
		return {
			content: {
				data: bytes.toString("base64"),
				...(descriptor.detail === undefined ? {} : { detail: descriptor.detail }),
				mimeType: descriptor.mimeType,
				type: "image",
			},
			projection: {
				blockType: "image",
				byteLength: descriptor.byteLength,
				...(descriptor.detail === undefined ? {} : { detail: descriptor.detail }),
				displayName: sanitizeEmpatraHostImageDisplayName(
					descriptor.displayName ?? `Изображение ${index + 1}.${extension}`,
				),
				heightPixels: metadata.height,
				mimeType: descriptor.mimeType,
				sha256: descriptor.sha256,
				widthPixels: metadata.width,
			},
		};
	} finally {
		await handle.close();
	}
}

export function digestEmpatraHostImageDescriptors(images: readonly EmpatraHostImageDescriptor[] | undefined): string {
	return JSON.stringify({
		images: (images ?? []).map(image => ({
			byteLength: image.byteLength,
			...(image.detail === undefined ? {} : { detail: image.detail }),
			...(image.displayName === undefined ? {} : { displayName: image.displayName }),
			mimeType: image.mimeType,
			sha256: image.sha256,
		})),
		version: 1,
	});
}

async function loadPreparedImages(
	sessionDirectory: string,
	model: Model<"openai-responses">,
	descriptors: readonly EmpatraHostImageDescriptor[],
): Promise<LoadedImage[]> {
	if (!model.input.includes("image")) {
		throw new EmpatraHostProtocolError("model_input_unsupported", "Selected model does not support image input");
	}
	try {
		const images: LoadedImage[] = [];
		for (const [index, descriptor] of descriptors.entries()) {
			images.push(await loadDescriptor(sessionDirectory, descriptor, index));
		}
		return images;
	} catch (error) {
		if (error instanceof EmpatraHostProtocolError) throw error;
		throw imageInputError();
	}
}

export async function loadEmpatraHostImages(
	sessionDirectory: string,
	model: Model<"openai-responses">,
	descriptors: readonly EmpatraHostImageDescriptor[] | undefined,
): Promise<ImageContent[] | undefined> {
	if (!descriptors) return undefined;
	return (await loadPreparedImages(sessionDirectory, model, descriptors)).map(image => image.content);
}

export async function prepareEmpatraHostImages(
	sessionDirectory: string,
	model: Model<"openai-responses">,
	descriptors: readonly EmpatraHostImageDescriptor[] | undefined,
): Promise<EmpatraHostPreparedImages | undefined> {
	if (!descriptors) return undefined;
	if (!model.input.includes("image")) {
		throw new EmpatraHostProtocolError("model_input_unsupported", "Selected model does not support image input");
	}
	const release = reserveEmpatraHostImageAdmission(descriptors);
	try {
		const loaded = await loadPreparedImages(sessionDirectory, model, descriptors);
		return {
			images: loaded.map(image => image.content),
			projection: loaded.map(image => image.projection),
			release,
		};
	} catch (error) {
		release();
		throw error;
	}
}
