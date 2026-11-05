## lingui-ai-translate
Translate Lingui `.po` files using AI – as a CLI and importable library. Supports **OpenAI**, **Anthropic**, and **Google Gemini**.

### Requirements
- **API key** for your chosen provider (set in environment):
  - **OpenAI**: `OPENAI_API_KEY`
  - **Anthropic**: `ANTHROPIC_API_KEY`
  - **Gemini**: `GEMINI_API_KEY`
- Node.js >= 18 (Gemini SDK recommends Node 20+)

### Install
Use directly with npx (after publishing) or install locally:

```bash
npx lingui-ai-translate --help
# or
npm i -D lingui-ai-translate
```

### CLI Usage
Translate a single file (language explicit):

```bash
lingui-ai-translate -f locale/fr/messages.po -l fr
```

Use a different provider or model (default is OpenAI + `gpt-6-luna`):

```bash
# Anthropic (default model: claude-3-5-haiku-20241022)
lingui-ai-translate -f locale/fr/messages.po -l fr --provider anthropic

# Gemini (default model: gemini-2.0-flash)
lingui-ai-translate -f locale/fr/messages.po -l fr --provider gemini

# Explicit model
lingui-ai-translate -f locale/fr/messages.po -l fr --provider openai --model gpt-4o
lingui-ai-translate -f locale/fr/messages.po -l fr --provider gemini --model gemini-2.5-flash
```

Batch translate a directory. Language is read from the `.po` header `Language:`. If not present, you can pass a default with `-l`.

```bash
lingui-ai-translate -d locale/ --include "**/messages.po"
# or with default language fallback
lingui-ai-translate -d locale/ -l fr
# or with custom translation rules
lingui-ai-translate -f locale/fr/messages.po -l fr --rules "only use first person, do not translate the word 'API'"
```

Options:

- `-f, --file <path>`: Single `.po` file
- `-l, --language <lang>`: Target language (required with `--file`, optional with `--directory`)
- `-d, --directory <path>`: Directory to batch process
- `--provider <name>`: `openai` (default), `anthropic`, or `gemini`
- `--model <model>`: Model to use (optional; defaults: `gpt-6-luna`, `claude-3-5-haiku-20241022`, or `gemini-2.0-flash` per provider)
- `--include <glob>`: Glob for files inside directory (default `**/*.po`)
- `--dry-run`: Print planned changes without writing
- `--concurrency <n>`: Files to process in parallel (default 2)
- `--rules <rules>`: Additional translation rules (e.g., "only use first person, do not translate the word 'API'")

### Library API

```js
import { translatePoFile, translatePoDirectory } from 'lingui-ai-translate'

// Default: OpenAI + gpt-4o-mini
await translatePoFile({ filePath: 'locale/fr/messages.po', language: 'fr' })

// Provider and model
await translatePoFile({
  filePath: 'locale/fr/messages.po',
  language: 'fr',
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
})

await translatePoFile({
  filePath: 'locale/fr/messages.po',
  language: 'fr',
  provider: 'gemini',
  rules: "only use first person, do not translate the word 'API'",
})

await translatePoDirectory({
  directoryPath: 'locale',
  include: '**/messages.po',
  defaultLanguage: 'fr',
  defaultProvider: 'openai',
  defaultModel: 'gpt-6-luna',
  rules: "only use first person, do not translate the word 'API'",
})
```

You can pass a custom `client` (e.g. an OpenAI-compatible client) for testing or custom backends; the provider is assumed to match the client shape.

### Testing
- **Unit tests** (mocked APIs): `npm test`
- **Integration tests** (real LLM APIs): set the API key(s) you want to test, then run `npm run test:integration`. Each provider’s tests run only when its env var is set (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`). Example:

```bash
export OPENAI_API_KEY=sk-...
npm run test:integration
```

### Examples
See `examples/fr/messages.po` and `examples/de/messages.po` for small sample files.


![Screen-Recording-2025-09-29-at-14 07 27](https://github.com/user-attachments/assets/0a03aecb-505f-4d26-9d58-6cba3ec72693)

### Roadmap
- [ ] Add support for .ts files

### Cost-safe translation (0.2)

OpenAI now defaults to `gpt-6-luna` with reasoning disabled and JSON output. You can
still select a model explicitly. `LINGUI_OPENAI_API_KEY` takes precedence over
`OPENAI_API_KEY`, so translation workloads can use a separate project/key.

- `--dry-run` plans without an API key, network calls, catalog writes or job creation.
- Successful chunks are checkpointed atomically; rerunning continues missing work.
- The CLI caches successful translations in `.lingui-ai-translate/cache.json`.
  Cache keys include provider, model, target language, rules and source text. Use
  `--no-cache` to disable it, or `--cache <path>` to share a cache across worktrees.
- The CLI appends counters to `.lingui-ai-translate/usage.jsonl` and emits
  `[translation][usage]` records. They contain model, mode, tokens and estimated
  USD, without prompts, translations, API keys or raw errors. Add
  `.lingui-ai-translate/` to your `.gitignore`.
- `--max-requests 100` limits attempts, including retries. `--max-cost-usd 1`
  reserves a conservative estimate of input and maximum output before each call.
  Concurrent requests share the limit. Costs are estimates, not billing records;
  unknown prices/usages stay explicit, and a cost limit rejects unknown models.
  Current estimates cover standard GPT-6 Luna and GPT-4o-mini, including snapshots.
- Exhausted credits are not retried. OpenAI SDK retries are disabled so there is
  only one retry layer. Malformed JSON retries count toward the same budget.

```bash
# Immediate workflow; cache and counters are saved automatically
lingui-ai-translate -d locale --max-cost-usd 1 --max-requests 100

# Plan for free; does not translate or save anything
lingui-ai-translate -d locale --dry-run

# Asynchronous OpenAI Batch API (50% of standard token prices; up to 24 hours)
lingui-ai-translate -d locale --mode batch --job .lingui-ai-translate/release.json --max-cost-usd 1

# Poll once and apply available completed results; never submits another job
lingui-ai-translate --resume .lingui-ai-translate/release.json
```

Batch is OpenAI-only. Keep each job manifest until it has been applied, and use a
new path for a new job. Resuming preserves translations manually edited after
submission, accepts out-of-order results, and applies successful lines even when
other lines failed or expired. Partial jobs exit nonzero and leave missing work
untranslated; rerun a new job or the synchronous translator for those entries.
An interrupted/ambiguous submission is never automatically resubmitted: inspect
the OpenAI Batch dashboard before removing its manifest. Keep the original job
files and catalog locations until completion.

The library also exports `createTranslationSession`, `translateStrings`,
`submitTranslationBatch` and `resumeTranslationBatch`. Cache, usage logs and budgets
are opt-in for library callers; the CLI sets the paths above by default:

```js
import { createTranslationSession, translateStrings } from 'lingui-ai-translate'
const session = createTranslationSession({
  cachePath: '.lingui-ai-translate/cache.json',
  usageLog: '.lingui-ai-translate/usage.jsonl',
  maxCostUsd: 1,
  maxRequests: 100,
})
const { translations } = await translateStrings({
  strings: ['Camera access', 'Photo access'],
  language: 'French',
  rules: 'Use second person singular. Do not translate Hellobud.',
  session,
})
```

Pricing references: https://developers.openai.com/api/docs/models/gpt-6-luna,
https://developers.openai.com/api/docs/models/gpt-4o-mini and
https://developers.openai.com/api/docs/guides/batch.
