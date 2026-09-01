#!/usr/bin/env bun

import { runEmpatraHostCli } from "./modes/empatra-host/cli";

const isProcessEntry = import.meta.main || process.env.PI_COMPILED === "true";

if (isProcessEntry) {
	if (process.argv.length > 2) {
		process.stderr.write("Error: the Empatra OMP host does not accept command-line arguments\n");
		process.exitCode = 2;
	} else {
		try {
			await runEmpatraHostCli();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Error: ${message}\n`);
			process.exitCode = 1;
		}
	}
}
