import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import prettier from 'prettier'
import plugin from '../src/index'

type RunSpecOptions = Record<string, unknown>

const raw = (value: string) => ({ [Symbol.for('raw')]: value })

const toDirname = (dirnameOrMetaUrl: string) =>
  dirnameOrMetaUrl.startsWith('file:') ? dirname(fileURLToPath(dirnameOrMetaUrl)) : dirnameOrMetaUrl

const prettyprint = async (source: string, filepath: string, options: RunSpecOptions) =>
  prettier.format(source, {
    filepath,
    parser: 'django',
    plugins: [plugin as any],
    tabWidth: 4,
    ...options
  })

export function runSpec(dirnameOrMetaUrl: string, parsers: string[], options: RunSpecOptions = {}) {
  const directory = toDirname(dirnameOrMetaUrl)

  if (!parsers.length) {
    throw new Error(`No parsers were specified for ${directory}`)
  }

  for (const filename of readdirSync(directory)) {
    const filepath = join(directory, filename)
    if (extname(filename) === '.snap' || !lstatSync(filepath).isFile() || filename.startsWith('.') || filename === 'jsfmt.spec.ts') {
      continue
    }

    const source = readFileSync(filepath, 'utf8').replace(/\r\n/g, '\n')
    const mergedOptions = { ...options, parser: parsers[0] }

    test(`${filename} - ${mergedOptions.parser}-verify`, async () => {
      const output = await prettyprint(source, filepath, mergedOptions)
      expect(raw(`${source}${'~'.repeat(80)}\n${output}`)).toMatchSnapshot(filename)
    })

    for (const parserName of parsers.slice(1)) {
      test(`${filename} - ${parserName}-verify`, async () => {
        const output = await prettyprint(source, filepath, mergedOptions)
        const verifyOutput = await prettyprint(source, filepath, { ...mergedOptions, parser: parserName })
        expect(output).toEqual(verifyOutput)
      })
    }
  }
}
