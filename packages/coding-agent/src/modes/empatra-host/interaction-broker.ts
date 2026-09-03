import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "../../extensibility/extensions/types";
import { getExtensionUISelectOptionLabel } from "../../extensibility/extensions/types";
import { theme } from "../theme/theme";

export const EMPATRA_HOST_MAX_PENDING_INTERACTIONS = 4096;
export const EMPATRA_HOST_MAX_PENDING_INTERACTIONS_PER_THREAD = 64;

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_ID_LENGTH = 256;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_APPROVAL_RAW_INPUT_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_SELECT_OPTIONS = 128;
const MAX_ASK_QUESTIONS = 32;
const MAX_RETIRED_REQUEST_IDS = 8192;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
const CONTROL_CHARACTER = /\p{Cc}/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface EmpatraHostInteractionRequestBase {
	createdAt: number;
	digest: string;
	expiresAt: number;
	generation: number;
	requestId: string;
	threadId: string;
	turnId: string;
}

export interface EmpatraHostInteractionScope {
	generation: number;
	threadId: string;
	turnId: string;
}

export interface EmpatraHostApprovalRequest extends EmpatraHostInteractionRequestBase {
	displayInput: string;
	inputDigest: string;
	kind: "approval";
	prompt: string;
	toolCallId: string;
	toolName: string;
}

interface EmpatraHostUserInputRequestBase extends EmpatraHostInteractionRequestBase {
	kind: "user_input";
}

export interface EmpatraHostSelectRequest extends EmpatraHostUserInputRequestBase {
	inputKind: "select";
	options: ReadonlyArray<{ description?: string; label: string }>;
	title: string;
}

export interface EmpatraHostConfirmRequest extends EmpatraHostUserInputRequestBase {
	inputKind: "confirm";
	message: string;
	title: string;
}

export interface EmpatraHostTextInputRequest extends EmpatraHostUserInputRequestBase {
	inputKind: "input";
	placeholder?: string;
	title: string;
}

export interface EmpatraHostEditorRequest extends EmpatraHostUserInputRequestBase {
	inputKind: "editor";
	prefill?: string;
	promptStyle?: boolean;
	title: string;
}

export interface EmpatraHostAskDialogRequest extends EmpatraHostUserInputRequestBase {
	inputKind: "ask_dialog";
	questions: readonly ExtensionAskDialogQuestion[];
}

export type EmpatraHostInteractionRequest =
	| EmpatraHostApprovalRequest
	| EmpatraHostAskDialogRequest
	| EmpatraHostConfirmRequest
	| EmpatraHostEditorRequest
	| EmpatraHostSelectRequest
	| EmpatraHostTextInputRequest;

/** Secret-free notification emitted when a pending interaction expires. */
export interface EmpatraHostInteractionExpiredEvent {
	digest: string;
	event: "interaction_expired";
	generation: number;
	requestId: string;
	sequence: number;
	threadId: string;
	turnId: string;
	type: "host_event";
}

export interface EmpatraHostApprovalResponse {
	decision: "approve" | "deny";
	digest: string;
	feedback?: string;
	kind: "approval_response";
	requestId: string;
}

export interface EmpatraHostUserInputResponse {
	digest: string;
	inputKind: "ask_dialog" | "confirm" | "editor" | "input" | "select";
	kind: "user_input_response";
	requestId: string;
	value: ExtensionAskDialogResult | boolean | string | null;
}

export type EmpatraHostInteractionResponse = EmpatraHostApprovalResponse | EmpatraHostUserInputResponse;

export type EmpatraHostInteractionResolution =
	| { accepted: true; expiresAt?: number }
	| { accepted: false; code: "identity_mismatch" | "invalid_response" | "not_pending" };

export type EmpatraHostInteractionErrorCode =
	| "aborted"
	| "cancelled"
	| "delivery_failed"
	| "disposed"
	| "host_capacity"
	| "identity_mismatch"
	| "invalid_request"
	| "invalid_response"
	| "thread_capacity"
	| "timeout";

const SAFE_ERROR_MESSAGES: Readonly<Record<EmpatraHostInteractionErrorCode, string>> = {
	aborted: "OMP host interaction was aborted",
	cancelled: "OMP host interaction was cancelled",
	delivery_failed: "OMP host interaction delivery failed",
	disposed: "OMP host interaction broker is unavailable",
	host_capacity: "OMP host interaction capacity is exhausted",
	identity_mismatch: "OMP host interaction identity validation failed",
	invalid_request: "OMP host interaction request is invalid",
	invalid_response: "OMP host interaction response is invalid",
	thread_capacity: "OMP thread interaction capacity is exhausted",
	timeout: "OMP host interaction timed out",
};

export class EmpatraHostInteractionError extends Error {
	readonly code: EmpatraHostInteractionErrorCode;

	constructor(code: EmpatraHostInteractionErrorCode) {
		super(SAFE_ERROR_MESSAGES[code]);
		this.name = "EmpatraHostInteractionError";
		this.code = code;
	}
}

interface PendingInteraction {
	abortListener?: () => void;
	byteLength: number;
	onTimeout?: () => void;
	onTimeoutReset?: () => void;
	reject: (error: EmpatraHostInteractionError) => void;
	request: EmpatraHostInteractionRequest;
	resolve: (response: EmpatraHostInteractionResponse) => void;
	signal?: AbortSignal;
	timeout?: Timer;
	timeoutMs: number;
}

export interface EmpatraHostInteractionBrokerOptions {
	createRequestId?: () => string;
	defaultTimeoutMs?: number;
	emitRequest: (request: EmpatraHostInteractionRequest) => Promise<void> | void;
	/** Notifies the owning host without exposing interaction input or credentials. */
	emitTimeout?: (request: EmpatraHostInteractionRequest) => Promise<void> | void;
	now?: () => number;
}

type RequestWithoutDigest<T> = T extends EmpatraHostInteractionRequest ? Omit<T, "digest"> : never;
type EmpatraHostInteractionRequestMaterial = RequestWithoutDigest<EmpatraHostInteractionRequest>;

export class EmpatraHostInteractionBroker {
	readonly #createRequestId: () => string;
	readonly #defaultTimeoutMs: number;
	readonly #emitRequest: EmpatraHostInteractionBrokerOptions["emitRequest"];
	readonly #emitTimeout: EmpatraHostInteractionBrokerOptions["emitTimeout"];
	readonly #now: () => number;
	readonly #pending = new Map<string, PendingInteraction>();
	readonly #retiredRequestIds = new Set<string>();
	readonly #threadPending = new Map<string, number>();
	#disposed = false;
	#pendingBytes = 0;

	constructor(options: EmpatraHostInteractionBrokerOptions) {
		this.#createRequestId = options.createRequestId ?? (() => `interaction-${Bun.randomUUIDv7()}`);
		this.#defaultTimeoutMs = validTimeout(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
		this.#emitRequest = options.emitRequest;
		this.#emitTimeout = options.emitTimeout;
		this.#now = options.now ?? Date.now;
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	async select(
		scope: EmpatraHostInteractionScope,
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		const approval = dialogOptions?.internalApprovalContext;
		if (approval) {
			const displayInput = exactBoundedText(approval.rawInput, MAX_APPROVAL_RAW_INPUT_BYTES);
			const response = await this.#enqueue(
				{
					...this.#requestBase(scope, dialogOptions),
					displayInput,
					kind: "approval",
					prompt: boundedText(title),
					inputDigest: validSha256(approval.inputDigest),
					toolCallId: validIdentity(approval.toolCallId),
					toolName: validIdentity(approval.toolName),
				},
				dialogOptions,
			);
			if (response.kind !== "approval_response") throw new EmpatraHostInteractionError("invalid_response");
			if (approval) approval.feedback = response.feedback;
			return response.decision === "approve" ? "Approve" : "Deny";
		}
		if (options.length === 0 || options.length > MAX_SELECT_OPTIONS) {
			throw new EmpatraHostInteractionError("invalid_request");
		}
		const normalizedOptions = options.map(option => ({
			...(typeof option === "string" || option.description === undefined
				? {}
				: { description: boundedText(option.description) }),
			label: boundedText(getExtensionUISelectOptionLabel(option)),
		}));
		const response = await this.#enqueue(
			{
				...this.#requestBase(scope, dialogOptions),
				inputKind: "select",
				kind: "user_input",
				options: normalizedOptions,
				title: boundedText(title),
			},
			dialogOptions,
		);
		if (response.kind !== "user_input_response" || response.inputKind !== "select") {
			throw new EmpatraHostInteractionError("invalid_response");
		}
		return typeof response.value === "string" ? response.value : undefined;
	}

	async confirm(
		scope: EmpatraHostInteractionScope,
		title: string,
		message: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const response = await this.#enqueue(
			{
				...this.#requestBase(scope, dialogOptions),
				inputKind: "confirm",
				kind: "user_input",
				message: boundedText(message),
				title: boundedText(title),
			},
			dialogOptions,
		);
		if (response.kind !== "user_input_response" || response.inputKind !== "confirm") {
			throw new EmpatraHostInteractionError("invalid_response");
		}
		return response.value === true;
	}

	async input(
		scope: EmpatraHostInteractionScope,
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		const response = await this.#enqueue(
			{
				...this.#requestBase(scope, dialogOptions),
				inputKind: "input",
				kind: "user_input",
				...(placeholder === undefined ? {} : { placeholder: boundedText(placeholder) }),
				title: boundedText(title),
			},
			dialogOptions,
		);
		if (response.kind !== "user_input_response" || response.inputKind !== "input") {
			throw new EmpatraHostInteractionError("invalid_response");
		}
		return typeof response.value === "string" ? response.value : undefined;
	}

	async editor(
		scope: EmpatraHostInteractionScope,
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		const response = await this.#enqueue(
			{
				...this.#requestBase(scope, dialogOptions),
				inputKind: "editor",
				kind: "user_input",
				...(prefill === undefined ? {} : { prefill: exactBoundedText(prefill, MAX_INPUT_BYTES) }),
				...(editorOptions?.promptStyle === undefined ? {} : { promptStyle: editorOptions.promptStyle }),
				title: boundedText(title),
			},
			dialogOptions,
		);
		if (response.kind !== "user_input_response" || response.inputKind !== "editor") {
			throw new EmpatraHostInteractionError("invalid_response");
		}
		return typeof response.value === "string" ? response.value : undefined;
	}

	async askDialog(
		scope: EmpatraHostInteractionScope,
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		if (questions.length === 0 || questions.length > MAX_ASK_QUESTIONS || !isBoundedJson(questions)) {
			throw new EmpatraHostInteractionError("invalid_request");
		}
		const response = await this.#enqueue(
			{
				...this.#requestBase(scope, dialogOptions),
				inputKind: "ask_dialog",
				kind: "user_input",
				questions: cloneAskQuestions(questions),
			},
			dialogOptions,
		);
		if (response.kind !== "user_input_response" || response.inputKind !== "ask_dialog") {
			throw new EmpatraHostInteractionError("invalid_response");
		}
		return response.value === null ? undefined : (response.value as ExtensionAskDialogResult);
	}

	resolveResponse(response: unknown): EmpatraHostInteractionResolution {
		const identity = responseIdentity(response);
		if (!identity) return { accepted: false, code: "invalid_response" };
		const pending = this.#pending.get(identity.requestId);
		if (!pending) return { accepted: false, code: "not_pending" };
		if (pending.request.digest !== identity.digest) {
			return { accepted: false, code: "identity_mismatch" };
		}
		const parsed = parseResponse(response, pending.request);
		if (!parsed) {
			return { accepted: false, code: "invalid_response" };
		}
		this.#remove(pending);
		pending.resolve(parsed);
		return { accepted: true };
	}

	cancel(requestId: string, digest: string): EmpatraHostInteractionResolution {
		const pending = this.#pending.get(requestId);
		if (!pending) return { accepted: false, code: "not_pending" };
		if (pending.request.digest !== digest) {
			return { accepted: false, code: "identity_mismatch" };
		}
		this.#reject(pending, "cancelled");
		return { accepted: true };
	}

	noteActivity(requestId: string, digest: string): EmpatraHostInteractionResolution {
		const pending = this.#pending.get(requestId);
		if (!pending) return { accepted: false, code: "not_pending" };
		if (pending.request.digest !== digest) {
			return { accepted: false, code: "identity_mismatch" };
		}
		if (pending.timeout) clearTimeout(pending.timeout);
		invokeCallback(pending.onTimeoutReset);
		this.#armTimeout(pending);
		return { accepted: true, expiresAt: pending.request.expiresAt };
	}

	cancelThread(threadId: string): void {
		for (const pending of [...this.#pending.values()]) {
			if (pending.request.threadId === threadId) this.#reject(pending, "cancelled");
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const pending of [...this.#pending.values()]) this.#reject(pending, "disposed");
	}

	#requestBase(scope: EmpatraHostInteractionScope, dialogOptions: ExtensionUIDialogOptions | undefined) {
		if (this.#disposed) throw new EmpatraHostInteractionError("disposed");
		const normalizedThreadId = validIdentity(scope.threadId);
		const turnId = validIdentity(scope.turnId);
		if (!Number.isSafeInteger(scope.generation) || scope.generation < 1) {
			throw new EmpatraHostInteractionError("invalid_request");
		}
		const timeoutMs = validTimeout(dialogOptions?.timeout ?? this.#defaultTimeoutMs);
		let createdAt: number;
		try {
			createdAt = this.#now();
		} catch {
			throw new EmpatraHostInteractionError("invalid_request");
		}
		if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(createdAt + timeoutMs)) {
			throw new EmpatraHostInteractionError("invalid_request");
		}
		return {
			createdAt,
			expiresAt: createdAt + timeoutMs,
			generation: scope.generation,
			requestId: this.#nextRequestId(),
			threadId: normalizedThreadId,
			turnId,
		};
	}

	#nextRequestId(): string {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			let candidate: string;
			try {
				candidate = validIdentity(this.#createRequestId());
			} catch {
				throw new EmpatraHostInteractionError("invalid_request");
			}
			if (!this.#pending.has(candidate) && !this.#retiredRequestIds.has(candidate)) return candidate;
		}
		throw new EmpatraHostInteractionError("host_capacity");
	}

	#enqueue(
		material: EmpatraHostInteractionRequestMaterial,
		dialogOptions: ExtensionUIDialogOptions | undefined,
	): Promise<EmpatraHostInteractionResponse> {
		if (this.#pending.size >= EMPATRA_HOST_MAX_PENDING_INTERACTIONS) {
			throw new EmpatraHostInteractionError("host_capacity");
		}
		const threadCount = this.#threadPending.get(material.threadId) ?? 0;
		if (threadCount >= EMPATRA_HOST_MAX_PENDING_INTERACTIONS_PER_THREAD) {
			throw new EmpatraHostInteractionError("thread_capacity");
		}
		const requestBytes = jsonByteLength(material);
		if (requestBytes === undefined || requestBytes + this.#pendingBytes > MAX_PENDING_BYTES) {
			throw new EmpatraHostInteractionError("host_capacity");
		}
		const request = { ...material, digest: requestDigest(material) } as EmpatraHostInteractionRequest;
		return new Promise((resolve, reject) => {
			const pending: PendingInteraction = {
				byteLength: requestBytes,
				onTimeout: dialogOptions?.onTimeout,
				onTimeoutReset: dialogOptions?.onTimeoutReset,
				reject,
				request,
				resolve,
				signal: dialogOptions?.signal,
				timeoutMs: request.expiresAt - request.createdAt,
			};
			this.#pending.set(request.requestId, pending);
			this.#pendingBytes += requestBytes;
			this.#threadPending.set(request.threadId, threadCount + 1);
			if (pending.signal) {
				pending.abortListener = () => this.#reject(pending, "aborted");
				pending.signal.addEventListener("abort", pending.abortListener, { once: true });
			}
			if (pending.signal?.aborted) {
				this.#reject(pending, "aborted");
				return;
			}
			invokeCallback(dialogOptions?.onTimeoutStart);
			this.#armTimeout(pending);
			try {
				void Promise.resolve(this.#emitRequest(structuredClone(request))).catch(() =>
					this.#reject(pending, "delivery_failed"),
				);
			} catch {
				this.#reject(pending, "delivery_failed");
			}
		});
	}

	#armTimeout(pending: PendingInteraction): void {
		const remainingMs = pending.request.expiresAt - this.#now();
		if (remainingMs <= 0) {
			invokeCallback(pending.onTimeout);
			this.#reject(pending, "timeout");
			return;
		}
		pending.timeout = setTimeout(
			() => {
				invokeCallback(pending.onTimeout);
				this.#reject(pending, "timeout");
			},
			Math.min(pending.timeoutMs, remainingMs),
		);
	}

	#reject(pending: PendingInteraction, code: EmpatraHostInteractionErrorCode): void {
		if (!this.#pending.has(pending.request.requestId)) return;
		this.#remove(pending);
		if (code === "timeout" && this.#emitTimeout) {
			invokeAsyncCallback(this.#emitTimeout, pending.request);
		}
		pending.reject(new EmpatraHostInteractionError(code));
	}

	#remove(pending: PendingInteraction): void {
		this.#pending.delete(pending.request.requestId);
		this.#pendingBytes = Math.max(0, this.#pendingBytes - pending.byteLength);
		this.#retiredRequestIds.add(pending.request.requestId);
		if (this.#retiredRequestIds.size > MAX_RETIRED_REQUEST_IDS) {
			const oldest = this.#retiredRequestIds.values().next().value;
			if (oldest !== undefined) this.#retiredRequestIds.delete(oldest);
		}
		if (pending.timeout) clearTimeout(pending.timeout);
		if (pending.signal && pending.abortListener) {
			pending.signal.removeEventListener("abort", pending.abortListener);
		}
		const threadCount = this.#threadPending.get(pending.request.threadId) ?? 1;
		if (threadCount <= 1) this.#threadPending.delete(pending.request.threadId);
		else this.#threadPending.set(pending.request.threadId, threadCount - 1);
	}
}

export function createEmpatraHostInteractionUIContext(options: {
	base?: ExtensionUIContext;
	broker: EmpatraHostInteractionBroker;
	getScope: () => EmpatraHostInteractionScope | undefined;
}): ExtensionUIContext {
	const base = options.base ?? headlessUIContext;
	const scope = (): EmpatraHostInteractionScope => {
		const value = options.getScope();
		if (!value) throw new EmpatraHostInteractionError("invalid_request");
		return value;
	};
	const overrides = new Map<PropertyKey, unknown>([
		[
			"askDialog",
			(questions: ExtensionAskDialogQuestion[], dialogOptions?: ExtensionUIDialogOptions) =>
				options.broker.askDialog(scope(), questions, dialogOptions),
		],
		[
			"confirm",
			(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions) =>
				options.broker.confirm(scope(), title, message, dialogOptions),
		],
		[
			"editor",
			(
				title: string,
				prefill?: string,
				dialogOptions?: ExtensionUIDialogOptions,
				editorOptions?: { promptStyle?: boolean },
			) => options.broker.editor(scope(), title, prefill, dialogOptions, editorOptions),
		],
		[
			"input",
			(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions) =>
				options.broker.input(scope(), title, placeholder, dialogOptions),
		],
		[
			"select",
			(title: string, selectOptions: ExtensionUISelectItem[], dialogOptions?: ExtensionUIDialogOptions) =>
				options.broker.select(scope(), title, selectOptions, dialogOptions),
		],
	]);
	return new Proxy(base, {
		get(target, property) {
			if (overrides.has(property)) return overrides.get(property);
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

const headlessUIContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: () => Promise.resolve({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

function validIdentity(value: string): string {
	if (!value || value.length > MAX_ID_LENGTH || CONTROL_CHARACTER.test(value)) {
		throw new EmpatraHostInteractionError("invalid_request");
	}
	return value;
}

function validSha256(value: string): string {
	if (!/^[a-f0-9]{64}$/.test(value)) throw new EmpatraHostInteractionError("invalid_request");
	return value;
}

function validTimeout(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
		throw new EmpatraHostInteractionError("invalid_request");
	}
	return value;
}

function boundedText(value: string, maxBytes = MAX_TEXT_BYTES): string {
	const encoded = encoder.encode(value);
	if (encoded.byteLength <= maxBytes) return value;
	return decoder.decode(encoded.subarray(0, maxBytes));
}

function exactBoundedText(value: string, maxBytes: number): string {
	if (encoder.encode(value).byteLength > maxBytes) throw new EmpatraHostInteractionError("invalid_request");
	return value;
}

function requestDigest(request: EmpatraHostInteractionRequestMaterial): string {
	return `sha256:${Bun.SHA256.hash(JSON.stringify(request), "hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseIdentity(value: unknown): { digest: string; requestId: string } | undefined {
	if (!isRecord(value) || typeof value.requestId !== "string" || typeof value.digest !== "string") return undefined;
	return { digest: value.digest, requestId: value.requestId };
}

function parseResponse(
	value: unknown,
	request: EmpatraHostInteractionRequest,
): EmpatraHostInteractionResponse | undefined {
	if (!isRecord(value) || value.requestId !== request.requestId || value.digest !== request.digest) return undefined;
	if (request.kind === "approval") {
		if (
			!hasOnlyKeys(value, ["decision", "digest", "feedback", "kind", "requestId"]) ||
			value.kind !== "approval_response" ||
			(value.decision !== "approve" && value.decision !== "deny")
		) {
			return undefined;
		}
		const feedback = value.feedback === undefined ? undefined : validFeedback(value.feedback);
		if (feedback === false) return undefined;
		return {
			decision: value.decision,
			digest: request.digest,
			kind: "approval_response",
			requestId: request.requestId,
			...(feedback === undefined ? {} : { feedback }),
		};
	}
	if (
		!hasOnlyKeys(value, ["digest", "inputKind", "kind", "requestId", "value"]) ||
		value.kind !== "user_input_response" ||
		value.inputKind !== request.inputKind
	) {
		return undefined;
	}
	if (!validResponseValue(value.value, request)) return undefined;
	const responseValue = value.value as EmpatraHostUserInputResponse["value"];
	return {
		digest: request.digest,
		inputKind: request.inputKind,
		kind: "user_input_response",
		requestId: request.requestId,
		value: responseValue,
	};
}

function validFeedback(value: unknown): string | false {
	if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > 4 * 1024) {
		return false;
	}
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 32 && character !== "\n" && character !== "\r" && character !== "\t") return false;
	}
	return value;
}

function validResponseValue(
	value: unknown,
	request: Exclude<EmpatraHostInteractionRequest, EmpatraHostApprovalRequest>,
) {
	if (request.inputKind === "confirm") return typeof value === "boolean";
	if (request.inputKind === "input" || request.inputKind === "editor") {
		return value === null || (typeof value === "string" && isBoundedText(value));
	}
	if (request.inputKind === "select") {
		return value === null || (typeof value === "string" && request.options.some(option => option.label === value));
	}
	return value === null || isAskDialogResult(value, request.questions);
}

function isAskDialogResult(
	value: unknown,
	questions: readonly ExtensionAskDialogQuestion[],
): value is ExtensionAskDialogResult {
	if (!isRecord(value) || !isBoundedJson(value)) return false;
	if (value.kind === "chat") return hasOnlyKeys(value, ["kind"]);
	if (
		!hasOnlyKeys(value, ["kind", "results"]) ||
		value.kind !== "submit" ||
		!Array.isArray(value.results) ||
		value.results.length !== questions.length
	) {
		return false;
	}
	return value.results.every((result, index) => {
		const question = questions[index];
		if (!isRecord(result)) return false;
		if (!question) return false;
		const allowedKeys = ["customInput", "id", "multi", "note", "options", "question", "selectedOptions", "timedOut"];
		const optionLabels = question.options.map(option => option.label);
		const customInputValid =
			result.customInput === undefined ||
			(typeof result.customInput === "string" && isBoundedText(result.customInput));
		const noteValid = result.note === undefined || (typeof result.note === "string" && isBoundedText(result.note));
		const timedOutValid = result.timedOut === undefined || typeof result.timedOut === "boolean";
		const selectedOptions = Array.isArray(result.selectedOptions) ? result.selectedOptions : undefined;
		if (!selectedOptions) return false;
		return (
			hasOnlyKeys(result, allowedKeys) &&
			result.id === question.id &&
			result.question === question.question &&
			result.multi === (question.multi ?? false) &&
			Array.isArray(result.options) &&
			result.options.length === optionLabels.length &&
			result.options.every((option, optionIndex) => option === optionLabels[optionIndex]) &&
			selectedOptions.every(option => typeof option === "string" && optionLabels.includes(option)) &&
			(question.multi === true || selectedOptions.length <= 1) &&
			new Set(selectedOptions).size === selectedOptions.length &&
			customInputValid &&
			noteValid &&
			timedOutValid
		);
	});
}

function isBoundedText(value: string): boolean {
	return encoder.encode(value).byteLength <= MAX_INPUT_BYTES;
}

function isBoundedJson(value: unknown): boolean {
	const byteLength = jsonByteLength(value);
	return byteLength !== undefined && byteLength <= MAX_INPUT_BYTES;
}

function jsonByteLength(value: unknown): number | undefined {
	try {
		return encoder.encode(JSON.stringify(value)).byteLength;
	} catch {
		return undefined;
	}
}

function cloneAskQuestions(questions: ExtensionAskDialogQuestion[]): ExtensionAskDialogQuestion[] {
	try {
		return structuredClone(questions);
	} catch {
		throw new EmpatraHostInteractionError("invalid_request");
	}
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every(key => allowed.has(key));
}

function invokeCallback(callback: (() => void) | undefined): void {
	try {
		callback?.();
	} catch {
		// UI callbacks are observers and cannot change host-owned interaction state.
	}
}

function invokeAsyncCallback<T>(
	callback: ((value: T) => Promise<void> | void) | undefined,
	value: T,
): void {
	try {
		void Promise.resolve(callback?.(value)).catch(() => undefined);
	} catch {
		// Transport observers cannot change host-owned interaction state.
	}
}
