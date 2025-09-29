// translator.js
// Fills empty msgstr in a .po file using OpenAI translation
// Usage: node translator.js locale/fr/messages.po fr

import { translatePoFile } from './src/index.js'

const poPath = process.argv[2]
const targetLang = process.argv[3]

if (!poPath || !targetLang) {
  console.error('Usage: node translator.js <path-to-po> <lang>')
  process.exit(1)
}

if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment')
  process.exit(1)
}

translatePoFile({ filePath: poPath, language: targetLang })
  .then((res) => {
    console.log(`Translated ${res.processed} entries in ${res.filePath}`)
  })
  .catch((err) => {
    console.error(err?.message || err)
    process.exit(1)
  })
