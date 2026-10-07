import {
  Pipeline,
  compose,
  type ExtensionMiddleware,
  type Middleware,
  type PipelineOptions,
  type RhythmInputArgs,
} from "@rhythmjs/rhythm";
import type { Next, RegisterCallback } from "@rhythmjs/rhythm/types";

export interface CronJobInfo {
  readonly name: string;
  readonly schedule: string;
  readonly tz: string | undefined;
}

export type CronContext<T extends object> = T & {
  readonly job: CronJobInfo & { readonly firedAt: Date };
};

export type CronHandler<T extends object> = (ctx: CronContext<T>, next: Next) => unknown | Promise<unknown>;

export type CronHandlers<T extends object> = [CronHandler<T>, ...CronHandler<T>[]];

export type CronSchedule = Bun.CronWithAutocomplete | { schedule: Bun.CronWithAutocomplete; tz?: string };

export interface RhythmCronOptions extends PipelineOptions {
  tz?: string;
  onError?(error: unknown, ctx: CronContext<any>): void;
  unref?: boolean;
}

interface Job {
  info: CronJobInfo;
  run: Middleware<any>;
}

export class RhythmCron<I extends object = {}, D extends object = {}> extends Pipeline<CronContext<I & D>> {
  declare readonly "~input"?: I;

  readonly #jobs = new Map<string, Job>();
  readonly #scheduled = new Map<string, Bun.CronJob>();
  readonly #options: Pick<RhythmCronOptions, "tz" | "onError" | "unref">;
  #input: I | undefined;

  constructor({ tz, onError, unref, ...options }: RhythmCronOptions = {}) {
    super({ type: "cron", ...options });
    this.#options = { tz, onError, unref };
  }

  override use<U extends object>(middleware: ExtensionMiddleware<CronContext<I & D>, U>): RhythmCron<I, D & U>;
  override use(middleware: Middleware<CronContext<I & D>>): this;
  override use(middleware: Middleware<CronContext<I & D>>) {
    return super.use(middleware);
  }

  cron<U extends object>(
    name: string,
    schedule: CronSchedule,
    middleware: ExtensionMiddleware<CronContext<I & D>, U>,
    ...handlers: CronHandler<I & D & U>[]
  ): this;
  cron(name: string, schedule: CronSchedule, ...handlers: CronHandlers<I & D>): this;
  cron(name: string, schedule: CronSchedule, ...handlers: Middleware<any>[]): this {
    if (this.#jobs.has(name)) throw new TypeError(`cron job "${name}" is already registered`);
    const { schedule: expression, tz = this.#options.tz } = typeof schedule === "string" ? { schedule } : schedule;
    if (Bun.cron.parse(expression, undefined, { tz }) === null) {
      throw new TypeError(`cron job "${name}": "${expression}" never fires`);
    }
    this.#jobs.set(name, { info: { name, schedule: expression, tz }, run: compose(handlers) });
    return this;
  }

  get jobs(): readonly CronJobInfo[] {
    return [...this.#jobs.values()].map((job) => job.info);
  }

  get running(): boolean {
    return this.#scheduled.size > 0;
  }

  next(name: string, from?: Date | number): Date | null {
    const { info } = this.#job(name);
    return Bun.cron.parse(info.schedule, from, { tz: info.tz });
  }

  async run(name: string, ...input: RhythmInputArgs<I>): Promise<CronContext<I & D>> {
    const job = this.#job(name);
    const ctx = { ...(input[0] ?? this.#input), job: { ...job.info, firedAt: new Date() } } as CronContext<I & D>;
    await this.#execute(job, ctx);
    return ctx;
  }

  start(...input: RhythmInputArgs<I>): this {
    if (this.running) return this;
    this.#input = input[0];
    for (const [name, { info }] of this.#jobs) {
      const scheduled = Bun.cron(info.schedule, () => this.#fire(name), { tz: info.tz });
      if (this.#options.unref) scheduled.unref();
      this.#scheduled.set(name, scheduled);
    }
    return this;
  }

  stop(): this {
    for (const scheduled of this.#scheduled.values()) scheduled.stop();
    this.#scheduled.clear();
    return this;
  }

  [Symbol.dispose](): void {
    this.stop();
  }

  override callback() {
    return async (input: I) => {
      this.start(...([input] as unknown as RhythmInputArgs<I>));
      return input;
    };
  }

  async #execute(job: Job, ctx: CronContext<I & D>): Promise<void> {
    await this.chain()(ctx, async () => {
      await job.run(ctx, async () => {});
    });
  }

  #job(name: string): Job {
    const job = this.#jobs.get(name);
    if (!job) throw new RangeError(`no cron job named "${name}"`);
    return job;
  }

  async #fire(name: string): Promise<void> {
    const ctx = { ...this.#input, job: { ...this.#job(name).info, firedAt: new Date() } } as CronContext<I & D>;
    try {
      await this.#execute(this.#job(name), ctx);
    } catch (error) {
      (this.#options.onError ?? defaultOnError)(error, ctx);
    }
  }
}

function defaultOnError(error: unknown, ctx: CronContext<any>): void {
  console.error(`cron job "${ctx.job.name}" failed`, error);
}

export function startCron<I extends object = {}, T extends object = {}>(
  plugin: RhythmCron<I, any> & (T extends I ? unknown : never),
): RegisterCallback<T> {
  return (ctx, app) => {
    plugin.start(...([ctx] as unknown as RhythmInputArgs<I>));
    app.register(
      () => {},
      () => void plugin.stop(),
    );
  };
}
