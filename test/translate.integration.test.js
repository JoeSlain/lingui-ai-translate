/**
 * Integration tests that call real LLM APIs.
 * Each describe block runs only when the corresponding API key is set.
 * Run with: npm run test:integration
 * Or set env vars and run: npm test (runs unit + integration).
 */

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { translatePoFile } from "../src/index.js";

function makeTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lingui-ai-int-"));
}

function writePo(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function read(filePath) {
	return fs.readFileSync(filePath, "utf8");
}

// One short string to translate: "Hello" -> target language
const SIMPLE_PO = (lang) =>
	[
		'msgid ""',
		'msgstr ""',
		`"Language: ${lang}\n"`,
		"",
		'msgid "Hello"',
		'msgstr ""',
	].join("\n");

function expectTranslated(poContent, msgid = "Hello") {
	// Find msgstr that follows msgid "Hello" (not the header)
	const re = new RegExp(
		`msgid "${msgid.replace(/"/g, '\\"')}"\\s*\\nmsgstr "([^"]*)"`,
		"m",
	);
	const match = poContent.match(re);
	expect(match).toBeTruthy();
	const msgstr = (match[1] || "").replace(/\\"/g, '"');
	expect(msgstr.length).toBeGreaterThan(0);
	expect(msgstr).not.toBe(msgid);
}

describe.runIf(process.env.OPENAI_API_KEY)("integration: OpenAI", () => {
	let dir;
	beforeAll(() => {
		dir = makeTempDir();
	});

	it("translates a .po file using real OpenAI API", async () => {
		const file = path.join(dir, "fr.po");
		writePo(file, SIMPLE_PO("fr"));

		await translatePoFile({
			filePath: file,
			language: "fr",
			provider: "openai",
			onProgress: () => {},
		});

		const content = read(file);
		expectTranslated(content);
	}, 30_000);

	it("translates with custom model when OPENAI_API_KEY is set", async () => {
		const file = path.join(dir, "de.po");
		writePo(file, SIMPLE_PO("de"));

		await translatePoFile({
			filePath: file,
			language: "de",
			provider: "openai",
			model: "gpt-4o-mini",
			onProgress: () => {},
		});

		expectTranslated(read(file));
	}, 30_000);
});

describe.runIf(process.env.ANTHROPIC_API_KEY)("integration: Anthropic", () => {
	let dir;
	beforeAll(() => {
		dir = makeTempDir();
	});

	it("translates a .po file using real Anthropic API", async () => {
		const file = path.join(dir, "fr.po");
		writePo(file, SIMPLE_PO("fr"));

		await translatePoFile({
			filePath: file,
			language: "fr",
			provider: "anthropic",
			onProgress: () => {},
		});

		expectTranslated(read(file));
	}, 30_000);
});

describe.runIf(process.env.GEMINI_API_KEY)("integration: Gemini", () => {
	let dir;
	beforeAll(() => {
		dir = makeTempDir();
	});

	it("translates a .po file using real Gemini API", async () => {
		const file = path.join(dir, "fr.po");
		writePo(file, SIMPLE_PO("fr"));

		await translatePoFile({
			filePath: file,
			language: "fr",
			provider: "gemini",
			onProgress: () => {},
		});

		expectTranslated(read(file));
	}, 30_000);
});
