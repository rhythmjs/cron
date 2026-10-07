import { Rhythm, decorate } from "@rhythmjs/rhythm";
import { RhythmCron, startCron } from "@rhythmjs/cron";

const db = {
  sessions: 12,
  async deleteExpiredSessions() {
    this.sessions -= 5;
    return 5;
  },
};

const cron = new RhythmCron<{ db: typeof db }>({ tz: "UTC", unref: true })
  .use(async (ctx, next) => {
    const started = performance.now();
    await next();
    console.log(`[${ctx.job.name}] finished in ${Math.round(performance.now() - started)}ms`);
  })
  .cron("cleanup", "0 3 * * *", async (ctx) => {
    console.log(`[cleanup] removed ${await ctx.db.deleteExpiredSessions()} sessions`);
  })
  .cron("report", { schedule: "30 9 * * MON-FRI", tz: "America/New_York" }, (ctx) => {
    console.log(`[report] ${ctx.db.sessions} sessions left`);
  })
  .cron("flaky", "*/15 * * * *", () => {
    throw new Error("upstream unreachable");
  });

const app = new Rhythm().register(decorate(() => ({ db }))).register(startCron(cron));
await app.callback()();

for (const { name, schedule, tz } of cron.jobs) {
  console.log(`${name}: "${schedule}" (${tz ?? "local"}), next at ${cron.next(name)?.toISOString()}`);
}

await cron.run("cleanup", { db });
await cron.run("report", { db });
await cron.run("flaky", { db }).catch((error: Error) => console.log(`[flaky] rejected: ${error.message}`));

await app.stop();
console.log(`stopped, running: ${cron.running}`);
