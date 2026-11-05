import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { translatePoFile } from "../src/index.js";

const dirs = [];
function fixture(count = 1) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingui-cost-test-"));
	dirs.push(dir);
	const file = path.join(dir, "fr.po");
	fs.writeFileSync(
		file,
		'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Language: fr\\n"\n\n' +
			Array.from({ length: count }, (_, i) => `msgid "Message ${i}"\nmsgstr ""\n`).join("\n"),
	);
	return { dir, file };
}
function client() {
	return {
		chat: {
			completions: {
				create: vi.fn(async ({ messages }) => ({
					model: "gpt-6-luna",
					usage: { prompt_tokens: 100, completion_tokens: 50 },
					choices: [
						{
							message: {
								content: JSON.stringify(
									Object.fromEntries(
										Object.keys(JSON.parse(messages[1].content)).map((k) => [k, "Texte " + k]),
									),
								),
							},
						},
					],
				})),
			},
		},
	};
}
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe("translation cost safety", () => {
	it("dry-run neither calls the provider nor writes the catalog", async () => {
		const { file } = fixture();
		const before = fs.readFileSync(file, "utf8");
		const api = client();
		await translatePoFile({ filePath: file, client: api, dryRun: true });
		expect(api.chat.completions.create).not.toHaveBeenCalled();
		expect(fs.readFileSync(file, "utf8")).toBe(before);
	});
});

it("keeps completed chunks after a later request fails", async () => {
	const { file } = fixture(3);
	const api = client();
	api.chat.completions.create
		.mockImplementationOnce(async () => ({
			choices: [{ message: { content: '{"0":"Premier","1":"Deuxième"}' } }],
		}))
		.mockRejectedValueOnce(Object.assign(new Error("interrupted"), { status: 400 }));
	await expect(translatePoFile({ filePath: file, client: api, batchSize: 2 })).rejects.toThrow(
		"interrupted",
	);
	expect(fs.readFileSync(file, "utf8")).toContain('msgstr "Premier"');
	const next = client();
	await translatePoFile({ filePath: file, client: next, batchSize: 2 });
	expect(JSON.parse(next.chat.completions.create.mock.calls[0][0].messages[1].content)).toEqual({
		0: "Message 2",
	});
});

it("does not retry exhausted credits", async () => {
	const { file } = fixture();
	const api = client();
	api.chat.completions.create.mockRejectedValue(
		Object.assign(new Error("No credits remaining"), { status: 429, code: "insufficient_quota" }),
	);
	await expect(translatePoFile({ filePath: file, client: api })).rejects.toThrow("No credits");
	expect(api.chat.completions.create).toHaveBeenCalledTimes(1);
});

it("uses cached translations after catalog extraction clears a translation", async () => {
	const { file, dir } = fixture();
	const original = fs.readFileSync(file, "utf8");
	const cachePath = path.join(dir, "cache.json");
	const api = client();
	await translatePoFile({ filePath: file, client: api, cachePath });
	fs.writeFileSync(file, original);
	await translatePoFile({ filePath: file, client: api, cachePath });
	expect(api.chat.completions.create).toHaveBeenCalledTimes(1);
	expect(fs.readFileSync(file, "utf8")).toContain('msgstr "Texte 0"');
});

it("records response token usage and stops before exceeding the request budget", async () => {
	const { file, dir } = fixture(2);
	const api = client();
	const usageLog = path.join(dir, "usage.jsonl");
	await expect(
		translatePoFile({ filePath: file, client: api, batchSize: 1, maxRequests: 1, usageLog }),
	).rejects.toThrow("request budget");
	expect(api.chat.completions.create).toHaveBeenCalledTimes(1);
	const usage = JSON.parse(fs.readFileSync(usageLog, "utf8").trim());
	expect(usage).toMatchObject({
		model: "gpt-6-luna",
		inputTokens: 100,
		outputTokens: 50,
		estimatedCostUsd: 0.000035,
	});
	expect(fs.readFileSync(usageLog, "utf8")).not.toContain("Message 0");
});

it("enforces the cost ceiling before starting a request", async () => {
	const { file } = fixture();
	const api = client();
	await expect(translatePoFile({ filePath: file, client: api, maxCostUsd: 0 })).rejects.toThrow(
		"cost budget",
	);
	expect(api.chat.completions.create).not.toHaveBeenCalled();
});

it("uses valid Luna parameters and preserves quotation marks on disk", async () => {
	const { file } = fixture();
	const api = client();
	api.chat.completions.create.mockResolvedValue({
		choices: [{ message: { content: JSON.stringify({ 0: 'Dis "salut"' }) } }],
	});
	await translatePoFile({ filePath: file, client: api });
	const body = api.chat.completions.create.mock.calls[0][0];
	expect(body).toMatchObject({
		model: "gpt-6-luna",
		max_completion_tokens: 8192,
		reasoning_effort: "none",
		response_format: { type: "json_object" },
	});
	expect(body).not.toHaveProperty("max_tokens");
	const gettext = await import("gettext-parser");
	expect(
		gettext.default.po.parse(fs.readFileSync(file)).translations[""]["Message 0"].msgstr[0],
	).toBe('Dis "salut"');
});

it("batches and deduplicates JSON localization strings through the shared cache", async () => {
	const { dir } = fixture();
	const { translateStrings } = await import("../src/index.js");
	const api = client(),
		cachePath = path.join(dir, "strings-cache.json");
	const first = await translateStrings({
		strings: ["Hello", "Hello", "Bye"],
		language: "fr",
		client: api,
		cachePath,
	});
	expect(first.translations).toEqual(["Texte 0", "Texte 0", "Texte 1"]);
	const next = await translateStrings({
		strings: ["Bye", "Hello"],
		language: "fr",
		client: api,
		cachePath,
	});
	expect(next.translations).toEqual(["Texte 1", "Texte 0"]);
	expect(api.chat.completions.create).toHaveBeenCalledTimes(1);
	await translateStrings({
		strings: ["Hello"],
		language: "fr",
		rules: "New tone",
		client: api,
		cachePath,
	});
	expect(api.chat.completions.create).toHaveBeenCalledTimes(2);
});

it("preserves paid results when usage logging or its callback fails", async () => {
	const { file, dir } = fixture();
	const api = client();
	await translatePoFile({
		filePath: file,
		client: api,
		usageLog: dir,
		onUsage: () => {
			throw new Error("Broken observer");
		},
	});
	expect(fs.readFileSync(file, "utf8")).toContain('msgstr "Texte 0"');
	expect(api.chat.completions.create).toHaveBeenCalledTimes(1);
});

it("keeps translations of the same source in separate PO contexts", async () => {
	const { file, dir } = fixture();
	const original =
		'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgctxt "verb"\nmsgid "Open"\nmsgstr ""\n\nmsgctxt "adjective"\nmsgid "Open"\nmsgstr ""\n';
	fs.writeFileSync(file, original);
	const api = client();
	api.chat.completions.create.mockResolvedValue({
		choices: [{ message: { content: '{"0":"Ouvrir","1":"Ouvert"}' } }],
	});
	const cachePath = path.join(dir, "cache.json");
	await translatePoFile({ filePath: file, client: api, cachePath });
	fs.writeFileSync(file, original);
	await translatePoFile({ filePath: file, client: api, cachePath });
	const gettext = (await import("gettext-parser")).default;
	const po = gettext.po.parse(fs.readFileSync(file));
	expect(po.translations.verb.Open.msgstr[0]).toBe("Ouvrir");
	expect(po.translations.adjective.Open.msgstr[0]).toBe("Ouvert");
	expect(api.chat.completions.create).toHaveBeenCalledTimes(1);
});

it("resolves the provider-specific default for generic string translation", async () => {
	const { translateStrings } = await import("../src/index.js");
	const api = {
		messages: {
			create: vi.fn(async () => ({ content: [{ type: "text", text: '{"0":"Bonjour"}' }] })),
		},
	};
	await translateStrings({
		strings: ["Hello"],
		language: "fr",
		provider: "anthropic",
		client: api,
	});
	expect(api.messages.create.mock.calls[0][0].model).toBe("claude-3-5-haiku-20241022");
});

it("checkpoints successful translations even if the cache cannot be written", async () => {
	const { file, dir } = fixture();
	const parent = path.join(dir, "not-a-directory");
	fs.writeFileSync(parent, "existing file");
	const api = client();
	await translatePoFile({
		filePath: file,
		client: api,
		cachePath: path.join(parent, "cache.json"),
	});
	expect(fs.readFileSync(file, "utf8")).toContain('msgstr "Texte 0"');
	expect(api.chat.completions.create).toHaveBeenCalledTimes(1);
});
