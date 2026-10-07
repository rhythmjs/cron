import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Rhythm, decorate, derive } from "@rhythmjs/rhythm";
import { RhythmCron, startCron } from "./rhythm-cron";

interface Scheduled {
  schedule: string;
  tz: string | undefined;
  fire: () => unknown;
  stopped: boolean;
  unref: boolean;
}

function fakeBunCron() {
  const scheduled: Scheduled[] = [];
  const { parse } = Bun.cron;
  const spy = spyOn(Bun, "cron").mockImplementation(((
    schedule: string,
    handler: () => unknown,
    options?: { tz?: string },
  ) => {
    const entry: Scheduled = { schedule, tz: options?.tz, fire: handler, stopped: false, unref: false };
    scheduled.push(entry);
    const job = {
      cron: schedule,
      stop: () => ((entry.stopped = true), job),
      ref: () => job,
      unref: () => ((entry.unref = true), job),
      [Symbol.dispose]: () => void (entry.stopped = true),
    };
    return job;
  }) as never);
  Object.assign(Bun.cron, { parse });
  return { scheduled, spy };
}

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("registering jobs", () => {
  test("validates the expression and time zone when the job is added", () => {
    const cron = new RhythmCron();
    expect(() => cron.cron("bad", "nope", () => {})).toThrow("Invalid cron expression");
    expect(() => cron.cron("tz", { schedule: "* * * * *", tz: "Mars/Base" }, () => {})).toThrow("unknown time zone");
    expect(() => cron.cron("never", "0 0 30 2 *", () => {})).toThrow("never fires");
    expect(cron.jobs).toEqual([]);
  });

  test("job names are unique", () => {
    const cron = new RhythmCron().cron("tick", "* * * * *", () => {});
    expect(() => cron.cron("tick", "@hourly", () => {})).toThrow('"tick" is already registered');
  });

  test("lists jobs, with the instance time zone as the default", () => {
    const cron = new RhythmCron({ tz: "UTC" })
      .cron("a", "@hourly", () => {})
      .cron("b", { schedule: "0 9 * * MON-FRI", tz: "America/New_York" }, () => {});

    expect(cron.jobs).toEqual([
      { name: "a", schedule: "@hourly", tz: "UTC" },
      { name: "b", schedule: "0 9 * * MON-FRI", tz: "America/New_York" },
    ]);
  });

  test("next() previews the fire time in the job's time zone", () => {
    const cron = new RhythmCron().cron("open", { schedule: "0 9 * * *", tz: "America/New_York" }, () => {});

    expect(cron.next("open", Date.UTC(2026, 9, 7))?.toISOString()).toBe("2026-10-07T13:00:00.000Z");
    expect(() => cron.next("missing")).toThrow(RangeError);
  });
});

describe("scheduling with Bun.cron", () => {
  test("start schedules every job with its expression and time zone; starting twice is a no-op", () => {
    const { scheduled, spy } = fakeBunCron();
    restore = () => spy.mockRestore();
    const cron = new RhythmCron({ tz: "UTC" })
      .cron("a", "@hourly", () => {})
      .cron("b", { schedule: "*/5 * * * *", tz: "Europe/Paris" }, () => {});

    cron.start().start();

    expect(cron.running).toBe(true);
    expect(scheduled.map(({ schedule, tz }) => ({ schedule, tz }))).toEqual([
      { schedule: "@hourly", tz: "UTC" },
      { schedule: "*/5 * * * *", tz: "Europe/Paris" },
    ]);
  });

  test("stop cancels every scheduled job, and the jobs can be started again", () => {
    const { scheduled, spy } = fakeBunCron();
    restore = () => spy.mockRestore();
    const cron = new RhythmCron().cron("a", "@hourly", () => {}).start();

    cron.stop();
    expect(scheduled[0]!.stopped).toBe(true);
    expect(cron.running).toBe(false);

    cron.start();
    expect(scheduled).toHaveLength(2);
    expect(cron.running).toBe(true);
  });

  test("unref lets the process exit while jobs are scheduled", () => {
    const { scheduled, spy } = fakeBunCron();
    restore = () => spy.mockRestore();

    new RhythmCron({ unref: true }).cron("a", "@hourly", () => {}).start();
    expect(scheduled[0]!.unref).toBe(true);
  });

  test("a fired job runs the middleware, then its handlers, with the input and the job info", async () => {
    const { scheduled, spy } = fakeBunCron();
    restore = () => spy.mockRestore();
    const seen: string[] = [];
    const cron = new RhythmCron<{ db: string }>()
      .use(async (ctx, next) => {
        seen.push(`before:${ctx.job.name}`);
        await next();
        seen.push("after");
      })
      .use(derive((ctx) => ({ label: `${ctx.db}/${ctx.job.name}` })))
      .cron("tick", "* * * * *", async (ctx, next) => {
        seen.push(ctx.label);
        expect(ctx.job).toMatchObject({ name: "tick", schedule: "* * * * *" });
        expect(ctx.job.firedAt).toBeInstanceOf(Date);
        await next();
      });

    cron.start({ db: "pg" });
    await scheduled[0]!.fire();

    expect(seen).toEqual(["before:tick", "pg/tick", "after"]);
  });

  test("a failing run goes to onError and the job stays scheduled", async () => {
    const { scheduled, spy } = fakeBunCron();
    restore = () => spy.mockRestore();
    const errors: [unknown, string][] = [];
    const cron = new RhythmCron({ onError: (error, ctx) => void errors.push([error, ctx.job.name]) }).cron(
      "flaky",
      "* * * * *",
      () => {
        throw new Error("db unreachable");
      },
    );

    cron.start();
    await expect(scheduled[0]!.fire()).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect((errors[0]![0] as Error).message).toBe("db unreachable");
    expect(errors[0]![1]).toBe("flaky");
    expect(cron.running).toBe(true);
  });

  test("without onError, failures are logged with console.error", async () => {
    const { scheduled, spy } = fakeBunCron();
    const log = spyOn(console, "error").mockImplementation(() => {});
    restore = () => (spy.mockRestore(), log.mockRestore());

    new RhythmCron()
      .cron("flaky", "* * * * *", () => {
        throw new Error("boom");
      })
      .start();
    await scheduled[0]!.fire();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toBe('cron job "flaky" failed');
  });
});

describe("run", () => {
  test("runs a job now with the given input, and rejects on failure", async () => {
    const calls: string[] = [];
    const cron = new RhythmCron<{ name: string }>()
      .cron("greet", "@daily", (ctx) => void calls.push(`hi ${ctx.name}`))
      .cron("fail", "@daily", () => {
        throw new Error("nope");
      });

    const ctx = await cron.run("greet", { name: "ada" });

    expect(calls).toEqual(["hi ada"]);
    expect(ctx.job.name).toBe("greet");
    await expect(cron.run("fail", { name: "ada" })).rejects.toThrow("nope");
    await expect(cron.run("missing", { name: "ada" })).rejects.toThrow(RangeError);
  });
});

describe("startCron", () => {
  test("starts with the app's startup context, sees dependencies registered later, and stops with the app", async () => {
    const { scheduled, spy } = fakeBunCron();
    restore = () => spy.mockRestore();
    const seen: string[] = [];
    const cron = new RhythmCron<{ db: string }>().cron("sync", "@hourly", (ctx) => void seen.push(ctx.db));

    const app = new Rhythm().register(decorate(() => ({ db: "pg" }))).register(startCron(cron));
    await app.callback()();
    await scheduled[0]!.fire();

    expect(seen).toEqual(["pg"]);
    expect(cron.running).toBe(true);

    await app.stop();
    expect(scheduled[0]!.stopped).toBe(true);
  });

  test("rejects an app that does not provide the context the jobs need", () => {
    const cron = new RhythmCron<{ db: string }>();
    // @ts-expect-error
    new Rhythm().register(startCron(cron));
    expect(true).toBe(true);
  });
});

test("works against the real Bun.cron: schedules, reports running, and stops", () => {
  const cron = new RhythmCron({ unref: true }).cron("tick", "* * * * *", () => {}).start();

  expect(cron.running).toBe(true);
  cron.stop();
  expect(cron.running).toBe(false);
});
