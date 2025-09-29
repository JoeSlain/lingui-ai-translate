// translator.js
// Fills empty msgstr in a .po file using OpenAI translation
// Usage: node translator.js locale/fr/messages.po fr

import fs from 'fs'
import OpenAI from 'openai'

const poPath = process.argv[2]
const targetLang = process.argv[3]
if (!poPath || !targetLang) {
  console.error('Usage: node translator.js <path-to-po> <lang>')
  process.exit(1)
}

const client = new OpenAI({
  apiKey:
    process.env.OPENAI_API_KEY,
})
const poContent = fs.readFileSync(poPath, 'utf8')
const blocks = poContent.split(/\n\s*\n/)

function parseMsgid(block) {
  const match = block.match(/msgid\s+"([\s\S]*?)"/)
  return match ? match[1] : null
}

function hasEmptyMsgstr(block) {
  return /\nmsgstr\s+""/.test(block)
}

async function translate(text) {
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `Translate into ${targetLang}. Only output the translation text, do not translate text inside curly braces. Example "Hello {name}" should be translated to "Bonjour {name}".`,
      },
      { role: 'user', content: text },
    ],
  })
  return res.choices[0].message.content.trim().replace(/"/g, '\\"')
}

async function main() {
  const updated = []
  for (const block of blocks) {
    if (hasEmptyMsgstr(block)) {
      const msg = parseMsgid(block)
      if (msgid) {
        const t = await translate(msgid)
        const newBlock = block.replace(/msgstr\s+""/, `msgstr "${t}"
        updated.push(newBck)
      } else {
        updated.push(block)
      }
    } else {
      updated.push(block)
    }
  }
  fs.writeFileSync(poPath, updated.join('\n\n') + '\n', 'utf8')

          }

main()
sedCount}/${emptyBlocks.length}] Translating: "${msgid.substring(0, 50)}${msgid.length > 50 ? '...' : ''}"`,
        )

        const t = await translate(msgid)
        console.log(
          `  → Translation: "${t.substring(0, 50)}${t.length > 50 ? '...' : ''}"`,
        )

        const newBlock = block.replace(/msgstr\s+""/, `msgstr "${t}"`)
        updated.push(newBlock)
      } else {
        console.log(`Skipping block with no msgid`)
        updated.push(block)
      }
    } else {
      updated.push(block)
    }
  }

  console.log(`Writing updated file to: ${poPath}`)
  fs.writeFileSync(poPath, updated.join('\n\n') + '\n', 'utf8')
  console.log(`Translation complete! Processed ${processedCount} translations.`)
}

main()
