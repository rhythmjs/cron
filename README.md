# cron

Scheduled work for [Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend framework.

- **[`packages/cron`](./packages/cron)**: `@rhythmjs/cron`, named cron jobs on Bun's native `Bun.cron`, as a Rhythm
  pipeline: middleware around every run, started and stopped with the app.

## Examples

Small runnable programs in [`examples/`](./examples) (workspace members using `workspace:*`):

```sh
bun examples/cron/index.ts # jobs with middleware and time zones, run by hand, previewed with next(), stopped with the app
bun examples/cron-http/index.ts # jobs started with the app, plus HTTP routes to list and trigger them (PORT overrides :3003)
```

## Tooling

This is a **Bun workspace**: no pnpm, no vite-plus:

```sh
bun install # workspace install (bun.lock)
bun test # all packages, bun:test
bun run build # per package: bun build (ESM) + tsc (declarations)
bun run typecheck # tsc --noEmit per package
bun run lint # oxlint
bun run fmt # prettier
bun run check # fmt:check + lint + typecheck
```

`tsc` remains for type checking and `.d.ts` emission (Bun does not emit declarations), and
oxlint/prettier are root devDependencies executed by Bun, since Bun has no built-in linter or formatter
yet.

## Publishing

Each package publishes independently to npm from its own directory
(`cd packages/<name> && bun publish`); `prepublishOnly` runs typecheck, tests, and build.

## License

ISC
