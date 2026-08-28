import fs from "fs";
import path from "path";
import fg from "fast-glob";
import gettextParser from "gettext-parser";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-20241022";
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 2000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_BATCH_MAX_TOKENS = 8192;
const DEFAULT_BATCH_JSON_RETRIES = 2;

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
	const status = getHttpStatus(err);
	return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function getRetryAfterMs(err) {
	const retryAfter =
		err?.headers?.["retry-after"] ?? err?.response?.headers?.["retry-after"];
	if (retryAfter == null) return null;
	const seconds = Number.parseInt(String(retryAfter), 10);
	return Number.isFinite(seconds) ? seconds * 1000 : null;
}

async function withRetry(fn, { maxRetries = DEFAULT_MAX_RETRIES, baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS } = {}) {
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

function getOpenAIClient() {
	return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

function createBatchTranslatePrompt(targetLang, rules) {
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
		if (typeof value !== "string") {
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
}) {
	if (provider === "anthropic") {
		const res = await withRetry(() =>
			client.messages.create({
				model: model || DEFAULT_ANTHROPIC_MODEL,
				max_tokens: maxTokens,
				system: systemPrompt,
				messages: [{ role: "user", content: userContent }],
			}),
		);
		const block = res.content?.find((b) => b.type === "text");
		return (block?.text ?? "").trim();
	}

	if (provider === "gemini") {
		const res = await withRetry(() =>
			client.models.generateContent({
				model: model || DEFAULT_GEMINI_MODEL,
				contents: userContent,
				config: { systemInstruction: systemPrompt },
			}),
		);
		return (res.text ?? "").trim();
	}

	const res = await withRetry(() =>
		client.chat.completions.create({
			model: model || DEFAULT_OPENAI_MODEL,
			max_tokens: maxTokens,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userContent },
			],
		}),
	);
	return (res.choices?.[0]?.message?.content ?? "").trim();
}

async function translateBatchChunk({
	client,
	items,
	language,
	model,
	rules,
	provider,
}) {
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

function listUntranslatedEntries(poJson) {
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
	entry.msgstr[0] = text.replace(/"/g, '\\"');
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

	const apiClient = client || getClient(provider);

	let processed = 0;
	const chunks = chunkArray(items, batchSize);
	for (const chunk of chunks) {
		const translations = await translateBatchChunk({
			client: apiClient,
			items: chunk,
			language: targetLang,
			model,
			rules,
			provider,
		});

		for (let i = 0; i < chunk.length; i += 1) {
			setTranslation(chunk[i].entry, translations[String(i)]);
			processed += 1;
			if (onProgress)
				onProgress({ type: "progress", filePath: abs, processed, total });
		}
	}

	if (dryRun) {
		if (onProgress)
			onProgress({
				type: "done",
				filePath: abs,
				processed,
				total,
				dryRun: true,
			});
		console.log(`[dry-run] ${filePath}: would write ${processed} translations`);
		return { filePath: abs, processed, dryRun: true };
	}

	const out = gettextParser.po.compile(po);
	fs.writeFileSync(abs, out);
	if (onProgress)
		onProgress({
			type: "done",
			filePath: abs,
			processed,
			total,
			dryRun: false,
		});
	return { filePath: abs, processed, dryRun: false };
}

async function withConcurrency(limit, items, worker) {
	const queue = [...items];
	let active = 0;
	let index = 0;
	const results = [];
	return await new Promise((resolve, reject) => {
		const next = () => {
			if (queue.length === 0 && active === 0) {
				resolve(Promise.all(results));
				return;
			}
			while (active < limit && queue.length > 0) {
				const i = index++;
				const item = queue.shift();
				active += 1;
				Promise.resolve()
					.then(() => worker(item, i))
					.then((r) => {
						active -= 1;
						results.push(r);
						next();
					})
					.catch((err) => {
						active -= 1;
						reject(err);
					});
			}
		};
		next();
	});
}

export async function translatePoDirectory({
	directoryPath,
	include = "**/*.po",
	defaultLanguage,
	defaultModel,
	defaultProvider = "openai",
	dryRun = false,
	concurrency = 2,
	client,
	onProgress,
	rules,
}) {
	const absDir = path.resolve(directoryPath);
	const files = await fg(include, { cwd: absDir, absolute: true });

	if (files.length === 0) {
		console.log(`No .po files found in ${absDir} matching ${include}`);
		return [];
	}

	const results = await withConcurrency(
		concurrency,
		files,
		async (filePath) => {
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
				model: defaultModel,
				dryRun,
				client,
				onProgress,
				rules,
				provider: defaultProvider,
			});
		},
	);

	return results;
}

export default {
	translatePoFile,
	translatePoDirectory,
	buildBatchInput,
	parseBatchTranslationResponse,
};
