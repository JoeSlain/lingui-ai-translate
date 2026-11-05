import fs from "fs";
import { createTranslationSession } from "./runtime.js";
import path from "path";
import fg from "fast-glob";
import gettextParser from "gettext-parser";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-20241022";
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 2000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_BATCH_MAX_TOKENS = 8192;
const DEFAULT_BATCH_JSON_RETRIES = 1;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHttpStatus(err) {
	if (typeof err?.status === "number") return err.status;
	if (typeof err?.response?.status === "number") return err.response.status;
	const match = String(err?.message ?? "").match(/\b(429|500|502|503|504)\b/);
	return match ? Number(match[1]) : null;
}

function isRetryableError(err) {
	if (
		err?.code === "insufficient_quota" ||
		/no credits|quota|billing|credit balance/i.test(String(err?.message ?? ""))
	)
		return false;
	const status = getHttpStatus(err);
	return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function getRetryAfterMs(err) {
	const retryAfter = err?.headers?.["retry-after"] ?? err?.response?.headers?.["retry-after"];
	if (retryAfter == null) return null;
	const seconds = Number.parseInt(String(retryAfter), 10);
	return Number.isFinite(seconds) ? seconds * 1000 : null;
}

async function withRetry(
	fn,
	{ maxRetries = DEFAULT_MAX_RETRIES, baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS } = {},
) {
	let lastError;
	for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			if (!isRetryableError(err) || attempt === maxRetries) throw err;
			const retryAfterMs = getRetryAfterMs(err);
			const delayMs = retryAfterMs ?? baseDelayMs * 2 ** attempt;
			await sleep(delayMs);
		}
	}
	throw lastError;
}

function providerModel(provider, model) {
	return (
		model ||
		({
			openai: DEFAULT_OPENAI_MODEL,
			anthropic: DEFAULT_ANTHROPIC_MODEL,
			gemini: DEFAULT_GEMINI_MODEL,
		}[provider] ??
			DEFAULT_OPENAI_MODEL)
	);
}
function checkpointCatalog(file, po) {
	const checkpoint = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(checkpoint, gettextParser.po.compile(po));
		fs.renameSync(checkpoint, file);
	} finally {
		if (fs.existsSync(checkpoint)) fs.unlinkSync(checkpoint);
	}
}

export function openAIRequestOptions(
	model = DEFAULT_OPENAI_MODEL,
	maxTokens = DEFAULT_BATCH_MAX_TOKENS,
) {
	return {
		model,
		...(/^(gpt-([5-9]|\d{2,})|o[0-9])/i.test(model)
			? { max_completion_tokens: maxTokens, reasoning_effort: "none" }
			: { max_tokens: maxTokens }),
		response_format: { type: "json_object" },
	};
}

function getOpenAIClient() {
	return new OpenAI({
		apiKey: process.env.LINGUI_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
		maxRetries: 0,
	});
}

function getAnthropicClient() {
	return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function getGeminiClient() {
	return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function getClient(provider) {
	if (provider === "anthropic") return getAnthropicClient();
	if (provider === "gemini") return getGeminiClient();
	return getOpenAIClient();
}

function extractLanguageFromHeaders(headers) {
	if (!headers) return null;
	const keys = Object.keys(headers);
	for (const k of keys) {
		if (k.toLowerCase() === "language") {
			const value = headers[k];
			if (typeof value === "string" && value.trim()) {
				return value.trim();
			}
		}
	}
	return null;
}

export function createBatchTranslatePrompt(targetLang, rules) {
	let prompt = `Translate into ${targetLang}. You will receive a JSON object where each key is an id and each value is a source string to translate.
Return ONLY a valid JSON object with the exact same keys and translated string values.
Do not translate text inside curly braces or ICU placeholders. Example: "Hello {name}" must keep {name} unchanged.
Maintain surrounding punctuation. Keep translations short and concise while preserving the full meaning.
Do not wrap the JSON in markdown code fences.`;

	if (rules && rules.trim()) {
		prompt += `\n\nAdditional translation rules:\n${rules.trim()}`;
	}

	return prompt;
}

function chunkArray(items, size) {
	const chunks = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

export function buildBatchInput(items) {
	const input = {};
	for (let i = 0; i < items.length; i += 1) {
		input[String(i)] = items[i].msgid;
	}
	return input;
}

export function parseBatchTranslationResponse(raw, expectedKeys) {
	let text = String(raw ?? "").trim();
	const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fenceMatch) text = fenceMatch[1].trim();

	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		const baseMsg = err?.message || String(err);
		throw new Error(`Invalid JSON in batch translation response: ${baseMsg}`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Batch translation response must be a JSON object");
	}

	const result = {};
	for (const key of expectedKeys) {
		if (!(key in parsed)) {
			throw new Error(`Missing translation for key "${key}" in batch response`);
		}
		const value = parsed[key];
		if (typeof value !== "string" || !value.trim()) {
			throw new Error(`Translation for key "${key}" must be a string`);
		}
		result[key] = value;
	}
	return result;
}

async function callModel({
	client,
	systemPrompt,
	userContent,
	model,
	provider = "openai",
	maxTokens = DEFAULT_BATCH_MAX_TOKENS,
	session,
}) {
	if (provider === "anthropic") {
		const res = await withRetry(() =>
			session.request(
				{
					provider,
					model: model || DEFAULT_ANTHROPIC_MODEL,
					max_tokens: maxTokens,
					messages: [{ content: systemPrompt }, { content: userContent }],
				},
				() =>
					client.messages.create({
						model: model || DEFAULT_ANTHROPIC_MODEL,
						max_tokens: maxTokens,
						system: systemPrompt,
						messages: [{ role: "user", content: userContent }],
					}),
			),
		);
		const block = res.content?.find((b) => b.type === "text");
		return (block?.text ?? "").trim();
	}

	if (provider === "gemini") {
		const res = await withRetry(() =>
			session.request(
				{
					provider,
					model: model || DEFAULT_GEMINI_MODEL,
					max_tokens: maxTokens,
					messages: [{ content: systemPrompt }, { content: userContent }],
				},
				() =>
					client.models.generateContent({
						model: model || DEFAULT_GEMINI_MODEL,
						contents: userContent,
						config: { systemInstruction: systemPrompt },
					}),
			),
		);
		return (res.text ?? "").trim();
	}

	const body = {
		...openAIRequestOptions(model || DEFAULT_OPENAI_MODEL, maxTokens),
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userContent },
		],
	};
	const res = await withRetry(() =>
		session.request(body, () => client.chat.completions.create(body)),
	);

	return (res.choices?.[0]?.message?.content ?? "").trim();
}

async function translateBatchChunk({ client, items, language, model, rules, provider, session }) {
	const input = buildBatchInput(items);
	const expectedKeys = Object.keys(input);
	const systemPrompt = createBatchTranslatePrompt(language, rules);
	const userContent = JSON.stringify(input);
	let lastError;

	for (let attempt = 0; attempt <= DEFAULT_BATCH_JSON_RETRIES; attempt += 1) {
		try {
			const raw = await callModel({
				client,
				systemPrompt,
				userContent,
				model,
				provider,
				session,
			});
			return parseBatchTranslationResponse(raw, expectedKeys);
		} catch (err) {
			lastError = err;
			if (attempt === DEFAULT_BATCH_JSON_RETRIES || !isBatchParseError(err)) {
				throw err;
			}
		}
	}

	throw lastError;
}

function isBatchParseError(err) {
	const msg = String(err?.message ?? "");
	return (
		msg.includes("Invalid JSON in batch translation response") ||
		msg.includes("Batch translation response must be a JSON object") ||
		msg.includes('Missing translation for key "') ||
		msg.includes('Translation for key "')
	);
}

export function listUntranslatedEntries(poJson) {
	const items = [];
	const translations = poJson.translations || {};
	for (const ctx of Object.keys(translations)) {
		const byId = translations[ctx];
		for (const msgid of Object.keys(byId)) {
			if (!msgid) continue;
			const entry = byId[msgid];
			if (!entry || entry.msgid !== msgid) continue;
			const firstStr = Array.isArray(entry.msgstr) ? entry.msgstr[0] : "";
			if (!firstStr) {
				items.push({ ctx, msgid, entry });
			}
		}
	}
	return items;
}

function setTranslation(entry, text) {
	if (!Array.isArray(entry.msgstr)) entry.msgstr = [""];
	entry.msgstr[0] = text;
}

export async function translatePoFile({
	filePath,
	language,
	model,
	dryRun = false,
	client,
	onProgress,
	rules,
	provider = "openai",
	batchSize = DEFAULT_BATCH_SIZE,
	cachePath,
	usageLog,
	onUsage,
	maxRequests,
	maxCostUsd,
	session = createTranslationSession({ cachePath, usageLog, onUsage, maxRequests, maxCostUsd }),
}) {
	const abs = path.resolve(filePath);
	const raw = fs.readFileSync(abs);
	let po;
	try {
		po = gettextParser.po.parse(raw);
	} catch (err) {
		const baseMsg = err?.message || String(err);
		throw new Error(
			`Error parsing PO data in ${abs}: ${baseMsg}. This can be caused by an unescaped quote character in a msgid or msgstr value.`,
		);
	}

	const headerLang = extractLanguageFromHeaders(po.headers);
	const targetLang = language || headerLang;
	if (!targetLang) {
		throw new Error(
			`Could not determine language for ${filePath}. Provide --language or set Language header in .po`,
		);
	}

	const items = listUntranslatedEntries(po);
	const total = items.length;

	if (onProgress) onProgress({ type: "start", filePath: abs, total });

	if (!Number.isSafeInteger(batchSize) || batchSize < 1)
		throw new Error("batchSize must be a positive integer");
	if (dryRun || total === 0) {
		if (onProgress) onProgress({ type: "done", filePath: abs, processed: 0, total, dryRun });
		return { filePath: abs, processed: 0, total, dryRun };
	}
	const context = {
		provider,
		model:
			model ||
			(provider === "anthropic"
				? DEFAULT_ANTHROPIC_MODEL
				: provider === "gemini"
					? DEFAULT_GEMINI_MODEL
					: DEFAULT_OPENAI_MODEL),
		language: targetLang,
		rules,
	};
	let processed = 0;
	const pending = items.filter((item) => {
		const cached = session.get(context, item.msgid, item.ctx);
		if (cached === undefined) return true;
		setTranslation(item.entry, cached);
		processed++;
		return false;
	});
	const apiClient = pending.length ? client || getClient(provider) : null;
	const chunks = chunkArray(pending, batchSize);
	for (const chunk of chunks) {
		const translations = await translateBatchChunk({
			client: apiClient,
			items: chunk,
			language: targetLang,
			model,
			rules,
			provider,
			session,
		});

		const processedBeforeChunk = processed;
		for (let i = 0; i < chunk.length; i += 1) {
			setTranslation(chunk[i].entry, translations[String(i)]);
			session.put(context, chunk[i].msgid, translations[String(i)], chunk[i].ctx);
			processed += 1;
		}
		checkpointCatalog(abs, po);
		for (let i = 0; i < chunk.length; i += 1) {
			if (onProgress)
				onProgress({
					type: "progress",
					filePath: abs,
					processed: processedBeforeChunk + i + 1,
					total,
				});
		}
	}
	if (chunks.length === 0 && processed > 0) checkpointCatalog(abs, po);

	if (onProgress)
		onProgress({
			type: "done",
			filePath: abs,
			processed,
			total,
			dryRun: false,
		});
	return { filePath: abs, processed, dryRun: false, usage: session.summary() };
}

async function withConcurrency(limit, items, worker) {
	const results = Array.from({ length: items.length });
	let next = 0,
		firstError;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (!firstError && next < items.length) {
				const index = next++;
				try {
					results[index] = await worker(items[index], index);
				} catch (error) {
					firstError ??= error;
				}
			}
		}),
	);
	if (firstError) throw firstError;
	return results;
}

export async function translatePoDirectory({
	directoryPath,
	include = "**/*.po",
	defaultLanguage,
	defaultModel,
	defaultProvider = "openai",
	dryRun = false,
	concurrency = 2,
	batchSize = DEFAULT_BATCH_SIZE,
	cachePath,
	usageLog,
	onUsage,
	maxRequests,
	maxCostUsd,
	session = createTranslationSession({ cachePath, usageLog, onUsage, maxRequests, maxCostUsd }),
	client,
	onProgress,
	rules,
}) {
	if (!Number.isSafeInteger(concurrency) || concurrency < 1)
		throw new Error("concurrency must be a positive integer");
	const absDir = path.resolve(directoryPath);
	const files = await fg(include, { cwd: absDir, absolute: true });

	if (files.length === 0) {
		console.log(`No .po files found in ${absDir} matching ${include}`);
		return [];
	}

	const results = await withConcurrency(concurrency, files, async (filePath) => {
		const raw = fs.readFileSync(filePath);
		let po;
		try {
			po = gettextParser.po.parse(raw);
		} catch (err) {
			const baseMsg = err?.message || String(err);
			throw new Error(
				`Error parsing PO data in ${filePath}: ${baseMsg}. This can be caused by an unescaped quote character in a msgid or msgstr value.`,
			);
		}
		const headerLang = extractLanguageFromHeaders(po.headers);
		const language = headerLang || defaultLanguage;
		if (!language) {
			console.warn(
				`Skipping ${filePath}: could not determine language (no header and no --language)`,
			);
			return { filePath, processed: 0, skipped: true };
		}
		return await translatePoFile({
			filePath,
			language,
			batchSize,
			session,
			model: defaultModel,
			dryRun,
			client,
			onProgress,
			rules,
			provider: defaultProvider,
		});
	});

	return results;
}

export default {
	translatePoFile,
	translatePoDirectory,
	buildBatchInput,
	parseBatchTranslationResponse,
};

export { submitTranslationBatch, resumeTranslationBatch } from "./batch.js";

/** Translate JSON/localization strings with the same batching, cache and accounting as PO files. */
export async function translateStrings({
	strings,
	language,
	model,
	provider = "openai",
	rules,
	batchSize = DEFAULT_BATCH_SIZE,
	dryRun = false,
	client,
	cachePath,
	usageLog,
	onUsage,
	maxRequests,
	maxCostUsd,
	session = createTranslationSession({ cachePath, usageLog, onUsage, maxRequests, maxCostUsd }),
}) {
	if (!Array.isArray(strings) || strings.some((s) => typeof s !== "string" || !s.trim()))
		throw new Error("strings must contain non-empty strings");
	if (!language) throw new Error("language is required");
	if (!Number.isSafeInteger(batchSize) || batchSize < 1)
		throw new Error("batchSize must be a positive integer");
	model = providerModel(provider, model);
	const context = { provider, model, language, rules };
	const translations = strings.map((source) => session.get(context, source));
	if (dryRun)
		return {
			translations,
			planned: translations.filter((s) => s === undefined).length,
			dryRun: true,
			usage: session.summary(),
		};
	const missing = [...new Set(strings.filter((_, i) => translations[i] === undefined))];
	const api = missing.length ? client || getClient(provider) : null;
	const translated = new Map();
	for (const chunk of chunkArray(missing, batchSize)) {
		const values = await translateBatchChunk({
			client: api,
			items: chunk.map((msgid) => ({ msgid })),
			language,
			model,
			rules,
			provider,
			session,
		});
		for (const [i, source] of chunk.entries()) {
			translated.set(source, values[String(i)]);
			session.put(context, source, values[String(i)]);
		}
	}
	return {
		translations: strings.map((source, i) => translations[i] ?? translated.get(source)),
		usage: session.summary(),
	};
}
export { createTranslationSession } from "./runtime.js";
