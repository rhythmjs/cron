# @rhythmjs/cron

Cron for [Rhythm](https://github.com/rhythmjs/rhythm), the Bun-native backend framework, on [`Bun.cron`](https://bun.com/docs/api/cron) and nothing else. `RhythmCron` is a pipeline of named jobs, built like `RhythmRouter` and `RhythmWs`: the same `use()` middleware, the same handler chain, and a Rhythm app starts and stops it with `startCron`. There is no scheduler in this package: expressions are parsed and fired by Bun, which also guarantees a job never overlaps itself (the next fire is computed after the run settles).

## Example

```ts
import { Rhythm, decorate } from "@rhythmjs/rhythm";
import { RhythmCron, startCron } from "@rhythmjs/cron";

const cron = new RhythmCron<{ db: Db }>({ tz: "UTC" })
  .use(async (ctx, next) => {
    const started = performance.now();
    await next();
    console.log(`${ctx.job.name} took ${Math.round(performance.now() - started)}ms`);
  })
  .cron("cleanup", "0 3 * * *", async (ctx) => {
    await ctx.db.deleteExpiredSessions();
  })
  .cron("report", { schedule: "30 9 * * MON-FRI", tz: "America/New_York" }, async (ctx) => {
    await sendReport(ctx.db);
  });

const app = new Rhythm().register(decorate(() => ({ db: openDb() }))).register(startCron(cron));

await app.callback()(); // jobs are scheduled
// await app.stop();    // and cancelled with the app
```

## The surface

- **`new RhythmCron<I>(options?)`**: `I` is the context the jobs need from the app (database handle, services), checked by `startCron`. Options: `tz` (IANA time zone for every schedule, default the system's), `onError(error, ctx)`, `unref`, and `name` (labels failures; `type` defaults to `"cron"`).
- **`.cron(name, schedule, ...handlers)`**: a job. `schedule` is a 5-field expression or nickname (`"*/5 * * * *"`, `"@hourly"`, `"0 9 * * MON-FRI"`), or `{ schedule, tz }` to give one job its own time zone. The expression and time zone are validated when you register the job, not when it first fires, and a schedule that can never match (`"0 0 30 2 *"`) throws. Names are unique. Handlers are `(ctx, next)`, like route handlers, and the first may be extension middleware (`derive(...)`) that widens the context for the rest.
- **`.use(middleware)`**: wraps every run of every job, for timing, logging, locking, tracing. `derive(...)` and other extension middleware widen the context the jobs see.
- **`ctx`**: whatever the app supplies as input, plus `ctx.job`: `{ name, schedule, tz, firedAt }`.
- **`startCron(cron)`**: `app.register(startCron(cron))` starts the jobs with the app's startup context and registers a cleanup that stops them with `app.stop()`. The jobs read the context when they fire, so dependencies registered after this call are visible to them. The app must supply the context the jobs declared (`I`); a missing one is a compile error.
- **`.start(input?)` / `.stop()` / `.running`**: the same thing without an app. `start` is a no-op if already running; `stop` cancels every job and the same instance can start again. `RhythmCron` is `Disposable`, so `using cron = ...` stops it at scope exit. `callback()` is `start` in the `Mountable` shape.
- **`.run(name, input?)`**: runs a job's pipeline now, outside its schedule: a manual trigger from an HTTP route or a test. Errors reject here instead of going to `onError`, and the resolved value is the context the run used.
- **`.next(name, from?)`**: when a job fires next, in its time zone (`null` if never).
- **`.jobs`**: `{ name, schedule, tz }` for every registered job, for status pages and diagnostics.

## Errors

Bun's in-process cron matches `setTimeout`: an uncaught throw or rejection reaches `uncaughtException`/`unhandledRejection` and, with no listener, ends the process. `RhythmCron` catches runs itself and hands the error and its context to `onError` (default: `console.error`), then the job stays scheduled and fires again on its next match. Throw from `onError` yourself if you want a failed run to take the process down.

## In-process, not durable

These jobs live and die with the process, like `Bun.cron(schedule, handler)` itself: a run missed while the process was down is not replayed, and several replicas each fire every job. Take a lock in a `use()` middleware (Redis `SET NX`, a database row) when only one replica should run it. Under `bun --hot`, Bun stops in-process jobs before reloading and the re-evaluated module registers them again.

## Testing

Nothing waits for a real minute: call `cron.run("cleanup", { db })` to run a job through its middleware and handlers, `cron.next("cleanup", date)` to check its schedule, or replace `Bun.cron` with `spyOn(Bun, "cron")` to capture what `start` schedules, as this package's own tests do.

## Development

From the `cron` monorepo root:

```sh
bun install
bun test
bun run check # prettier, oxlint, tsc
bun run build # bun build + tsc declarations
```

See [`examples/cron`](../../examples/cron) and [`examples/cron-http`](../../examples/cron-http).
