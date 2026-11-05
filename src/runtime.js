import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const RATES = {
	"gpt-6-luna": [0.1, 0.01, 0.5],
	"gpt-4o-mini": [0.15, 0.075, 0.6],
};
export function estimateCost(model, input, output, cached = 0, batch = false) {
	const family = Object.keys(RATES).find(
		(k) => model === k || new RegExp(`^${k}-\\d{4}-\\d{2}-\\d{2}$`).test(model),
	);
	if (
		!family ||
		![input, output, cached].every((n) => Number.isSafeInteger(n) && n >= 0) ||
		cached > input
	)
		return null;
	const [i, c, o] = RATES[family];
	const longContext = family === "gpt-6-luna" && input > 272000;
	return (
		((((input - cached) * i + cached * c) * (longContext ? 2 : 1) +
			output * o * (longContext ? 1.5 : 1)) /
			1e6) *
		(batch ? 0.5 : 1)
	);
}
export function writeJsonAtomic(file, value) {
	fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	const tmp = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, file);
	} finally {
		if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
	}
}

export function createTranslationSession({
	cachePath,
	usageLog,
	onUsage,
	maxRequests = Infinity,
	maxCostUsd = Infinity,
} = {}) {
	if (!(maxRequests === Infinity || (Number.isSafeInteger(maxRequests) && maxRequests >= 0)))
		throw new Error("maxRequests must be a non-negative integer");
	if (!(maxCostUsd >= 0) || Number.isNaN(maxCostUsd))
		throw new Error("maxCostUsd must be non-negative");
	let cache = {};
	if (cachePath && fs.existsSync(cachePath)) {
		const saved = JSON.parse(fs.readFileSync(cachePath, "utf8"));
		if (
			saved.schemaVersion !== 1 ||
			!saved.translations ||
			typeof saved.translations !== "object" ||
			Array.isArray(saved.translations)
		)
			throw new Error("Unsupported translation cache format");
		cache = saved.translations;
	}
	const runId = randomUUID();
	let requests = 0,
		reservedUsd = 0,
		knownCostUsd = 0,
		missingUsage = 0,
		cachedTranslations = 0;
	const key = (context, source, messageContext = "") =>
		createHash("sha256")
			.update(
				JSON.stringify([
					1,
					context.provider,
					context.model,
					context.language,
					context.rules || "",
					messageContext,
					source,
				]),
			)
			.digest("hex");
	function reserve(body, batch = false) {
		if (requests >= maxRequests)
			throw new Error(`Translation request budget exceeded (${maxRequests})`);
		// UTF-8 bytes upper-bound text tokens, plus protocol overhead; reserve the full output limit.
		const bound = estimateCost(
			body.model,
			Buffer.byteLength(JSON.stringify(body.messages), "utf8") + 1024,
			body.max_completion_tokens ?? body.max_tokens ?? 8192,
			0,
			batch,
		);
		if (maxCostUsd !== Infinity && bound === null)
			throw new Error(`No price configured for ${body.model}; cannot enforce maxCostUsd`);
		if (bound !== null && reservedUsd + bound > maxCostUsd)
			throw new Error(`Translation cost budget exceeded ($${maxCostUsd})`);
		requests++;
		reservedUsd += bound ?? 0;
		return bound;
	}
	function record(response, body, { batch = false, reservation = 0, error } = {}) {
		const usage = response?.usage;
		const input =
			usage?.prompt_tokens ?? usage?.input_tokens ?? response?.usageMetadata?.promptTokenCount;
		const output =
			usage?.completion_tokens ??
			usage?.output_tokens ??
			response?.usageMetadata?.candidatesTokenCount;
		const cached =
			usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? 0;
		const model = response?.model || body.model;
		const cost = !error ? estimateCost(model, input, output, cached, batch) : null;
		const estimatedCostUsd =
			response?.service_tier && !["default", "auto", "batch"].includes(response.service_tier)
				? null
				: cost;
		if (estimatedCostUsd === null) missingUsage++;
		else {
			knownCostUsd += estimatedCostUsd;
			reservedUsd += estimatedCostUsd - (reservation ?? 0);
		}
		const event = {
			event: "translation_usage",
			schemaVersion: 1,
			runId,
			timestamp: new Date().toISOString(),
			provider: body.provider || "openai",
			model,
			mode: batch ? "batch" : "sync",
			outcome: error ? "error" : "response",
			inputTokens: input ?? null,
			cachedInputTokens: input === undefined ? null : cached,
			outputTokens: output ?? null,
			estimatedCostUsd,
			currency: "USD",
			pricingVersion: "2026-11-05",
			httpStatus: error?.status ?? null,
		};
		// Usage logs contain counters only: no source text, translations, credentials or raw errors.
		try {
			if (usageLog) {
				fs.mkdirSync(path.dirname(path.resolve(usageLog)), { recursive: true });
				fs.appendFileSync(usageLog, JSON.stringify(event) + "\n", { mode: 0o600 });
			}
		} catch {
			console.warn(
				"[translation][usage] Could not write usage log; successful translations will still be saved.",
			);
		}
		try {
			onUsage?.(event);
		} catch {
			console.warn(
				"[translation][usage] Observer failed; successful translations will still be saved.",
			);
		}

		return event;
	}
	return {
		reserve,
		record,
		async request(body, work) {
			const reservation = reserve(body);
			let response;
			try {
				response = await work();
			} catch (error) {
				record(null, body, { reservation, error });
				throw error;
			}
			record(response, body, { reservation });
			return response;
		},
		get(context, source, messageContext = "") {
			const value = cache[key(context, source, messageContext)];
			if (typeof value === "string" && value.trim()) {
				cachedTranslations++;
				return value;
			}
			return undefined;
		},
		put(context, source, text, messageContext = "") {
			cache[key(context, source, messageContext)] = text;
			if (cachePath) {
				try {
					writeJsonAtomic(cachePath, { schemaVersion: 1, translations: cache });
				} catch {
					console.warn(
						"[translation][cache] Could not persist cache; successful translations will still be saved.",
					);
				}
			}
		},
		summary() {
			return {
				requests,
				cachedTranslations,
				estimatedKnownCostUsd: knownCostUsd,
				missingUsage,
				pricingComplete: missingUsage === 0,
				currency: "USD",
			};
		},
	};
}
