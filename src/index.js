import fs from 'fs'
import path from 'path'
import fg from 'fast-glob'
import gettextParser from 'gettext-parser'
import OpenAI from 'openai'

function getOpenAIClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

function extractLanguageFromHeaders(headers) {
  if (!headers) return null
  const keys = Object.keys(headers)
  for (const k of keys) {
    if (k.toLowerCase() === 'language') {
      const value = headers[k]
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }
  }
  return null
}

function createTranslatePrompt(targetLang) {
  return `Translate into ${targetLang}. Only output the translation text. Do not translate text inside curly braces or ICU placeholders. Example: "Hello {name}" should keep {name} unchanged. Maintain surrounding punctuation. Make short an concise translation while preserving the full meaning of the sentence.`
}

async function translateText({ client, text, language, model }) {
  const res = await client.chat.completions.create({
    model: model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: createTranslatePrompt(language) },
      { role: 'user', content: text },
    ],
  })
  const out = res.choices?.[0]?.message?.content ?? ''
  return out.trim()
}

function listUntranslatedEntries(poJson) {
  const items = []
  const translations = poJson.translations || {}
  for (const ctx of Object.keys(translations)) {
    const byId = translations[ctx]
    for (const msgid of Object.keys(byId)) {
      if (!msgid) continue
      const entry = byId[msgid]
      if (!entry || entry.msgid !== msgid) continue
      const firstStr = Array.isArray(entry.msgstr) ? entry.msgstr[0] : ''
      if (!firstStr) {
        items.push({ ctx, msgid, entry })
      }
    }
  }
  return items
}

function setTranslation(entry, text) {
  if (!Array.isArray(entry.msgstr)) entry.msgstr = ['']
  entry.msgstr[0] = text.replace(/"/g, '\\"')
}

export async function translatePoFile({ filePath, language, model, dryRun = false, client, onProgress }) {
  const abs = path.resolve(filePath)
  const raw = fs.readFileSync(abs)
  let po
  try {
    po = gettextParser.po.parse(raw)
  } catch (err) {
    const baseMsg = err?.message || String(err)
    throw new Error(`Error parsing PO data in ${abs}: ${baseMsg}. This can be caused by an unescaped quote character in a msgid or msgstr value.`)
  }

  const headerLang = extractLanguageFromHeaders(po.headers)
  const targetLang = language || headerLang
  if (!targetLang) {
    throw new Error(`Could not determine language for ${filePath}. Provide --language or set Language header in .po`)
  }

  const items = listUntranslatedEntries(po)
  const total = items.length

  if (onProgress) onProgress({ type: 'start', filePath: abs, total })

  const openaiClient = client || getOpenAIClient()

  let processed = 0
  for (const { entry, msgid } of items) {
    const translated = await translateText({ client: openaiClient, text: msgid, language: targetLang, model })
    setTranslation(entry, translated)
    processed += 1
    if (onProgress) onProgress({ type: 'progress', filePath: abs, processed, total })
  }

  if (dryRun) {
    if (onProgress) onProgress({ type: 'done', filePath: abs, processed, total, dryRun: true })
    console.log(`[dry-run] ${filePath}: would write ${processed} translations`)
    return { filePath: abs, processed, dryRun: true }
  }

  const out = gettextParser.po.compile(po)
  fs.writeFileSync(abs, out)
  if (onProgress) onProgress({ type: 'done', filePath: abs, processed, total, dryRun: false })
  return { filePath: abs, processed, dryRun: false }
}

async function withConcurrency(limit, items, worker) {
  const queue = [...items]
  let active = 0
  let index = 0
  const results = []
  return await new Promise((resolve, reject) => {
    const next = () => {
      if (queue.length === 0 && active === 0) {
        resolve(Promise.all(results))
        return
      }
      while (active < limit && queue.length > 0) {
        const i = index++
        const item = queue.shift()
        active += 1
        Promise.resolve()
          .then(() => worker(item, i))
          .then((r) => {
            active -= 1
            results.push(r)
            next()
          })
          .catch((err) => {
            active -= 1
            reject(err)
          })
      }
    }
    next()
  })
}

export async function translatePoDirectory({
  directoryPath,
  include = '**/*.po',
  defaultLanguage,
  defaultModel,
  dryRun = false,
  concurrency = 2,
  client,
  onProgress,
}) {
  const absDir = path.resolve(directoryPath)
  const files = await fg(include, { cwd: absDir, absolute: true })

  if (files.length === 0) {
    console.log(`No .po files found in ${absDir} matching ${include}`)
    return []
  }

  const results = await withConcurrency(concurrency, files, async (filePath) => {
    const raw = fs.readFileSync(filePath)
    let po
    try {
      po = gettextParser.po.parse(raw)
    } catch (err) {
      const baseMsg = err?.message || String(err)
      throw new Error(`Error parsing PO data in ${filePath}: ${baseMsg}. This can be caused by an unescaped quote character in a msgid or msgstr value.`)
    }
    const headerLang = extractLanguageFromHeaders(po.headers)
    const language = headerLang || defaultLanguage
    if (!language) {
      console.warn(`Skipping ${filePath}: could not determine language (no header and no --language)`) 
      return { filePath, processed: 0, skipped: true }
    }
    return await translatePoFile({ filePath, language, model: defaultModel, dryRun, client, onProgress })
  })

  return results
}

export default {
  translatePoFile,
  translatePoDirectory,
}
