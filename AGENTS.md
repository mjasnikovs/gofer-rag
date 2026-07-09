## Tests

Always run tests with `AGENT=1`:

```
AGENT=1 bun test
```

`bun run test` already sets `AGENT=1`. When you invoke `bun test` directly, you
must prefix it yourself.

## Code style

- One-line `if`: write single-statement conditionals on one line, no braces.
  `if (!user) return null`
- Prettier owns formatting: 4-space indent, no semicolons, single quotes, print
  width 120, no bracket spacing. Do not fight it — run the formatter.

## TypeScript types

- Do not inline object types. If a type is an object with more than 2
  properties, declare a named `type` and use it.
- Reuse before you create. Search the codebase for an existing type first; if
  one fits, import it. Only create a new type when none exists.
- Do not hand-write types for libraries. Check whether the library ships its own
  types (`@types/*` or bundled) and import those. Author a type only when the
  library exports none.

