import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import gettext from "gettext-parser";
import { submitTranslationBatch, resumeTranslationBatch } from "../src/index.js";
const dirs = [];
function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingui-async-test-"));
	dirs.push(dir);
	const file = path.join(dir, "fr.po"),
		jobPath = path.join(dir, "job.json");
	fs.writeFileSync(
		file,
		'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Language: fr\\n"\n\nmsgid "Hello"\nmsgstr ""\n\nmsgid "Bye"\nmsgstr ""\n',
	);
	let output = "";
	const client = {
		files: {
			create: vi.fn(async () => ({ id: "file-input" })),
			content: vi.fn(async () => ({ text: async () => output })),
		},
		batches: {
			create: vi.fn(async () => ({ id: "batch-1", status: "validating" })),
			retrieve: vi.fn(async () => ({ status: "completed", output_file_id: "file-output" })),
		},
	};
	const row = (id, value) =>
		JSON.stringify({
			custom_id: id,
			response: {
				status_code: 200,
				body: {
					model: "gpt-6-luna",
					usage: { prompt_tokens: 100, completion_tokens: 50 },
					choices: [{ message: { content: JSON.stringify(value) } }],
				},
			},
		});
	return {
		file,
		jobPath,
		client,
		row,
		setOutput: (value) => {
			output = value;
		},
	};
}
afterEach(() => {
	dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});
describe("asynchronous Batch translation", () => {
	it("plans without a key, upload, job file or catalog changes", async () => {
		const x = setup(),
			before = fs.readFileSync(x.file, "utf8");
		const result = await submitTranslationBatch({ ...x, filePath: x.file, dryRun: true });
		expect(result).toMatchObject({ status: "dry_run", total: 2, requests: 1 });
		expect(x.client.files.create).not.toHaveBeenCalled();
		expect(fs.existsSync(x.jobPath)).toBe(false);
		expect(fs.readFileSync(x.file, "utf8")).toBe(before);
	});
	it("resumes out-of-order output without resubmitting or overwriting human edits", async () => {
		const x = setup();
		await submitTranslationBatch({ ...x, filePath: x.file, batchSize: 1 });
		const po = gettext.po.parse(fs.readFileSync(x.file));
		po.translations[""].Hello.msgstr = ["Salut humain"];
		fs.writeFileSync(x.file, gettext.po.compile(po));
		x.setOutput(
			x.row("translation-1", { 0: "Au revoir" }) + "\n" + x.row("translation-0", { 0: "Bonjour" }),
		);
		const onUsage = vi.fn();
		const result = await resumeTranslationBatch({ ...x, onUsage });
		expect(result).toMatchObject({ status: "applied", applied: 2, missing: 0 });
		const after = gettext.po.parse(fs.readFileSync(x.file));
		expect(after.translations[""].Hello.msgstr[0]).toBe("Salut humain");
		expect(after.translations[""].Bye.msgstr[0]).toBe("Au revoir");
		expect(onUsage.mock.calls[0][0].estimatedCostUsd).toBe(0.0000175);
		await resumeTranslationBatch({ ...x, onUsage });
		expect(onUsage).toHaveBeenCalledTimes(2);
		expect(x.client.batches.create).toHaveBeenCalledTimes(1);
		await expect(submitTranslationBatch({ ...x, filePath: x.file })).rejects.toThrow(
			"Job already exists",
		);
	});
	it("keeps successful results from an expired job and reports missing work", async () => {
		const x = setup();
		await submitTranslationBatch({ ...x, filePath: x.file, batchSize: 1 });
		x.client.batches.retrieve.mockResolvedValue({ status: "expired", output_file_id: "partial" });
		x.setOutput(x.row("translation-0", { 0: "Bonjour" }));
		expect(await resumeTranslationBatch(x)).toMatchObject({
			status: "partial",
			applied: 1,
			missing: 1,
		});
		expect(gettext.po.parse(fs.readFileSync(x.file)).translations[""].Hello.msgstr[0]).toBe(
			"Bonjour",
		);
	});
	it("checks the complete budget before uploading or submitting", async () => {
		const x = setup();
		await expect(
			submitTranslationBatch({ ...x, filePath: x.file, batchSize: 1, maxRequests: 1 }),
		).rejects.toThrow("request budget");
		expect(x.client.files.create).not.toHaveBeenCalled();
		expect(x.client.batches.create).not.toHaveBeenCalled();
	});
	it("does not create a new job when an earlier submission was interrupted", async () => {
		const x = setup();
		x.client.batches.create.mockRejectedValue(new Error("Connection interrupted"));
		await expect(submitTranslationBatch({ ...x, filePath: x.file })).rejects.toThrow(
			"Connection interrupted",
		);
		await expect(resumeTranslationBatch(x)).rejects.toThrow("Inspect the OpenAI Batch dashboard");
		await expect(submitTranslationBatch({ ...x, filePath: x.file })).rejects.toThrow(
			"Job already exists",
		);
		expect(x.client.batches.create).toHaveBeenCalledTimes(1);
	});
});

it("claims a Batch job exclusively when two submissions race", async () => {
	const x = setup();
	const attempts = await Promise.allSettled([
		submitTranslationBatch({ ...x, directoryPath: path.dirname(x.file) }),
		submitTranslationBatch({ ...x, directoryPath: path.dirname(x.file) }),
	]);
	expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	expect(x.client.batches.create).toHaveBeenCalledTimes(1);
});

it("refuses stale translations if the pending catalog language changes", async () => {
	const x = setup();
	await submitTranslationBatch({ ...x, filePath: x.file });
	fs.writeFileSync(x.file, fs.readFileSync(x.file, "utf8").replace("Language: fr", "Language: de"));
	x.setOutput(x.row("translation-0", { 0: "Bonjour", 1: "Au revoir" }));
	expect(await resumeTranslationBatch(x)).toMatchObject({ status: "partial", missing: 1 });
	expect(gettext.po.parse(fs.readFileSync(x.file)).translations[""].Hello.msgstr[0]).toBe("");
});
