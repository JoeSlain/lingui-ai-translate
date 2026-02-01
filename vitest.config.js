import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Exclude integration tests from default run (they need real API keys)
		exclude: ["**/node_modules/**", "**/*.integration.test.js"],
	},
});
