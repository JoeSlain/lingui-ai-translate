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

Use a different provider or model (default is OpenAI + `gpt-4o-mini`):

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
- `--model <model>`: Model to use (optional; defaults: `gpt-4o-mini`, `claude-3-5-haiku-20241022`, or `gemini-2.0-flash` per provider)
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
  defaultModel: 'gpt-4o-mini',
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

### Legacy script usage
The legacy entry still works (OpenAI only):

```bash
node translator.js locale/de/messages.po de
```

![Screen-Recording-2025-09-29-at-14 07 27](https://github.com/user-attachments/assets/0a03aecb-505f-4d26-9d58-6cba3ec72693)

### Roadmap
- [ ] Add support for .ts files
