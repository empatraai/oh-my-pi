import type { SessionEntry } from "../../session/session-entries";
import {
	EMPATRA_HOST_MAX_IMAGE_BYTES,
	EMPATRA_HOST_MAX_IMAGE_BYTES_TOTAL,
	EMPATRA_HOST_MAX_IMAGE_PIXELS,
	EMPATRA_HOST_MAX_IMAGES,
	type EmpatraHostImageMimeType,
	type EmpatraHostProjectedImageBlock,
	sanitizeEmpatraHostImageDisplayName,
} from "./protocol";

export const EMPATRA_HOST_USER_MEDIA_ENTRY = "empatra.host.user-media.v1";
export const EMPATRA_HOST_USER_MEDIA_ENTRY_VERSION = 1 as const;
export const EMPATRA_HOST_USER_MEDIA_CANCEL_ENTRY = "empatra.host.user-media-cancel.v1";

export interface EmpatraHostPersistedUserMedia {
	images: readonly Omit<EmpatraHostProjectedImageBlock, "blockType">[];
	messageSha256: string;
	turnId: string;
	version: typeof EMPATRA_HOST_USER_MEDIA_ENTRY_VERSION;
}

export interface EmpatraHostPersistedUserMediaCancellation {
	markerEntryId: string;
	turnId: string;
	version: typeof EMPATRA_HOST_USER_MEDIA_ENTRY_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const expected = new Set(keys);
	return Object.keys(value).length === expected.size && Object.keys(value).every(key => expected.has(key));
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function parseImage(value: unknown): Omit<EmpatraHostProjectedImageBlock, "blockType"> | undefined {
	if (!isRecord(value)) return undefined;
	const keys = ["byteLength", "detail", "displayName", "heightPixels", "mimeType", "sha256", "widthPixels"];
	if (
		!hasExactKeys(
			value,
			keys.filter(key => value[key] !== undefined),
		)
	)
		return undefined;
	if (
		!isPositiveInteger(value.byteLength) ||
		value.byteLength > EMPATRA_HOST_MAX_IMAGE_BYTES ||
		typeof value.displayName !== "string" ||
		value.displayName.length === 0 ||
		value.displayName.length > 160 ||
		sanitizeEmpatraHostImageDisplayName(value.displayName) !== value.displayName ||
		typeof value.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/u.test(value.sha256) ||
		(value.mimeType !== "image/gif" &&
			value.mimeType !== "image/jpeg" &&
			value.mimeType !== "image/png" &&
			value.mimeType !== "image/webp") ||
		(value.detail !== undefined && value.detail !== "auto" && value.detail !== "high" && value.detail !== "low")
	) {
		return undefined;
	}
	const hasWidth = value.widthPixels !== undefined;
	const hasHeight = value.heightPixels !== undefined;
	if (hasWidth !== hasHeight) return undefined;
	if (
		hasWidth &&
		(!isPositiveInteger(value.widthPixels) ||
			!isPositiveInteger(value.heightPixels) ||
			value.widthPixels * value.heightPixels > EMPATRA_HOST_MAX_IMAGE_PIXELS)
	) {
		return undefined;
	}
	return {
		byteLength: value.byteLength,
		...(value.detail === undefined ? {} : { detail: value.detail }),
		displayName: value.displayName,
		...(hasWidth ? { heightPixels: value.heightPixels as number } : {}),
		mimeType: value.mimeType,
		sha256: value.sha256,
		...(hasWidth ? { widthPixels: value.widthPixels as number } : {}),
	};
}

export function parseEmpatraHostUserMediaMarker(entry: SessionEntry): EmpatraHostPersistedUserMedia | undefined {
	if (entry.type !== "custom" || entry.customType !== EMPATRA_HOST_USER_MEDIA_ENTRY) return undefined;
	const value = entry.data;
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["images", "messageSha256", "turnId", "version"]) ||
		value.version !== EMPATRA_HOST_USER_MEDIA_ENTRY_VERSION ||
		typeof value.messageSha256 !== "string" ||
		!/^[a-f0-9]{64}$/u.test(value.messageSha256) ||
		typeof value.turnId !== "string" ||
		value.turnId.length === 0 ||
		value.turnId.length > 256 ||
		!Array.isArray(value.images) ||
		value.images.length === 0 ||
		value.images.length > EMPATRA_HOST_MAX_IMAGES
	) {
		return undefined;
	}
	const images = value.images.map(parseImage);
	if (images.some(image => image === undefined)) return undefined;
	const parsedImages = images as Omit<EmpatraHostProjectedImageBlock, "blockType">[];
	if (parsedImages.reduce((total, image) => total + image.byteLength, 0) > EMPATRA_HOST_MAX_IMAGE_BYTES_TOTAL) {
		return undefined;
	}
	return {
		images: parsedImages,
		messageSha256: value.messageSha256,
		turnId: value.turnId,
		version: EMPATRA_HOST_USER_MEDIA_ENTRY_VERSION,
	};
}

export function parseEmpatraHostUserMediaCancellation(
	entry: SessionEntry,
): EmpatraHostPersistedUserMediaCancellation | undefined {
	if (entry.type !== "custom" || entry.customType !== EMPATRA_HOST_USER_MEDIA_CANCEL_ENTRY) return undefined;
	const value = entry.data;
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["markerEntryId", "turnId", "version"]) ||
		value.version !== EMPATRA_HOST_USER_MEDIA_ENTRY_VERSION ||
		typeof value.markerEntryId !== "string" ||
		value.markerEntryId.length === 0 ||
		value.markerEntryId.length > 256 ||
		typeof value.turnId !== "string" ||
		value.turnId.length === 0 ||
		value.turnId.length > 256
	) {
		return undefined;
	}
	return { markerEntryId: value.markerEntryId, turnId: value.turnId, version: EMPATRA_HOST_USER_MEDIA_ENTRY_VERSION };
}

export function hasEmpatraHostUserMediaMarker(
	entries: readonly SessionEntry[],
	turnId: string,
	messageSha256: string,
): boolean {
	return entries.some(entry => {
		const marker = parseEmpatraHostUserMediaMarker(entry);
		return marker?.turnId === turnId && marker.messageSha256 === messageSha256;
	});
}

function strictBase64(value: string): Buffer | undefined {
	if (value.length === 0 || value.length > Math.ceil(EMPATRA_HOST_MAX_IMAGE_BYTES / 3) * 4 + 4) return undefined;
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return undefined;
	const bytes = Buffer.from(value, "base64");
	return bytes.byteLength > 0 && bytes.byteLength <= EMPATRA_HOST_MAX_IMAGE_BYTES ? bytes : undefined;
}

function dimensions(bytes: Buffer, mimeType: EmpatraHostImageMimeType): readonly [number, number] | undefined {
	if (
		mimeType === "image/png" &&
		bytes.length >= 24 &&
		bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
	) {
		return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
	}
	if (mimeType === "image/gif" && bytes.length >= 10 && /^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString("ascii"))) {
		return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
	}
	if (
		mimeType === "image/webp" &&
		bytes.length >= 30 &&
		bytes.toString("ascii", 0, 4) === "RIFF" &&
		bytes.toString("ascii", 8, 12) === "WEBP"
	) {
		const kind = bytes.toString("ascii", 12, 16);
		if (kind === "VP8X") return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
		if (kind === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
			return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
		}
		if (kind === "VP8L" && bytes[20] === 0x2f) {
			return [
				1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8)),
				1 + ((bytes[22]! >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10)),
			];
		}
	}
	if (mimeType === "image/jpeg" && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 8 < bytes.length) {
			if (bytes[offset] !== 0xff) return undefined;
			const marker = bytes[offset + 1]!;
			offset += 2;
			if (marker === 0xd8 || marker === 0xd9) continue;
			const length = bytes.readUInt16BE(offset);
			if (length < 2 || offset + length > bytes.length) return undefined;
			if (
				(marker >= 0xc0 && marker <= 0xc3) ||
				(marker >= 0xc5 && marker <= 0xc7) ||
				(marker >= 0xc9 && marker <= 0xcb) ||
				(marker >= 0xcd && marker <= 0xcf)
			) {
				return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
			}
			offset += length;
		}
	}
	return undefined;
}

export function projectEmpatraHostFallbackImages(content: unknown): readonly EmpatraHostProjectedImageBlock[] {
	if (!Array.isArray(content)) return [];
	const candidates = content.filter(
		(block): block is Record<string, unknown> => isRecord(block) && block.type === "image",
	);
	if (candidates.length === 0 || candidates.length > EMPATRA_HOST_MAX_IMAGES) return [];
	const projected: EmpatraHostProjectedImageBlock[] = [];
	let aggregateBytes = 0;
	for (const [index, block] of candidates.entries()) {
		if (
			typeof block.data !== "string" ||
			(block.mimeType !== "image/gif" &&
				block.mimeType !== "image/jpeg" &&
				block.mimeType !== "image/png" &&
				block.mimeType !== "image/webp")
		) {
			return [];
		}
		const bytes = strictBase64(block.data);
		if (!bytes) return [];
		aggregateBytes += bytes.byteLength;
		if (aggregateBytes > EMPATRA_HOST_MAX_IMAGE_BYTES_TOTAL) return [];
		const size = dimensions(bytes, block.mimeType);
		if (!size || size[0] <= 0 || size[1] <= 0 || size[0] * size[1] > EMPATRA_HOST_MAX_IMAGE_PIXELS) return [];
		const extension = block.mimeType === "image/jpeg" ? "jpg" : block.mimeType.slice("image/".length);
		projected.push({
			blockType: "image",
			byteLength: bytes.byteLength,
			...(block.detail === "auto" || block.detail === "high" || block.detail === "low"
				? { detail: block.detail }
				: {}),
			displayName: `Изображение ${index + 1}.${extension}`,
			heightPixels: size[1],
			mimeType: block.mimeType,
			sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
			widthPixels: size[0],
		});
	}
	return projected;
}
