/**
 * JSON5 — full reader, canonical relaxed writer.
 *
 * The reader is a port of the reference implementation (json5 2.2.3, MIT,
 * (c) 2012-2018 Aseem Kishore and others) — same state machine, so the official
 * json5-tests suite stays green. Two deliberate departures:
 *
 *   - identifier/space character classes use Unicode property escapes instead of
 *     the reference's generated tables (15 KB of regex frozen at Unicode 9). The
 *     tables and `\p{...}` disagree only on characters added to Unicode after
 *     2018, which no suite fixture uses.
 *   - no `reviver`; parser state is per-instance rather than module-global.
 *
 * The writer is ours, not a port: canonical relaxed JSON5, one line, stable
 * enough that two emitters produce byte-identical output.
 */

const RE_ID_START = /[$_\p{ID_Start}]/u
const RE_ID_CONTINUE = /[$_\u200C\u200D\p{ID_Continue}]/u
const RE_SPACE_SEPARATOR = /\p{Zs}/u
const RE_DIGIT = /[0-9]/
const RE_HEX_DIGIT = /[0-9A-Fa-f]/

const isIdStartChar = (c: string | undefined): boolean => c !== undefined && RE_ID_START.test(c)
const isIdContinueChar = (c: string | undefined): boolean => c !== undefined && RE_ID_CONTINUE.test(c)
const isSpaceSeparator = (c: string | undefined): boolean => c !== undefined && RE_SPACE_SEPARATOR.test(c)
const isDigit = (c: string | undefined): boolean => c !== undefined && RE_DIGIT.test(c)
const isHexDigit = (c: string | undefined): boolean => c !== undefined && RE_HEX_DIGIT.test(c)

type TokenType = 'eof' | 'punctuator' | 'null' | 'boolean' | 'numeric' | 'string' | 'identifier'

interface Token {
  type: TokenType
  value?: unknown
  line: number
  column: number
}

/** SyntaxError carrying the position of the offending character. */
export interface Json5SyntaxError extends SyntaxError {
  lineNumber: number
  columnNumber: number
}

class Parser {
  source: string
  parseState = 'start'
  stack: unknown[] = []
  pos = 0
  line = 1
  column = 0
  token: Token = { type: 'eof', line: 1, column: 0 }
  key: string | undefined = undefined
  root: unknown = undefined

  lexState = 'default'
  buffer = ''
  doubleQuote = false
  sign = 1
  c: string | undefined = undefined

  constructor(source: string) {
    this.source = source
  }

  peek(): string | undefined {
    if (this.source[this.pos]) {
      return String.fromCodePoint(this.source.codePointAt(this.pos)!)
    }
    return undefined
  }

  read(): string | undefined {
    const c = this.peek()

    if (c === '\n') {
      this.line++
      this.column = 0
    } else if (c) {
      this.column += c.length
    } else {
      this.column++
    }

    if (c) {
      this.pos += c.length
    }

    return c
  }

  lex(): Token {
    this.lexState = 'default'
    this.buffer = ''
    this.doubleQuote = false
    this.sign = 1

    for (;;) {
      this.c = this.peek()
      const token = lexStates[this.lexState](this)
      if (token) {
        return token
      }
    }
  }

  newToken(type: TokenType, value?: unknown): Token {
    return { type, value, line: this.line, column: this.column }
  }

  literal(s: string): void {
    for (const c of s) {
      const p = this.peek()
      if (p !== c) {
        throw this.invalidChar(this.read())
      }
      this.read()
    }
  }

  escape(): string {
    const c = this.peek()
    switch (c) {
      case 'b':
        this.read()
        return '\b'
      case 'f':
        this.read()
        return '\f'
      case 'n':
        this.read()
        return '\n'
      case 'r':
        this.read()
        return '\r'
      case 't':
        this.read()
        return '\t'
      case 'v':
        this.read()
        return '\v'
      case '0':
        this.read()
        if (isDigit(this.peek())) {
          throw this.invalidChar(this.read())
        }
        return '\0'
      case 'x':
        this.read()
        return this.hexEscape()
      case 'u':
        this.read()
        return this.unicodeEscape()
      case '\n':
      case '\u2028':
      case '\u2029':
        this.read()
        return ''
      case '\r':
        this.read()
        if (this.peek() === '\n') {
          this.read()
        }
        return ''
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
        throw this.invalidChar(this.read())
      case undefined:
        throw this.invalidChar(this.read())
    }

    return this.read()!
  }

  hexEscape(): string {
    let buffer = ''
    let c = this.peek()

    if (!isHexDigit(c)) {
      throw this.invalidChar(this.read())
    }
    buffer += this.read()

    c = this.peek()
    if (!isHexDigit(c)) {
      throw this.invalidChar(this.read())
    }
    buffer += this.read()

    return String.fromCodePoint(parseInt(buffer, 16))
  }

  unicodeEscape(): string {
    let buffer = ''
    let count = 4

    while (count-- > 0) {
      const c = this.peek()
      if (!isHexDigit(c)) {
        throw this.invalidChar(this.read())
      }
      buffer += this.read()
    }

    return String.fromCodePoint(parseInt(buffer, 16))
  }

  push(): void {
    let value: unknown

    switch (this.token.type) {
      case 'punctuator':
        switch (this.token.value) {
          case '{':
            value = {}
            break
          case '[':
            value = []
            break
        }
        break
      case 'null':
      case 'boolean':
      case 'numeric':
      case 'string':
        value = this.token.value
        break
    }

    if (this.root === undefined) {
      this.root = value
    } else {
      const parent = this.stack[this.stack.length - 1]
      if (Array.isArray(parent)) {
        parent.push(value)
      } else {
        Object.defineProperty(parent as object, this.key!, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        })
      }
    }

    if (value !== null && typeof value === 'object') {
      this.stack.push(value)
      this.parseState = Array.isArray(value) ? 'beforeArrayValue' : 'beforePropertyName'
    } else {
      const current = this.stack[this.stack.length - 1]
      if (current == null) {
        this.parseState = 'end'
      } else if (Array.isArray(current)) {
        this.parseState = 'afterArrayValue'
      } else {
        this.parseState = 'afterPropertyValue'
      }
    }
  }

  pop(): void {
    this.stack.pop()

    const current = this.stack[this.stack.length - 1]
    if (current == null) {
      this.parseState = 'end'
    } else if (Array.isArray(current)) {
      this.parseState = 'afterArrayValue'
    } else {
      this.parseState = 'afterPropertyValue'
    }
  }

  invalidChar(c: string | undefined): Json5SyntaxError {
    if (c === undefined) {
      return this.syntaxError(`JSON5: invalid end of input at ${this.line}:${this.column}`)
    }
    return this.syntaxError(`JSON5: invalid character '${formatChar(c)}' at ${this.line}:${this.column}`)
  }

  invalidEOF(): Json5SyntaxError {
    return this.syntaxError(`JSON5: invalid end of input at ${this.line}:${this.column}`)
  }

  invalidIdentifier(): Json5SyntaxError {
    this.column -= 5
    return this.syntaxError(`JSON5: invalid identifier character at ${this.line}:${this.column}`)
  }

  syntaxError(message: string): Json5SyntaxError {
    const err = new SyntaxError(message) as Json5SyntaxError
    err.lineNumber = this.line
    err.columnNumber = this.column
    return err
  }
}

const lexStates: Record<string, (p: Parser) => Token | undefined> = {
  default(p) {
    switch (p.c) {
      case '\t':
      case '\v':
      case '\f':
      case ' ':
      case '\u00A0':
      case '\uFEFF':
      case '\n':
      case '\r':
      case '\u2028':
      case '\u2029':
        p.read()
        return undefined

      case '/':
        p.read()
        p.lexState = 'comment'
        return undefined

      case undefined:
        p.read()
        return p.newToken('eof')
    }

    if (isSpaceSeparator(p.c)) {
      p.read()
      return undefined
    }

    return lexStates[p.parseState](p)
  },

  comment(p) {
    switch (p.c) {
      case '*':
        p.read()
        p.lexState = 'multiLineComment'
        return undefined
      case '/':
        p.read()
        p.lexState = 'singleLineComment'
        return undefined
    }
    throw p.invalidChar(p.read())
  },

  multiLineComment(p) {
    switch (p.c) {
      case '*':
        p.read()
        p.lexState = 'multiLineCommentAsterisk'
        return undefined
      case undefined:
        throw p.invalidChar(p.read())
    }
    p.read()
    return undefined
  },

  multiLineCommentAsterisk(p) {
    switch (p.c) {
      case '*':
        p.read()
        return undefined
      case '/':
        p.read()
        p.lexState = 'default'
        return undefined
      case undefined:
        throw p.invalidChar(p.read())
    }
    p.read()
    p.lexState = 'multiLineComment'
    return undefined
  },

  singleLineComment(p) {
    switch (p.c) {
      case '\n':
      case '\r':
      case '\u2028':
      case '\u2029':
        p.read()
        p.lexState = 'default'
        return undefined
      case undefined:
        p.read()
        return p.newToken('eof')
    }
    p.read()
    return undefined
  },

  value(p) {
    switch (p.c) {
      case '{':
      case '[':
        return p.newToken('punctuator', p.read())

      case 'n':
        p.read()
        p.literal('ull')
        return p.newToken('null', null)

      case 't':
        p.read()
        p.literal('rue')
        return p.newToken('boolean', true)

      case 'f':
        p.read()
        p.literal('alse')
        return p.newToken('boolean', false)

      case '-':
      case '+':
        if (p.read() === '-') {
          p.sign = -1
        }
        p.lexState = 'sign'
        return undefined

      case '.':
        p.buffer = p.read()!
        p.lexState = 'decimalPointLeading'
        return undefined

      case '0':
        p.buffer = p.read()!
        p.lexState = 'zero'
        return undefined

      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
        p.buffer = p.read()!
        p.lexState = 'decimalInteger'
        return undefined

      case 'I':
        p.read()
        p.literal('nfinity')
        return p.newToken('numeric', Infinity)

      case 'N':
        p.read()
        p.literal('aN')
        return p.newToken('numeric', NaN)

      case '"':
      case "'":
        p.doubleQuote = p.read() === '"'
        p.buffer = ''
        p.lexState = 'string'
        return undefined
    }
    throw p.invalidChar(p.read())
  },

  identifierNameStartEscape(p) {
    if (p.c !== 'u') {
      throw p.invalidChar(p.read())
    }
    p.read()
    const u = p.unicodeEscape()
    switch (u) {
      case '$':
      case '_':
        break
      default:
        if (!isIdStartChar(u)) {
          throw p.invalidIdentifier()
        }
        break
    }
    p.buffer += u
    p.lexState = 'identifierName'
    return undefined
  },

  identifierName(p) {
    switch (p.c) {
      case '$':
      case '_':
      case '\u200C':
      case '\u200D':
        p.buffer += p.read()
        return undefined
      case '\\':
        p.read()
        p.lexState = 'identifierNameEscape'
        return undefined
    }

    if (isIdContinueChar(p.c)) {
      p.buffer += p.read()
      return undefined
    }

    return p.newToken('identifier', p.buffer)
  },

  identifierNameEscape(p) {
    if (p.c !== 'u') {
      throw p.invalidChar(p.read())
    }
    p.read()
    const u = p.unicodeEscape()
    switch (u) {
      case '$':
      case '_':
      case '\u200C':
      case '\u200D':
        break
      default:
        if (!isIdContinueChar(u)) {
          throw p.invalidIdentifier()
        }
        break
    }
    p.buffer += u
    p.lexState = 'identifierName'
    return undefined
  },

  sign(p) {
    switch (p.c) {
      case '.':
        p.buffer = p.read()!
        p.lexState = 'decimalPointLeading'
        return undefined

      case '0':
        p.buffer = p.read()!
        p.lexState = 'zero'
        return undefined

      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
        p.buffer = p.read()!
        p.lexState = 'decimalInteger'
        return undefined

      case 'I':
        p.read()
        p.literal('nfinity')
        return p.newToken('numeric', p.sign * Infinity)

      case 'N':
        p.read()
        p.literal('aN')
        return p.newToken('numeric', NaN)
    }
    throw p.invalidChar(p.read())
  },

  zero(p) {
    switch (p.c) {
      case '.':
        p.buffer += p.read()
        p.lexState = 'decimalPoint'
        return undefined
      case 'e':
      case 'E':
        p.buffer += p.read()
        p.lexState = 'decimalExponent'
        return undefined
      case 'x':
      case 'X':
        p.buffer += p.read()
        p.lexState = 'hexadecimal'
        return undefined
    }
    return p.newToken('numeric', p.sign * 0)
  },

  decimalInteger(p) {
    switch (p.c) {
      case '.':
        p.buffer += p.read()
        p.lexState = 'decimalPoint'
        return undefined
      case 'e':
      case 'E':
        p.buffer += p.read()
        p.lexState = 'decimalExponent'
        return undefined
    }

    if (isDigit(p.c)) {
      p.buffer += p.read()
      return undefined
    }

    return p.newToken('numeric', p.sign * Number(p.buffer))
  },

  decimalPointLeading(p) {
    if (isDigit(p.c)) {
      p.buffer += p.read()
      p.lexState = 'decimalFraction'
      return undefined
    }
    throw p.invalidChar(p.read())
  },

  decimalPoint(p) {
    switch (p.c) {
      case 'e':
      case 'E':
        p.buffer += p.read()
        p.lexState = 'decimalExponent'
        return undefined
    }

    if (isDigit(p.c)) {
      p.buffer += p.read()
      p.lexState = 'decimalFraction'
      return undefined
    }

    return p.newToken('numeric', p.sign * Number(p.buffer))
  },

  decimalFraction(p) {
    switch (p.c) {
      case 'e':
      case 'E':
        p.buffer += p.read()
        p.lexState = 'decimalExponent'
        return undefined
    }

    if (isDigit(p.c)) {
      p.buffer += p.read()
      return undefined
    }

    return p.newToken('numeric', p.sign * Number(p.buffer))
  },

  decimalExponent(p) {
    switch (p.c) {
      case '+':
      case '-':
        p.buffer += p.read()
        p.lexState = 'decimalExponentSign'
        return undefined
    }

    if (isDigit(p.c)) {
      p.buffer += p.read()
      p.lexState = 'decimalExponentInteger'
      return undefined
    }

    throw p.invalidChar(p.read())
  },

  decimalExponentSign(p) {
    if (isDigit(p.c)) {
      p.buffer += p.read()
      p.lexState = 'decimalExponentInteger'
      return undefined
    }
    throw p.invalidChar(p.read())
  },

  decimalExponentInteger(p) {
    if (isDigit(p.c)) {
      p.buffer += p.read()
      return undefined
    }
    return p.newToken('numeric', p.sign * Number(p.buffer))
  },

  hexadecimal(p) {
    if (isHexDigit(p.c)) {
      p.buffer += p.read()
      p.lexState = 'hexadecimalInteger'
      return undefined
    }
    throw p.invalidChar(p.read())
  },

  hexadecimalInteger(p) {
    if (isHexDigit(p.c)) {
      p.buffer += p.read()
      return undefined
    }
    return p.newToken('numeric', p.sign * Number(p.buffer))
  },

  string(p) {
    switch (p.c) {
      case '\\':
        p.read()
        p.buffer += p.escape()
        return undefined

      case '"':
        if (p.doubleQuote) {
          p.read()
          return p.newToken('string', p.buffer)
        }
        p.buffer += p.read()
        return undefined

      case "'":
        if (!p.doubleQuote) {
          p.read()
          return p.newToken('string', p.buffer)
        }
        p.buffer += p.read()
        return undefined

      case '\n':
      case '\r':
        throw p.invalidChar(p.read())

      case '\u2028':
      case '\u2029':
        // Legal JSON5, illegal ES5 — the reference warns here; we accept silently.
        break

      case undefined:
        throw p.invalidChar(p.read())
    }

    p.buffer += p.read()
    return undefined
  },

  start(p) {
    switch (p.c) {
      case '{':
      case '[':
        return p.newToken('punctuator', p.read())
    }
    p.lexState = 'value'
    return undefined
  },

  beforePropertyName(p) {
    switch (p.c) {
      case '$':
      case '_':
        p.buffer = p.read()!
        p.lexState = 'identifierName'
        return undefined

      case '\\':
        p.read()
        p.lexState = 'identifierNameStartEscape'
        return undefined

      case '}':
        return p.newToken('punctuator', p.read())

      case '"':
      case "'":
        p.doubleQuote = p.read() === '"'
        p.lexState = 'string'
        return undefined
    }

    if (isIdStartChar(p.c)) {
      p.buffer += p.read()
      p.lexState = 'identifierName'
      return undefined
    }

    throw p.invalidChar(p.read())
  },

  afterPropertyName(p) {
    if (p.c === ':') {
      return p.newToken('punctuator', p.read())
    }
    throw p.invalidChar(p.read())
  },

  beforePropertyValue(p) {
    p.lexState = 'value'
    return undefined
  },

  afterPropertyValue(p) {
    switch (p.c) {
      case ',':
      case '}':
        return p.newToken('punctuator', p.read())
    }
    throw p.invalidChar(p.read())
  },

  beforeArrayValue(p) {
    if (p.c === ']') {
      return p.newToken('punctuator', p.read())
    }
    p.lexState = 'value'
    return undefined
  },

  afterArrayValue(p) {
    switch (p.c) {
      case ',':
      case ']':
        return p.newToken('punctuator', p.read())
    }
    throw p.invalidChar(p.read())
  },

  end(p) {
    throw p.invalidChar(p.read())
  },
}

const parseStates: Record<string, (p: Parser) => void> = {
  start(p) {
    if (p.token.type === 'eof') {
      throw p.invalidEOF()
    }
    p.push()
  },

  beforePropertyName(p) {
    switch (p.token.type) {
      case 'identifier':
      case 'string':
        p.key = p.token.value as string
        p.parseState = 'afterPropertyName'
        return
      case 'punctuator':
        p.pop()
        return
      case 'eof':
        throw p.invalidEOF()
    }
  },

  afterPropertyName(p) {
    if (p.token.type === 'eof') {
      throw p.invalidEOF()
    }
    p.parseState = 'beforePropertyValue'
  },

  beforePropertyValue(p) {
    if (p.token.type === 'eof') {
      throw p.invalidEOF()
    }
    p.push()
  },

  beforeArrayValue(p) {
    if (p.token.type === 'eof') {
      throw p.invalidEOF()
    }
    if (p.token.type === 'punctuator' && p.token.value === ']') {
      p.pop()
      return
    }
    p.push()
  },

  afterPropertyValue(p) {
    if (p.token.type === 'eof') {
      throw p.invalidEOF()
    }
    switch (p.token.value) {
      case ',':
        p.parseState = 'beforePropertyName'
        return
      case '}':
        p.pop()
    }
  },

  afterArrayValue(p) {
    if (p.token.type === 'eof') {
      throw p.invalidEOF()
    }
    switch (p.token.value) {
      case ',':
        p.parseState = 'beforeArrayValue'
        return
      case ']':
        p.pop()
    }
  },

  end() {
    // Reached only with an eof token; the `end` lex state rejects anything else.
  },
}

function formatChar(c: string): string {
  const replacements: Record<string, string> = {
    "'": "\\'",
    '"': '\\"',
    '\\': '\\\\',
    '\b': '\\b',
    '\f': '\\f',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
    '\v': '\\v',
    '\0': '\\0',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  }

  if (replacements[c]) {
    return replacements[c]
  }

  if (c < ' ') {
    const hexString = c.charCodeAt(0).toString(16)
    return '\\x' + ('00' + hexString).substring(hexString.length)
  }

  return c
}

/**
 * Parse JSON5 text. Accepts the full JSON5 grammar (comments, unquoted keys,
 * single quotes, trailing commas, hex, leading/trailing decimal points, +/-,
 * Infinity, NaN, escaped and multi-line strings).
 *
 * @throws {SyntaxError} with `lineNumber`/`columnNumber` on malformed input.
 */
export function parseJson5(text: string): unknown {
  const p = new Parser(String(text))

  do {
    p.token = p.lex()
    parseStates[p.parseState](p)
  } while (p.token.type !== 'eof')

  return p.root
}

const RE_BARE_KEY = /^[A-Za-z_$][\w$]*$/

const STRING_REPLACEMENTS: Record<string, string> = {
  "'": "\\'",
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
  '\0': '\\0',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}

/** Canonical single-quoted JSON5 string. */
function quoteString(value: string): string {
  let product = ''

  for (let i = 0; i < value.length; i++) {
    const c = value[i]

    // `\0` followed by a digit would read back as a legacy octal escape.
    if (c === '\0' && isDigit(value[i + 1])) {
      product += '\\x00'
      continue
    }

    const replacement = STRING_REPLACEMENTS[c]
    if (replacement) {
      product += replacement
      continue
    }

    if (c < ' ') {
      const hexString = c.charCodeAt(0).toString(16)
      product += '\\x' + ('00' + hexString).substring(hexString.length)
      continue
    }

    product += c
  }

  return "'" + product + "'"
}

function serializeKey(key: string): string {
  return RE_BARE_KEY.test(key) ? key : quoteString(key)
}

function serializeValue(value: unknown, stack: object[]): string | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON: (key?: string) => unknown }).toJSON()
  }

  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'

    case 'number':
      // String(-0) is '0'; JSON5 reads '-0' back as -0, so keep the sign.
      return Object.is(value, -0) ? '-0' : String(value)

    case 'string':
      return quoteString(value)

    case 'bigint':
      throw new TypeError('nr-json5: cannot serialize a BigInt to JSON5')

    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
  }

  const object = value as object

  if (stack.indexOf(object) >= 0) {
    throw new TypeError('nr-json5: converting circular structure to JSON5')
  }
  stack.push(object)

  let result: string

  if (Array.isArray(object)) {
    // Явный обход до length: Array.map пропускает дырки разреженного массива —
    // [ , ] терял длину и выдавал невалидный JSON5. Дырка → null, как в JSON.stringify.
    const arr = object as unknown[]
    const parts: string[] = []
    for (let i = 0; i < arr.length; i++) parts.push(serializeValue(arr[i], stack) ?? 'null')
    result = '[' + parts.join(', ') + ']'
  } else {
    const parts: string[] = []
    for (const key of Object.keys(object)) {
      const serialized = serializeValue((object as Record<string, unknown>)[key], stack)
      if (serialized !== undefined) {
        parts.push(serializeKey(key) + ': ' + serialized)
      }
    }
    result = '{' + parts.join(', ') + '}'
  }

  stack.pop()
  return result
}

/**
 * Serialize a value as canonical relaxed JSON5 on a single line: bare keys where
 * the key is an ASCII identifier, single-quoted strings, one space after `:` and
 * `,`, no trailing commas. Deterministic — two callers emit identical bytes.
 *
 * Mirrors JSON semantics for `toJSON`, and for `undefined`/functions/symbols
 * (dropped from objects, `null` inside arrays).
 *
 * @throws {TypeError} on a circular structure, a BigInt, or a top-level value
 *   with no JSON5 representation.
 */
export function stringifyJson5(value: unknown): string {
  const result = serializeValue(value, [])
  if (result === undefined) {
    throw new TypeError(`nr-json5: cannot serialize ${typeof value} to JSON5`)
  }
  return result
}
