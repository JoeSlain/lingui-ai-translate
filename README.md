## lingui-ai-translate
Translate Lingui `.po` files using OpenAI – as a CLI and importable library.

### Requirements
- **OPENAI_API_KEY** must be set in your environment
- Node.js >= 18

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

Batch translate a directory. Language is read from the `.po` header `Language:`. If not present, you can pass a default with `-l`.

```bash
lingui-ai-translate -d locale/ --include "**/messages.po"
# or with default language fallback
lingui-ai-translate -d locale/ -l fr
```

Options:

- `-f, --file <path>`: Single `.po` file
- `-l, --language <lang>`: Target language (required with `--file`, optional with `--directory`)
- `-d, --directory <path>`: Directory to batch process
- `--include <glob>`: Glob for files inside directory (default `**/*.po`)
- `--model <model>`: OpenAI model (default `gpt-4o-mini`)
- `--dry-run`: Print planned changes without writing
- `--concurrency <n>`: Files to process in parallel (default 2)

### Library API

```js
import { translatePoFile, translatePoDirectory } from 'lingui-ai-translate'

await translatePoFile({ filePath: 'locale/fr/messages.po', language: 'fr' })

await translatePoDirectory({
  directoryPath: 'locale',
  include: '**/messages.po',
  defaultLanguage: 'fr',
})
```

### Examples
See `examples/fr/messages.po` and `examples/de/messages.po` for small sample files.

### Legacy script usage
The legacy entry still works:

```bash
node translator.js locale/de/messages.po de
```

![Screen-Recording-2025-09-29-at-14 07 27](https://github.com/user-attachments/assets/0a03aecb-505f-4d26-9d58-6cba3ec72693)

### Roadmap
- [ ] Add suport for .ts files
- [ ] Add support for multiple llms providers using vercel ai sdk [models](https://ai-sdk.dev/docs/foundations/providers-and-models#model-capabilities)
