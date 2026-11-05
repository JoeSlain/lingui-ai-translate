#!/usr/bin/env node

import { Command } from "commander";
import ora from "ora";
import path from "path";
import {
	translatePoFile,
	translatePoDirectory,
	submitTranslationBatch,
	resumeTranslationBatch,
} from "../src/index.js";

const program = new Command();

program
	.name("lingui-ai-translate")
	.description("Translate Lingui .po files using OpenAI")
	.option("-f, --file <path>", "Path to a .po file to translate")
	.option("-l, --language <lang>", "Target language code, e.g. fr, de")
	.option("-d, --directory <path>", "Directory containing .po files to batch translate")
	.option("--provider <name>", "Provider: openai (default), anthropic, or gemini", "openai")
	.option(
		"--model <model>",
		"Model to use (default OpenAI: gpt-6-luna; e.g. claude-3-5-haiku-20241022, gemini-2.0-flash)",
	)
	.option("--mode <mode>", "sync (immediate) or batch (OpenAI asynchronous discount)", "sync")
	.option("--batch-size <n>", "Strings per request", Number, 50)
	.option("--cache <path>", "Reusable translation cache", ".lingui-ai-translate/cache.json")
	.option("--no-cache", "Disable the translation cache")
	.option(
		"--usage-log <path>",
		"Append token usage and cost estimates as JSONL",
		".lingui-ai-translate/usage.jsonl",
	)
	.option("--max-requests <n>", "Maximum provider attempts per invocation", Number)
	.option(
		"--max-cost-usd <n>",
		"Conservative estimated USD ceiling (known OpenAI prices only)",
		Number,
	)
	.option(
		"--job <path>",
		"Batch job manifest (never submitted twice)",
		".lingui-ai-translate/batch.json",
	)
	.option("--resume <path>", "Retrieve and apply an existing Batch job; never resubmit")
	.option("--dry-run", "Do not write files, just show planned changes", false)
	.option(
		"--include <glob>",
		'Glob pattern relative to directory, e.g. "**/messages.po"',
		"**/*.po",
	)
	.option("--concurrency <n>", "Parallel files to process", (v) => parseInt(v, 10), 2)
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

let activeSpinner = null;

function stopSpinnerOnError() {
	if (!activeSpinner) return;
	activeSpinner.stop();
	activeSpinner.clear();
	activeSpinner = null;
}

const PROVIDER_API_KEYS = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	gemini: "GEMINI_API_KEY",
};

async function run() {
	const apiKeyEnv = PROVIDER_API_KEYS[opts.provider] || "OPENAI_API_KEY";
	if (
		!opts.dryRun &&
		!(process.env[apiKeyEnv] || (opts.provider === "openai" && process.env.LINGUI_OPENAI_API_KEY))
	) {
		console.error(`Missing ${apiKeyEnv} in environment`);
		process.exit(1);
	}

	if (!["sync", "batch"].includes(opts.mode)) throw new Error("--mode must be sync or batch");
	const safety = {
		cachePath: opts.cache === false ? undefined : opts.cache,
		usageLog: opts.usageLog,
		maxRequests: opts.maxRequests,
		maxCostUsd: opts.maxCostUsd,
		onUsage: (event) => console.info("[translation][usage]", JSON.stringify(event)),
	};
	if (opts.resume) {
		if (opts.file || opts.directory)
			throw new Error("--resume cannot be combined with --file or --directory");
		if (opts.provider !== "openai") throw new Error("Batch mode requires OpenAI");
		const result = await resumeTranslationBatch({
			jobPath: opts.resume,
			dryRun: opts.dryRun,
			...safety,
		});
		console.info(JSON.stringify(result));
		if (result.missing) process.exitCode = 1;
		return;
	}
	if (opts.file && opts.directory) {
		console.error("Please specify either --file or --directory, not both.");
		process.exit(1);
	}

	if (!opts.file && !opts.directory) {
		console.error("Please specify --file <path> or --directory <path>.");
		program.help({ error: true });
	}

	if (opts.mode === "batch") {
		if (opts.provider !== "openai") throw new Error("Batch mode requires OpenAI");
		const result = await submitTranslationBatch({
			directoryPath: opts.directory,
			filePath: opts.file,
			language: opts.language,
			include: opts.include,
			model: opts.model,
			rules: opts.rules,
			batchSize: opts.batchSize,
			jobPath: opts.job,
			dryRun: opts.dryRun,
			...safety,
		});
		console.info(JSON.stringify(result));
		return;
	}

	if (opts.file) {
		if (!opts.language) {
			console.error("When using --file, --language is required (e.g., -l fr).");
			process.exit(1);
		}
		activeSpinner = ora(`Translating ${opts.file}`).start();
		try {
			await translatePoFile({
				...safety,
				batchSize: opts.batchSize,
				filePath: opts.file,
				language: opts.language,
				provider: opts.provider,
				model: opts.model,
				dryRun: opts.dryRun,
				rules: opts.rules,
				onProgress: (ev) => {
					if (ev.type === "start")
						activeSpinner.text = formatProgressText({
							filePath: ev.filePath,
							processed: 0,
							total: ev.total,
						});
					if (ev.type === "progress") activeSpinner.text = formatProgressText(ev);
					if (ev.type === "done") {
						if (ev.dryRun) activeSpinner.info(formatProgressText(ev));
						else activeSpinner.succeed(formatProgressText(ev));
					}
				},
			});
		} catch (err) {
			activeSpinner.fail("Translation failed");
			throw err;
		} finally {
			activeSpinner = null;
		}
		return;
	}

	if (opts.directory) {
		activeSpinner = ora(`Scanning ${opts.directory}`).start();
		try {
			await translatePoDirectory({
				...safety,
				batchSize: opts.batchSize,
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
						activeSpinner.text = formatProgressText({
							filePath: ev.filePath,
							processed: 0,
							total: ev.total,
						});
					if (ev.type === "progress") activeSpinner.text = formatProgressText(ev);
					if (ev.type === "done") {
						if (ev.dryRun) activeSpinner.info(formatProgressText(ev));
						else activeSpinner.succeed(formatProgressText(ev));
					}
				},
			});
		} catch (err) {
			activeSpinner.fail("Translation failed");
			throw err;
		} finally {
			activeSpinner.stop();
			activeSpinner = null;
		}
		return;
	}
}

run().catch((err) => {
	stopSpinnerOnError();
	console.error(err?.message || err);
	process.exit(1);
});
