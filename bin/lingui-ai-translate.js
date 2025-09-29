#!/usr/bin/env node

import { Command } from 'commander'
import ora from 'ora'
import path from 'path'
import { translatePoFile, translatePoDirectory } from '../src/index.js'

const program = new Command()

program
  .name('lingui-ai-translate')
  .description('Translate Lingui .po files using OpenAI')
  .option('-f, --file <path>', 'Path to a .po file to translate')
  .option('-l, --language <lang>', 'Target language code, e.g. fr, de')
  .option('-d, --directory <path>', 'Directory containing .po files to batch translate')
  .option('--model <model>', 'OpenAI model to use', 'gpt-4o-mini')
  .option('--dry-run', 'Do not write files, just show planned changes', false)
  .option('--include <glob>', 'Glob pattern relative to directory, e.g. "**/messages.po"', '**/*.po')
  .option('--concurrency <n>', 'Parallel files to process', (v) => parseInt(v, 10), 2)
  .showHelpAfterError()

program.parse(process.argv)

const opts = program.opts()

function formatProgressText({ filePath, processed, total }) {
  const rel = path.relative(process.cwd(), filePath)
  return `${rel} – ${processed}/${total}`
}

async function run() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in environment')
    process.exit(1)
  }

  if (opts.file && opts.directory) {
    console.error('Please specify either --file or --directory, not both.')
    process.exit(1)
  }

  if (!opts.file && !opts.directory) {
    console.error('Please specify --file <path> or --directory <path>.')
    program.help({ error: true })
  }

  if (opts.file) {
    if (!opts.language) {
      console.error('When using --file, --language is required (e.g., -l fr).')
      process.exit(1)
    }
    const spinner = ora(`Translating ${opts.file}`).start()
    await translatePoFile({
      filePath: opts.file,
      language: opts.language,
      model: opts.model,
      dryRun: opts.dryRun,
      onProgress: (ev) => {
        if (ev.type === 'start') spinner.text = formatProgressText({ filePath: ev.filePath, processed: 0, total: ev.total })
        if (ev.type === 'progress') spinner.text = formatProgressText(ev)
        if (ev.type === 'done') ev.dryRun ? spinner.info(formatProgressText(ev)) : spinner.succeed(formatProgressText(ev))
      },
    })
    return
  }

  if (opts.directory) {
    const spinner = ora(`Scanning ${opts.directory}`).start()
    await translatePoDirectory({
      directoryPath: opts.directory,
      include: opts.include,
      defaultModel: opts.model,
      dryRun: opts.dryRun,
      concurrency: opts.concurrency,
      defaultLanguage: opts.language,
      onProgress: (ev) => {
        if (ev.type === 'start') spinner.text = formatProgressText({ filePath: ev.filePath, processed: 0, total: ev.total })
        if (ev.type === 'progress') spinner.text = formatProgressText(ev)
        if (ev.type === 'done') ev.dryRun ? spinner.info(formatProgressText(ev)) : spinner.succeed(formatProgressText(ev))
      },
    })
    spinner.stop()
    return
  }
}

run().catch((err) => {
  console.error(err?.message || err)
  process.exit(1)
})
