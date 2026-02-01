#!/usr/bin/env node

import { Command } from "commander";
import ora from "ora";
import path from "path";
import { translatePoFile, translatePoDirectory } from "../src/index.js";

const program = new Command();

program
	.name("lingui-ai-translate")
	.description("Translate Lingui .po files using OpenAI")
	.option("-f, --file <path>", "Path to a .po file to translate")
	.option("-l, --language <lang>", "Target language code, e.g. fr, de")
	.option(
		"-d, --directory <path>",
		"Directory containing .po files to batch translate",
	)
	.option(
		"--provider <name>",
		"Provider: openai (default), anthropic, or gemini",
		"openai",
	)
	.option(
		"--model <model>",
		"Model to use (e.g. gpt-4o-mini, claude-3-5-haiku-20241022, gemini-2.0-flash)",
	)
	.option("--dry-run", "Do not write files, just show planned changes", false)
	.option(
		"--include <glob>",
		'Glob pattern relative to directory, e.g. "**/messages.po"',
		"**/*.po",
	)
	.option(
		"--concurrency <n>",
		"Parallel files to process",
		(v) => parseInt(v, 10),
		2,
	)
	.option(
		"--rules <rules>",
		'Additional translation rules (e.g., "only use first person, do not translate this word")',
	)
	.showHelpAfterError();

program.parse(process.argv);

const opts = program.opts();

function formatProgressText({ filePath, processed, total }) {
	const rel = path.relative(process.cwd(), filePath);
	return `${rel} – ${processed}/${total}`;
}

const PROVIDER_API_KEYS = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	gemini: "GEMINI_API_KEY",
};

async function run() {
	const apiKeyEnv = PROVIDER_API_KEYS[opts.provider] || "OPENAI_API_KEY";
	if (!process.env[apiKeyEnv]) {
		console.error(`Missing ${apiKeyEnv} in environment`);
		process.exit(1);
	}

	if (opts.file && opts.directory) {
		console.error("Please specify either --file or --directory, not both.");
		process.exit(1);
	}

	if (!opts.file && !opts.directory) {
		console.error("Please specify --file <path> or --directory <path>.");
		program.help({ error: true });
	}

	if (opts.file) {
		if (!opts.language) {
			console.error("When using --file, --language is required (e.g., -l fr).");
			process.exit(1);
		}
		const spinner = ora(`Translating ${opts.file}`).start();
		await translatePoFile({
			filePath: opts.file,
			language: opts.language,
			provider: opts.provider,
			model: opts.model,
			dryRun: opts.dryRun,
			rules: opts.rules,
			onProgress: (ev) => {
				if (ev.type === "start")
					spinner.text = formatProgressText({
						filePath: ev.filePath,
						processed: 0,
						total: ev.total,
					});
				if (ev.type === "progress") spinner.text = formatProgressText(ev);
				if (ev.type === "done")
					ev.dryRun
						? spinner.info(formatProgressText(ev))
						: spinner.succeed(formatProgressText(ev));
			},
		});
		return;
	}

	if (opts.directory) {
		const spinner = ora(`Scanning ${opts.directory}`).start();
		await translatePoDirectory({
			directoryPath: opts.directory,
			include: opts.include,
			defaultProvider: opts.provider,
			defaultModel: opts.model,
			dryRun: opts.dryRun,
			concurrency: opts.concurrency,
			defaultLanguage: opts.language,
			rules: opts.rules,
			onProgress: (ev) => {
				if (ev.type === "start")
					spinner.text = formatProgressText({
						filePath: ev.filePath,
						processed: 0,
						total: ev.total,
					});
				if (ev.type === "progress") spinner.text = formatProgressText(ev);
				if (ev.type === "done")
					ev.dryRun
						? spinner.info(formatProgressText(ev))
						: spinner.succeed(formatProgressText(ev));
			},
		});
		spinner.stop();
		return;
	}
}

run().catch((err) => {
	console.error(err?.message || err);
	process.exit(1);
});
