import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { translatePoFile, translatePoDirectory } from '../src/index.js'

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingui-ai-'))
  return dir
}

function writePo(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

describe('translatePoFile', () => {
  let mockClient
  beforeEach(() => {
    mockClient = {
      chat: {
        completions: {
          create: vi.fn(async ({ messages }) => {
            const user = messages.find((m) => m.role === 'user')
            return { choices: [{ message: { content: `[T] ${user.content}` } }] }
          }),
        },
      },
    }
  })

  it('translates a single msgid into msgstr', async () => {
    const dir = makeTempDir()
    const file = path.join(dir, 'fr.po')
    writePo(
      file,
      'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgid "Hello {name}!"\nmsgstr ""\n',
    )

    const progress = []
    await translatePoFile({ filePath: file, client: mockClient, onProgress: (e) => progress.push(e) })

    const out = read(file)
    expect(out).toMatch(/msgstr "\[T\] Hello \{name\}!"/)
    expect(progress[0].type).toBe('start')
    expect(progress.at(-1).type).toBe('done')
  })
})

describe('translatePoDirectory', () => {
  let mockClient
  beforeEach(() => {
    mockClient = {
      chat: {
        completions: {
          create: vi.fn(async ({ messages }) => {
            const user = messages.find((m) => m.role === 'user')
            return { choices: [{ message: { content: `[T] ${user.content}` } }] }
          }),
        },
      },
    }
  })

  it('walks a directory and translates files by header language', async () => {
    const dir = makeTempDir()
    const f1 = path.join(dir, 'fr', 'messages.po')
    const f2 = path.join(dir, 'de', 'messages.po')

    writePo(
      f1,
      'msgid ""\nmsgstr ""\n"Language: fr\\n"\n\nmsgid "Hello"\nmsgstr ""\n',
    )
    writePo(
      f2,
      'msgid ""\nmsgstr ""\n"Language: de\\n"\n\nmsgid "World"\nmsgstr ""\n',
    )

    const events = []
    const res = await translatePoDirectory({
      directoryPath: dir,
      include: '**/*.po',
      client: mockClient,
      onProgress: (e) => events.push(e),
    })

    expect(res.length).toBe(2)
    expect(read(f1)).toMatch(/msgstr "\[T\] Hello"/)
    expect(read(f2)).toMatch(/msgstr "\[T\] World"/)
    expect(events.some((e) => e.type === 'start')).toBe(true)
    expect(events.some((e) => e.type === 'done')).toBe(true)
  })
})
