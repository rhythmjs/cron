import { Rhythm, decorate, mount } from "@rhythmjs/rhythm";
import { RhythmRouter } from "@rhythmjs/router";
import { toFetchHandler } from "@rhythmjs/router/fetch";
import { RhythmCron, startCron } from "@rhythmjs/cron";

const runs: Record<string, { at: string; ok: boolean }> = {};
const stats = { pings: 0 };

const cron = new RhythmCron<{ stats: typeof stats }>({
  onError: (error, ctx) => {
    runs[ctx.job.name] = { at: ctx.job.firedAt.toISOString(), ok: false };
    console.error(`${ctx.job.name} failed:`, error);
  },
})
  .use(async (ctx, next) => {
    await next();
    runs[ctx.job.name] = { at: ctx.job.firedAt.toISOString(), ok: true };
  })
  .cron("ping", "* * * * *", (ctx) => {
    ctx.stats.pings++;
  })
  .cron("digest", "@hourly", () => {
    console.log("digest sent");
  });

const api = new RhythmRouter()
  .get("/jobs", (ctx) => {
    ctx.json(
      cron.jobs.map((job) => ({ ...job, next: cron.next(job.name)?.toISOString(), last: runs[job.name] ?? null })),
    );
  })
  .post("/jobs/:name/run", async (ctx) => {
    if (!cron.jobs.some((job) => job.name === ctx.params.name)) return ctx.error(404, "No such job");
    await cron.run(ctx.params.name, { stats });
    ctx.json({ ok: true, pings: stats.pings });
  });

const app = new Rhythm()
  .register(decorate(() => ({ stats })))
  .register(startCron(cron))
  .use(mount(api));

const server = Bun.serve({ port: Number(process.env.PORT ?? 3003), fetch: toFetchHandler(app) });

console.log(`jobs listening on ${server.url}jobs`);
console.log(`trigger: curl -X POST ${server.url}jobs/ping/run`);

process.on("SIGINT", async () => {
  await app.stop();
  server.stop();
});
