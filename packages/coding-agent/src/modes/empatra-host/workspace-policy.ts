import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";

import { EmpatraHostProtocolError } from "./errors";

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalDirectory(candidate: string, field: string): Promise<string> {
	let canonical: string;
	try {
		canonical = await realpath(candidate);
		if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new EmpatraHostProtocolError("workspace_unavailable", `${field} is not an accessible directory`);
	}
	return path.normalize(canonical);
}

export class EmpatraHostWorkspacePolicy {
	readonly #roots: readonly string[];

	private constructor(roots: readonly string[]) {
		this.#roots = roots;
	}

	static async create(workspaceRoots: readonly string[]): Promise<EmpatraHostWorkspacePolicy> {
		const roots = await Promise.all(
			workspaceRoots.map((root, index) => canonicalDirectory(root, `workspaceRoots[${index}]`)),
		);
		if (new Set(roots).size !== roots.length) {
			throw new EmpatraHostProtocolError("invalid_request", "workspaceRoots resolve to duplicate directories");
		}
		return new EmpatraHostWorkspacePolicy(roots);
	}

	get roots(): readonly string[] {
		return this.#roots;
	}

	async requireCwd(cwd: string): Promise<string> {
		const canonical = await canonicalDirectory(cwd, "cwd");
		if (!this.#roots.some(root => isInside(root, canonical))) {
			throw new EmpatraHostProtocolError("workspace_denied", "cwd is outside the initialized workspace roots");
		}
		return canonical;
	}

	containsLexically(cwd: string): boolean {
		const normalized = path.normalize(path.resolve(cwd));
		return this.#roots.some(root => isInside(root, normalized));
	}
}
