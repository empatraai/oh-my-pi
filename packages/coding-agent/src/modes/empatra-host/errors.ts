export class EmpatraHostProtocolError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "EmpatraHostProtocolError";
		this.code = code;
	}
}

export class EmpatraHostRegistryError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "EmpatraHostRegistryError";
		this.code = code;
	}
}
