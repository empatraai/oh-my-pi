#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

import { COMPILED_EXTERNAL_DEPENDENCIES, compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";

interface BinaryTarget {
	arch: string;
	id: string;
	outfile: string;
	platform: string;
	target: Bun.Build.CompileTarget;
}

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
const entrypoint = path.join(repoRoot, "packages", "coding-agent", "src", "empatra-host-cli.ts");
const isDryRun = process.argv.includes("--dry-run");
const targets: readonly BinaryTarget[] = [
	{
		arch: "arm64",
		id: "darwin-arm64",
		outfile: "packages/coding-agent/binaries/empatra-omp-darwin-arm64",
		platform: "darwin",
		target: "bun-darwin-arm64",
	},
	{
		arch: "x64",
		id: "win32-x64",
		outfile: "packages/coding-agent/binaries/empatra-omp-windows-x64.exe",
		platform: "win32",
		target: "bun-windows-x64-baseline",
	},
];

const transformersManifest: unknown = createRequire(import.meta.url)("@huggingface/transformers/package.json");
if (
	typeof transformersManifest !== "object" ||
	transformersManifest === null ||
	!("version" in transformersManifest) ||
	typeof transformersManifest.version !== "string"
) {
	throw new Error("@huggingface/transformers package manifest has no string version");
}

function parseRequestedTarget(): BinaryTarget {
	const flagIndex = process.argv.indexOf("--targets");
	const requested =
		flagIndex >= 0
			? process.argv[flagIndex + 1]
			: (process.argv.find(arg => arg.startsWith("--targets="))?.split("=", 2)[1] ?? Bun.env.RELEASE_TARGETS);
	if (!requested || requested.includes(",")) {
		throw new Error("The Empatra host build requires exactly one target");
	}
	const target = targets.find(candidate => candidate.id === requested);
	if (!target) throw new Error(`Unsupported Empatra host target: ${requested}`);
	return target;
}

async function runCommand(command: string[], env: NodeJS.ProcessEnv = Bun.env): Promise<void> {
	if (isDryRun) {
		console.log(`DRY RUN ${command.join(" ")}`);
		return;
	}
	const child = Bun.spawn(command, { cwd: repoRoot, env, stderr: "inherit", stdout: "inherit" });
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

async function main(): Promise<void> {
	const target = parseRequestedTarget();
	await fs.mkdir(binariesDir, { recursive: true });
	try {
		await runCommand(["bun", "run", "gen:stats"]);
		await runCommand(["bun", "--cwd=packages/collab-web", "run", "gen:tool-views"]);
		await runCommand(["bun", "run", "gen:native"], {
			...Bun.env,
			TARGET_ARCH: target.arch,
			TARGET_PLATFORM: target.platform,
		});
		if (isDryRun) {
			console.log(
				`DRY RUN Bun.build target=${target.target} entrypoint=${path.relative(repoRoot, entrypoint)} outfile=${target.outfile} external=${COMPILED_EXTERNAL_DEPENDENCIES.join(",")}`,
			);
			return;
		}
		const output = path.join(repoRoot, target.outfile);
		await compileCodingAgent({
			entrypoint,
			minifyIdentifiers: true,
			minifySyntax: true,
			minifyWhitespace: true,
			outfile: output,
			repoRoot,
			skipBuiltinCodesign: target.platform === "darwin" && process.platform === "darwin",
			target: target.target,
			transformersVersion: transformersManifest.version,
		});
		if (target.platform === "darwin" && process.platform === "darwin") {
			await runCommand(["codesign", "--force", "--sign", "-", output]);
		}
	} finally {
		await runCommand(["bun", "run", "gen:native:reset"]);
		await runCommand(["bun", "run", "gen:stats:reset"]);
	}
}

await main();
