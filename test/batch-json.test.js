import { describe, it, expect } from "vitest";
import {
	buildBatchInput,
	parseBatchTranslationResponse,
} from "../src/index.js";

describe("buildBatchInput", () => {
	it("maps items to numeric string keys", () => {
		const input = buildBatchInput([
			{ msgid: "Hello" },
			{ msgid: "World {name}" },
		]);
		expect(input).toEqual({
			"0": "Hello",
			"1": "World {name}",
		});
	});
});

describe("parseBatchTranslationResponse", () => {
	const keys = ["0", "1"];

	it("parses a valid JSON object", () => {
		const result = parseBatchTranslationResponse(
			'{"0":"Bonjour","1":"Monde {name}"}',
			keys,
		);
		expect(result).toEqual({
			"0": "Bonjour",
			"1": "Monde {name}",
		});
	});

	it("strips markdown code fences", () => {
		const result = parseBatchTranslationResponse(
			'```json\n{"0":"A","1":"B"}\n```',
			keys,
		);
		expect(result).toEqual({ "0": "A", "1": "B" });
	});

	it("throws on invalid JSON", () => {
		expect(() => parseBatchTranslationResponse("not json", keys)).toThrow(
			"Invalid JSON in batch translation response",
		);
	});

	it("throws when response is an array", () => {
		expect(() => parseBatchTranslationResponse('["a","b"]', keys)).toThrow(
			"Batch translation response must be a JSON object",
		);
	});

	it("throws when a key is missing", () => {
		expect(() =>
			parseBatchTranslationResponse('{"0":"only one"}', keys),
		).toThrow('Missing translation for key "1"');
	});

	it("throws when a value is not a string", () => {
		expect(() =>
			parseBatchTranslationResponse('{"0":"ok","1":42}', keys),
		).toThrow('Translation for key "1" must be a string');
	});

	it("handles strings with quotes and newlines", () => {
		const result = parseBatchTranslationResponse(
			JSON.stringify({ "0": 'Say "hi"', "1": "line\nbreak" }),
			keys,
		);
		expect(result["0"]).toBe('Say "hi"');
		expect(result["1"]).toBe("line\nbreak");
	});
});
