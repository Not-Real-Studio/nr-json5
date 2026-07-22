import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseJson5, stringifyJson5 } from '../src/json5.js'

const suiteDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'json5-suite')

/**
 * The official json5-tests suite, vendored verbatim. Its README fixes the
 * contract by extension:
 *   .json  — valid JSON, so valid JSON5
 *   .json5 — valid JSON5 (and valid ES5)
 *   .js    — valid ES5 that JSON5 rejects
 *   .txt   — invalid ES5, so invalid JSON5
 */
function collect(dir: string): { file: string; rel: string; ext: string }[] {
  const out: { file: string; rel: string; ext: string }[] = []

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collect(file))
      continue
    }
    const ext = path.extname(entry.name)
    if (['.json', '.json5', '.js', '.txt'].includes(ext)) {
      out.push({ file, rel: path.relative(suiteDir, file).replace(/\\/g, '/'), ext })
    }
  }

  return out
}

const cases = collect(suiteDir)

/**
 * The `.errorSpec` files date from json5 1.x and were never updated for the 2.x
 * position conventions — the reference json5 2.2.3 misses these two exactly as
 * we do, so pinning them would pin a bug, not the contract. The other six
 * errorSpecs are asserted below.
 */
const STALE_ERROR_SPECS = new Set([
  'comments/top-level-inline-comment.errorSpec',
  'strings/unescaped-multi-line-string.errorSpec',
])

/** The suite's premise for valid cases: they are all valid ES5 expressions. */
function evalEs5(text: string): unknown {
  // The newlines matter: a fixture may end in a `// comment`, which would
  // otherwise swallow the closing paren.
  return eval(`(\n${text}\n)`)
}

describe('official json5-tests suite', () => {
  test('the suite is actually vendored', () => {
    // Guards against a silently empty directory turning this file into a no-op.
    expect(cases.length).toBeGreaterThan(100)
  })

  const valid = cases.filter((c) => c.ext === '.json' || c.ext === '.json5')
  const invalid = cases.filter((c) => c.ext === '.js' || c.ext === '.txt')

  describe.each(valid)('valid: $rel', ({ file, ext }) => {
    const text = fs.readFileSync(file, 'utf8')

    test('parses', () => {
      expect(() => parseJson5(text)).not.toThrow()
    })

    test('agrees with ES5 evaluation', () => {
      expect(parseJson5(text)).toEqual(evalEs5(text))
    })

    if (ext === '.json') {
      test('agrees with JSON.parse', () => {
        // comments/irregular-block-comment.json carries a comment despite the
        // extension, so JSON rejects it while JSON5 does not. Where JSON has an
        // opinion, ours must match it.
        let expected: unknown
        try {
          expected = JSON.parse(text)
        } catch {
          return
        }
        expect(parseJson5(text)).toEqual(expected)
      })
    }
  })

  describe.each(invalid)('invalid: $rel', ({ file }) => {
    const text = fs.readFileSync(file, 'utf8')

    test('throws a SyntaxError', () => {
      expect(() => parseJson5(text)).toThrow(SyntaxError)
    })

    const spec = file.replace(/\.(js|txt)$/, '.errorSpec')
    const specRel = path.relative(suiteDir, spec).replace(/\\/g, '/')
    if (fs.existsSync(spec) && !STALE_ERROR_SPECS.has(specRel)) {
      test('reports the documented position', () => {
        const expected = parseJson5(fs.readFileSync(spec, 'utf8')) as {
          lineNumber: number
          columnNumber: number
        }

        try {
          parseJson5(text)
          throw new Error('expected a throw')
        } catch (err) {
          const e = err as { lineNumber: number; columnNumber: number }
          expect({ lineNumber: e.lineNumber, columnNumber: e.columnNumber }).toEqual({
            lineNumber: expected.lineNumber,
            columnNumber: expected.columnNumber,
          })
        }
      })
    }
  })
})

describe('parseJson5 — grammar spot checks', () => {
  test.each([
    ['unquoted keys', '{a: 1, $b: 2, _c: 3}', { a: 1, $b: 2, _c: 3 }],
    ['unicode keys', '{ümlåût: 1}', { 'ümlåût': 1 }],
    ['escaped keys', '{sig\\u03A3ma: 1}', { sigΣma: 1 }],
    ['single quotes', "{a: 'x'}", { a: 'x' }],
    ['trailing comma', '{a: 1,}', { a: 1 }],
    ['comments', '{/* a */ a: 1 // b\n}', { a: 1 }],
    ['hex', '{a: 0xdecaf}', { a: 0xdecaf }],
    ['leading decimal point', '{a: .5}', { a: 0.5 }],
    ['trailing decimal point', '{a: 5.}', { a: 5 }],
    ['plus sign', '{a: +1}', { a: 1 }],
    ['Infinity', '{a: Infinity, b: -Infinity}', { a: Infinity, b: -Infinity }],
    ['line continuation', "{a: 'x\\\ny'}", { a: 'xy' }],
    ['escapes', "{a: '\\x41\\u0042\\n\\t\\0'}", { a: 'AB\n\t\0' }],
  ])('%s', (_name, input, expected) => {
    expect(parseJson5(input)).toEqual(expected)
  })

  test('NaN', () => {
    expect(parseJson5('{a: NaN}')).toEqual({ a: NaN })
  })

  test('reports line and column on a broken meta', () => {
    try {
      parseJson5('{\n  a: 1,\n  b: @\n}')
      throw new Error('expected a throw')
    } catch (err) {
      const e = err as { lineNumber: number; columnNumber: number }
      expect(e.lineNumber).toBe(3)
      expect(e.columnNumber).toBe(6)
    }
  })
})

describe('stringifyJson5 — canonical relaxed', () => {
  test.each([
    ['bare key', { a: 1 }, '{a: 1}'],
    ['bare key with $ and _', { $a_1: 1 }, '{$a_1: 1}'],
    ['quoted key — dash', { 'a-b': 1 }, "{'a-b': 1}"],
    ['quoted key — leading digit', { '1a': 1 }, "{'1a': 1}"],
    ['quoted key — empty', { '': 1 }, "{'': 1}"],
    ['quoted key — non-ASCII stays quoted', { über: 1 }, "{'über': 1}"],
    ['single-quoted strings', { a: 'x' }, "{a: 'x'}"],
    ['escaped apostrophe', { a: "it's" }, "{a: 'it\\'s'}"],
    ['double quote is literal', { a: 'say "hi"' }, '{a: \'say "hi"\'}'],
    ['backslash', { a: 'C:\\x' }, "{a: 'C:\\\\x'}"],
    ['control chars', { a: '\n\t\r\b\f\v\0' }, "{a: '\\n\\t\\r\\b\\f\\v\\0'}"],
    ['null and booleans', { a: null, b: true, c: false }, '{a: null, b: true, c: false}'],
    ['numbers', { a: 1, b: -2.5, c: 1e30 }, '{a: 1, b: -2.5, c: 1e+30}'],
    ['non-finite numbers', { a: Infinity, b: -Infinity, c: NaN }, '{a: Infinity, b: -Infinity, c: NaN}'],
    ['negative zero keeps its sign', { a: -0 }, '{a: -0}'],
    ['nested', { a: { b: [1, 2] } }, '{a: {b: [1, 2]}}'],
    ['empty object and array', { a: {}, b: [] }, '{a: {}, b: []}'],
    ['undefined dropped from objects', { a: 1, b: undefined }, '{a: 1}'],
    ['undefined is null in arrays', { a: [1, undefined] }, '{a: [1, null]}'],
    ['functions dropped', { a: 1, b: () => 1 }, '{a: 1}'],
    ['toJSON honoured', { a: new Date('2026-07-15T10:22:44.901Z') }, "{a: '2026-07-15T10:22:44.901Z'}"],
  ])('%s', (_name, input, expected) => {
    expect(stringifyJson5(input)).toBe(expected)
  })

  test('always one line', () => {
    expect(stringifyJson5({ a: { b: { c: [1, { d: 2 }] } } })).not.toContain('\n')
  })

  test('a NUL before a digit cannot read back as an octal escape', () => {
    const nulThenDigit = String.fromCharCode(0) + '7'
    expect(stringifyJson5({ a: nulThenDigit })).toBe(String.raw`{a: '\x007'}`)
    expect(parseJson5(stringifyJson5({ a: nulThenDigit }))).toEqual({ a: nulThenDigit })
  })

  test('rejects circular structures', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => stringifyJson5(a)).toThrow(TypeError)
  })

  test('rejects BigInt', () => {
    expect(() => stringifyJson5({ a: 1n })).toThrow(TypeError)
  })

  test('rejects a top-level value with no representation', () => {
    expect(() => stringifyJson5(undefined)).toThrow(TypeError)
  })
})

describe('json5 round-trip', () => {
  test.each([
    { a: 1, b: 'x', c: [1, 2, { d: null }], e: true },
    { 'weird key': "quotes ' and \" and \\", nested: { deep: [[[1]]] } },
    { unicode: 'Привет 👋', ctrl: '\n\t' },
    { nums: [0, -0, 1e30, 1e-30, Infinity, -Infinity, NaN] },
  ])('parse(stringify(v)) === v — %#', (value) => {
    expect(parseJson5(stringifyJson5(value))).toEqual(value)
  })

  test('emitting twice is byte-identical', () => {
    const value = { b: 2, a: 1, s: "it's", n: [1, { x: null }] }
    expect(stringifyJson5(value)).toBe(stringifyJson5(structuredClone(value)))
  })
})
