import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import fg from "fast-glob";
import gettextParser from "gettext-parser";
import OpenAI from "openai";
import {
	buildBatchInput,
	createBatchTranslatePrompt,
	DEFAULT_OPENAI_MODEL,
	listUntranslatedEntries,
	openAIRequestOptions,
	parseBatchTranslationResponse,
} from "./index.js";
import { createTranslationSession, writeJsonAtomic } from "./runtime.js";

function clientOrDefault(client) {
	return (
		client ||
		new OpenAI({
			apiKey: process.env.LINGUI_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
			maxRetries: 0,
		})
	);
}
function saveCatalog(file, catalog) {
	const tmp = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tmp, gettextParser.po.compile(catalog));
		fs.renameSync(tmp, file);
	} finally {
		if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
	}
}

/** Submit once. The persisted job is also the guard against accidentally paying twice. */
export async function submitTranslationBatch({
	directoryPath,
	filePath,
	include = "**/*.po",
	language,
	model = DEFAULT_OPENAI_MODEL,
	rules,
	batchSize = 50,
	jobPath = ".lingui-ai-translate/batch.json",
	dryRun = false,
	client,
	cachePath,
	usageLog,
	onUsage,
	maxRequests,
	maxCostUsd,
}) {
	if (!Number.isSafeInteger(batchSize) || batchSize < 1)
		throw new Error("batchSize must be a positive integer");
	if (!dryRun && fs.existsSync(jobPath))
		throw new Error(`Job already exists: ${jobPath}. Resume it or choose a new --job path.`);
	const session = createTranslationSession({
		cachePath,
		usageLog,
		onUsage,
		maxRequests,
		maxCostUsd,
	});
	const files = filePath
		? [path.resolve(filePath)]
		: await fg(include, { cwd: path.resolve(directoryPath), absolute: true });
	const requests = [],
		tasks = [];
	let total = 0,
		cached = 0;
	for (const file of files) {
		const po = gettextParser.po.parse(fs.readFileSync(file));
		const target = language || po.headers.language || po.headers.Language;
		if (!target) throw new Error(`No language in ${file}`);
		const context = { provider: "openai", model, language: target, rules };
		const items = listUntranslatedEntries(po);
		total += items.length;
		const pending = [];
		for (const item of items) {
			const hit = session.get(context, item.msgid, item.ctx);
			if (hit === undefined) pending.push(item);
			else {
				if (!dryRun) item.entry.msgstr[0] = hit;
				cached++;
			}
		}
		if (!dryRun && pending.length !== items.length) saveCatalog(file, po);
		for (let i = 0; i < pending.length; i += batchSize) {
			const chunk = pending.slice(i, i + batchSize);
			const customId = `translation-${requests.length}`;
			const body = {
				...openAIRequestOptions(model),
				messages: [
					{ role: "system", content: createBatchTranslatePrompt(target, rules) },
					{ role: "user", content: JSON.stringify(buildBatchInput(chunk)) },
				],
			};
			// Validate the entire job against the budget before any upload or paid submission.
			session.reserve(body, true);
			requests.push({ custom_id: customId, method: "POST", url: "/v1/chat/completions", body });
			tasks.push({
				customId,
				file: path.relative(path.dirname(path.resolve(jobPath)), file),
				language: target,
				catalogLanguage: po.headers.language ?? po.headers.Language ?? null,
				entries: chunk.map((item) => ({ context: item.ctx, source: item.msgid })),
			});
		}
	}
	if (dryRun || !requests.length)
		return { status: dryRun ? "dry_run" : "completed", total, cached, requests: requests.length };
	const job = {
		schemaVersion: 1,
		status: "preparing",
		model,
		rules,
		createdAt: new Date().toISOString(),
		tasks,
		requests: requests.length,
		applied: [],
		accounted: [],
	};
	fs.mkdirSync(path.dirname(path.resolve(jobPath)), { recursive: true });
	try {
		fs.writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n", { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (error.code === "EEXIST")
			throw new Error(`Job already exists: ${jobPath}. Resume it or choose a new --job path.`);
		throw error;
	}
	const api = clientOrDefault(client);
	const jsonl = requests.map((row) => JSON.stringify(row)).join("\n") + "\n";
	const upload = await api.files.create({
		file: await OpenAI.toFile(Buffer.from(jsonl), "translations.jsonl"),
		purpose: "batch",
	});
	job.inputFileId = upload.id;
	job.status = "submitting";
	writeJsonAtomic(jobPath, job);
	const batch = await api.batches.create({
		input_file_id: upload.id,
		endpoint: "/v1/chat/completions",
		completion_window: "24h",
	});
	job.batchId = batch.id;
	job.status = batch.status;
	writeJsonAtomic(jobPath, job);
	return {
		status: job.status,
		batchId: job.batchId,
		jobPath,
		total,
		cached,
		requests: requests.length,
	};
}

/** Poll once; retrieving/applying a job never creates a new paid request. */
export async function resumeTranslationBatch({
	jobPath,
	client,
	cachePath,
	usageLog,
	onUsage,
	dryRun = false,
}) {
	const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
	if (job.schemaVersion !== 1 || !Array.isArray(job.tasks))
		throw new Error("Unsupported batch job format");
	if (dryRun) return { status: "dry_run", batchId: job.batchId, requests: job.requests };
	if (!job.batchId)
		throw new Error(
			"Job submission was interrupted. Inspect the OpenAI Batch dashboard before removing this job; it will not be submitted twice automatically.",
		);
	if (job.status === "applied")
		return { status: "applied", batchId: job.batchId, applied: job.applied.length };
	const api = clientOrDefault(client);
	const batch = await api.batches.retrieve(job.batchId);
	job.status = batch.status;
	writeJsonAtomic(jobPath, job);
	if (!["completed", "failed", "expired", "cancelled"].includes(batch.status))
		return { status: batch.status, batchId: job.batchId };
	const session = createTranslationSession({ cachePath, usageLog, onUsage });
	const tasks = new Map(job.tasks.map((task) => [task.customId, task]));
	const failures = new Set(),
		seen = new Set(job.applied);
	// Completed lines may exist even when other lines failed or the batch expired.
	for (const fileId of [batch.output_file_id, batch.error_file_id].filter(Boolean)) {
		const response = await api.files.content(fileId);
		for (const line of (await response.text()).split("\n").filter(Boolean)) {
			const row = JSON.parse(line),
				task = tasks.get(row.custom_id);
			if (!task) throw new Error("Unexpected request ID in batch output");
			if (seen.has(task.customId)) continue;
			if (row.error || row.response?.status_code !== 200) {
				failures.add(task.customId);
				continue;
			}
			const body = row.response.body;
			if (!job.accounted.includes(task.customId)) {
				session.record(body, { model: job.model }, { batch: true });
				job.accounted.push(task.customId);
				writeJsonAtomic(jobPath, job);
			}
			let translations;
			try {
				translations = parseBatchTranslationResponse(
					body.choices?.[0]?.message?.content,
					task.entries.map((_, i) => String(i)),
				);
			} catch {
				failures.add(task.customId);
				continue;
			}
			const file = path.resolve(path.dirname(path.resolve(jobPath)), task.file);
			const po = gettextParser.po.parse(fs.readFileSync(file));
			if ((po.headers.language ?? po.headers.Language ?? null) !== task.catalogLanguage) {
				failures.add(task.customId);
				continue;
			}
			const context = {
				provider: "openai",
				model: job.model,
				language: task.language,
				rules: job.rules,
			};
			for (const [i, entry] of task.entries.entries()) {
				const value = translations[String(i)];
				session.put(context, entry.source, value, entry.context);
				const current = po.translations?.[entry.context]?.[entry.source];
				// Extraction/removal or a human translation after submission takes precedence.
				if (current && !current.msgstr?.[0]) {
					if (!Array.isArray(current.msgstr)) current.msgstr = [];
					current.msgstr[0] = value;
				}
			}
			saveCatalog(file, po);
			seen.add(task.customId);
			job.applied.push(task.customId);
			writeJsonAtomic(jobPath, job);
		}
	}
	const missing = job.tasks.filter((task) => !seen.has(task.customId)).length;
	job.status = missing ? "partial" : "applied";
	writeJsonAtomic(jobPath, job);
	return {
		status: job.status,
		batchId: job.batchId,
		applied: job.applied.length,
		failed: failures.size,
		missing,
		usage: session.summary(),
	};
}
