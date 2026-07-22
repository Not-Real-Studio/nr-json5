# nr-json5

A JSON5 reader and a canonical single-line writer, with no dependencies and nothing else in the box.

```js
import { parseJson5, stringifyJson5 } from '@notrealstudio/nr-json5'

parseJson5("{ model: 'gpt-4o', /* trailing commas fine */ steps: 30, }")
// → { model: 'gpt-4o', steps: 30 }

stringifyJson5({ model: 'gpt-4o', steps: 30 })
// → "{model: 'gpt-4o', steps: 30}"
```

The reader is a port of the reference implementation (json5 2.2.3, MIT) — the same state machine, so the official `json5-tests` suite stays green: comments, unquoted keys, single quotes, trailing commas, hex, leading and trailing decimal points, `+`/`-`, `Infinity`, `NaN`, escaped and multi-line strings. Two deliberate departures: identifier and space character classes use Unicode property escapes instead of the reference's 15 KB of tables frozen at Unicode 9, and there is no `reviver` — parser state is per-instance rather than module-global.

The writer is not a port. It emits canonical relaxed JSON5 on one line: bare keys where the key is an ASCII identifier, single-quoted strings, one space after `:` and `,`, no trailing comma. Deterministic — two callers emit identical bytes, which is what makes it safe to diff, to compare, and to embed in a line-oriented format. It mirrors JSON semantics for `toJSON`, and for `undefined`, functions and symbols (dropped from objects, `null` inside arrays); it throws a `TypeError` on a circular structure, on a BigInt, and on a top-level value with no JSON5 representation.

## Install

```sh
npm install @notrealstudio/nr-json5
```

Zero dependencies, no host APIs — Node, browsers, Google Apps Script, userscripts, anywhere with a modern JS engine. A parse error is a `SyntaxError` carrying `lineNumber` and `columnNumber`, so you can point at the offending character.

## License

MIT. The reader derives from json5 (c) 2012-2018 Aseem Kishore and others, also MIT.
