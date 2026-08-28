import { vi } from "vitest";

function buildBatchResponse(rawInput, prefix) {
	const input = JSON.parse(rawInput);
	const output = {};
	for (const [key, value] of Object.entries(input)) {
		output[key] = `${prefix} ${value}`;
	}
	return JSON.stringify(output);
}

export function createOpenAIBatchClient(prefix = "[T]") {
	const create = vi.fn(async ({ messages }) => {
		const user = messages.find((m) => m.role === "user");
		return {
			choices: [{ message: { content: buildBatchResponse(user.content, prefix) } }],
		};
	});
	return { chat: { completions: { create } } };
}

export function createAnthropicBatchClient(prefix = "[A]") {
	const create = vi.fn(async ({ messages }) => {
		const user = messages.find((m) => m.role === "user");
		return {
			content: [{ type: "text", text: buildBatchResponse(user.content, prefix) }],
		};
	});
	return { messages: { create } };
}

export function createGeminiBatchClient(prefix = "[Gemini]") {
	const generateContent = vi.fn(async ({ contents }) => ({
		text: buildBatchResponse(contents, prefix),
	}));
	return { models: { generateContent } };
}
