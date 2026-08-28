import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { translatePoFile, translatePoDirectory } from "../src/index.js";
import {
	createOpenAIBatchClient,
	createAnthropicBatchClient,
	createGeminiBatchClient,
} from "./helpers.js";

function makeTempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingui-ai-"));
	return dir;
}

function writePo(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function read(filePath) {
	return fs.readFileSync(filePath, "utf8");
}

describe("translatePoFile", () => {
	let mockClient;
	beforeEach(() => {
		mockClient = createOpenAIBatchClient();
	});

	it("translates a single msgid into msgstr", async () => {
		const dir = makeTempDir();
		const file = path.join(dir, "fr.po");
		writePo(
			file,
			'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgid "Hello {name}!"\nmsgstr ""\n',
		);

		const progress = [];
		await translatePoFile({
			filePath: file,
			client: mockClient,
			onProgress: (e) => progress.push(e),
		});

		const out = read(file);
		expect(out).toMatch(/msgstr "\[T\] Hello \{name\}!"/);
		expect(progress[0].type).toBe("start");
		expect(progress.at(-1).type).toBe("done");
	});

	it("translates multiple msgids in a single API call", async () => {
		const dir = makeTempDir();
		const file = path.join(dir, "fr.po");
		writePo(
			file,
			[
				'msgid ""',
				'msgstr ""',
				'"Language: fr\\n"',
				"",
				'msgid "Hello"',
				'msgstr ""',
				"",
				'msgid "Goodbye"',
				'msgstr ""',
				"",
				'msgid "See you {name}"',
				'msgstr ""',
			].join("\n"),
		);

		await translatePoFile({
			filePath: file,
			client: mockClient,
			onProgress: () => {},
		});

		expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(1);
		const call = mockClient.chat.completions.create.mock.calls[0][0];
		const payload = JSON.parse(
			call.messages.find((m) => m.role === "user").content,
		);
		expect(payload).toEqual({
			"0": "Hello",
			"1": "Goodbye",
			"2": "See you {name}",
		});

		const out = read(file);
		expect(out).toMatch(/msgid "Hello"\nmsgstr "\[T\] Hello"/);
		expect(out).toMatch(/msgid "Goodbye"\nmsgstr "\[T\] Goodbye"/);
		expect(out).toMatch(/msgstr "\[T\] See you \{name\}"/);
	});

	it("chunks large files into multiple API calls", async () => {
		const dir = makeTempDir();
		const file = path.join(dir, "fr.po");
		const entries = ['msgid ""', 'msgstr ""', '"Language: fr\\n"', ""];
		for (let i = 0; i < 3; i += 1) {
			entries.push(`msgid "String ${i}"`, 'msgstr ""', "");
		}
		writePo(file, entries.join("\n"));

		await translatePoFile({
			filePath: file,
			client: mockClient,
			batchSize: 2,
			onProgress: () => {},
		});

		expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(2);
		expect(read(file)).toMatch(/msgstr "\[T\] String 0"/);
		expect(read(file)).toMatch(/msgstr "\[T\] String 2"/);
	});

	it("retries when the model returns invalid JSON", async () => {
		let calls = 0;
		const create = vi.fn(async ({ messages }) => {
			calls += 1;
			if (calls === 1) {
				return { choices: [{ message: { content: "not json" } }] };
			}
			const user = messages.find((m) => m.role === "user");
			return {
				choices: [{ message: { content: JSON.stringify({ "0": "[T] Hi" }) } }],
			};
		});
		const client = { chat: { completions: { create } } };

		const dir = makeTempDir();
		const file = path.join(dir, "fr.po");
		writePo(
			file,
			'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgid "Hi"\nmsgstr ""\n',
		);

		await translatePoFile({
			filePath: file,
			client,
			onProgress: () => {},
		});

		expect(create).toHaveBeenCalledTimes(2);
		expect(read(file)).toMatch(/msgstr "\[T\] Hi"/);
	});
});

describe("translatePoDirectory", () => {
	let mockClient;
	beforeEach(() => {
		mockClient = createOpenAIBatchClient();
	});

	it("walks a directory and translates files by header language", async () => {
		const dir = makeTempDir();
		const f1 = path.join(dir, "fr", "messages.po");
		const f2 = path.join(dir, "de", "messages.po");

		writePo(
			f1,
			'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgid "Hello"\nmsgstr ""\n',
		);
		writePo(
			f2,
			'msgid ""\nmsgstr ""\n"Language: de\\n"\n\nmsgid "World"\nmsgstr ""\n',
		);

		const events = [];
		const res = await translatePoDirectory({
			directoryPath: dir,
			include: "**/*.po",
			client: mockClient,
			onProgress: (e) => events.push(e),
		});

		expect(res.length).toBe(2);
		expect(read(f1)).toMatch(/msgstr "\[T\] Hello"/);
		expect(read(f2)).toMatch(/msgstr "\[T\] World"/);
		expect(events.some((e) => e.type === "start")).toBe(true);
		expect(events.some((e) => e.type === "done")).toBe(true);
	});
});

describe("retry on rate limits", () => {
	it("retries OpenAI requests after 429 errors", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const createMock = vi.fn(async () => {
			calls += 1;
			if (calls < 3) {
				const err = new Error("429 status code (no body)");
				err.status = 429;
				throw err;
			}
			return {
				choices: [
					{ message: { content: JSON.stringify({ "0": "[T] Hello" }) } },
				],
			};
		});
		const mockClient = {
			chat: { completions: { create: createMock } },
		};

		const dir = makeTempDir();
		const file = path.join(dir, "fr.po");
		writePo(
			file,
			'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgid "Hello"\nmsgstr ""\n',
		);

		const promise = translatePoFile({
			filePath: file,
			client: mockClient,
			onProgress: () => {},
		});
		await vi.runAllTimersAsync();
		await promise;

		expect(createMock).toHaveBeenCalledTimes(3);
		expect(read(file)).toMatch(/msgstr "\[T\] Hello"/);
		vi.useRealTimers();
	});

	it("does not retry non-retryable errors", async () => {
		const createMock = vi.fn(async () => {
			const err = new Error("401 Incorrect API key");
			err.status = 401;
			throw err;
		});
		const mockClient = {
			chat: { completions: { create: createMock } },
		};

		const dir = makeTempDir();
		const file = path.join(dir, "fr.po");
		writePo(
			file,
			'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgid "Hello"\nmsgstr ""\n',
		);

		await expect(
			translatePoFile({
				filePath: file,
				client: mockClient,
				onProgress: () => {},
			}),
		).rejects.toThrow("401 Incorrect API key");
		expect(createMock).toHaveBeenCalledTimes(1);
	});
});

describe("providers", () => {
	it("uses OpenAI client when provider is openai (default)", async () => {
		const mockClient = createOpenAIBatchClient("[OpenAI]");

		const dir = makeTempDir();
		const file = path.join(dir, "fr.po");
		writePo(
			file,
			'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgid "Hi"\nmsgstr ""\n',
		);

		await translatePoFile({
			filePath: file,
			client: mockClient,
			provider: "openai",
			onProgress: () => {},
		});

		expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(1);
		expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "gpt-4o-mini",
				messages: expect.arrayContaining([
					expect.objectContaining({ role: "system" }),
					expect.objectContaining({
						role: "user",
						content: JSON.stringify({ "0": "Hi" }),
					}),
				]),
			}),
		);
		expect(read(file)).toMatch(/msgstr "\[OpenAI\] Hi"/);
	});

	it("uses Anthropic client when provider is anthropic", async () => {
		const mockClient = createAnthropicBatchClient("[Anthropic]");

		const dir = makeTempDir();
		const file = path.join(dir, "fr.po");
		writePo(
			file,
			'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgid "Hi"\nmsgstr ""\n',
		);

		await translatePoFile({
			filePath: file,
			client: mockClient,
			provider: "anthropic",
			onProgress: () => {},
		});

		expect(mockClient.messages.create).toHaveBeenCalledTimes(1);
		expect(mockClient.messages.create).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "claude-3-5-haiku-20241022",
				system: expect.stringContaining("Translate into fr"),
				messages: [
					{ role: "user", content: JSON.stringify({ "0": "Hi" }) },
				],
			}),
		);
		expect(read(file)).toMatch(/msgstr "\[Anthropic\] Hi"/);
	});

	it("uses custom model when provider is anthropic", async () => {
		const mockClient = createAnthropicBatchClient();

		const dir = makeTempDir();
		const file = path.join(dir, "fr.po");
		writePo(
			file,
			'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgid "Hi"\nmsgstr ""\n',
		);

		await translatePoFile({
			filePath: file,
			client: mockClient,
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			onProgress: () => {},
		});

		expect(mockClient.messages.create).toHaveBeenCalledWith(
			expect.objectContaining({ model: "claude-3-5-sonnet-20241022" }),
		);
	});

	it("uses Gemini client when provider is gemini", async () => {
		const mockClient = createGeminiBatchClient();

		const dir = makeTempDir();
		const file = path.join(dir, "fr.po");
		writePo(
			file,
			'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgid "Hi"\nmsgstr ""\n',
		);

		await translatePoFile({
			filePath: file,
			client: mockClient,
			provider: "gemini",
			onProgress: () => {},
		});

		expect(mockClient.models.generateContent).toHaveBeenCalledTimes(1);
		expect(mockClient.models.generateContent).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "gemini-2.0-flash",
				contents: JSON.stringify({ "0": "Hi" }),
				config: expect.objectContaining({
					systemInstruction: expect.stringContaining("Translate into fr"),
				}),
			}),
		);
		expect(read(file)).toMatch(/msgstr "\[Gemini\] Hi"/);
	});

	it("uses custom model when provider is gemini", async () => {
		const mockClient = createGeminiBatchClient();

		const dir = makeTempDir();
		const file = path.join(dir, "fr.po");
		writePo(
			file,
			'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgid "Hi"\nmsgstr ""\n',
		);

		await translatePoFile({
			filePath: file,
			client: mockClient,
			provider: "gemini",
			model: "gemini-2.5-flash",
			onProgress: () => {},
		});

		expect(mockClient.models.generateContent).toHaveBeenCalledWith(
			expect.objectContaining({ model: "gemini-2.5-flash" }),
		);
	});

	it("translatePoDirectory uses defaultProvider and defaultModel", async () => {
		const mockClient = createAnthropicBatchClient("[A]");

		const dir = makeTempDir();
		const file = path.join(dir, "fr", "messages.po");
		writePo(
			file,
			'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgid "Hello"\nmsgstr ""\n',
		);

		await translatePoDirectory({
			directoryPath: dir,
			include: "**/*.po",
			client: mockClient,
			defaultProvider: "anthropic",
			defaultModel: "claude-3-5-sonnet-20241022",
			onProgress: () => {},
		});

		expect(mockClient.messages.create).toHaveBeenCalledWith(
			expect.objectContaining({ model: "claude-3-5-sonnet-20241022" }),
		);
		expect(read(file)).toMatch(/msgstr "\[A\] Hello"/);
	});
});
