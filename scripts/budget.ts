import { AsyncLocalStorage } from "node:async_hooks";
import { FetchFailure, type ExtractionMeta } from "./types";

export const FETCH_LIMITS = { images: 200, bytes: 128 * 1024 * 1024, taskMs: 300_000, dnsMs: 5000 };
export function resourceFailure(reason: string) {
  return new FetchFailure("parse", `资源限制：${reason}`, { retryable: false, abortArticle: true });
}
export class FetchBudget {
  readonly controller = new AbortController();
  private bytes = 0;
  private readonly started = Date.now();
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(readonly limits = FETCH_LIMITS) {
    this.timer = setTimeout(() => this.controller.abort(resourceFailure(`整篇抓取超过 ${limits.taskMs / 1000} 秒`)), limits.taskMs);
  }
  check() {
    if (Date.now() - this.started >= this.limits.taskMs && !this.controller.signal.aborted) this.controller.abort(resourceFailure(`整篇抓取超过 ${this.limits.taskMs / 1000} 秒`));
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
  }
  fail(reason: string): never { const error = resourceFailure(reason); this.controller.abort(error); throw error; }
  countImages(count: number) { this.check(); if (count > this.limits.images) this.fail(`每篇图片数 ${count} 超过上限 ${this.limits.images}`); }
  charge(bytes: number) { this.check(); this.bytes += bytes; if (this.bytes > this.limits.bytes) this.fail(`整篇累计下载字节 ${this.bytes} 超过上限 ${this.limits.bytes}`); }
  stop() { clearTimeout(this.timer); this.controller.abort(resourceFailure("抓取已结束")); }
}
const context = new AsyncLocalStorage<FetchBudget>();
export const currentBudget = () => context.getStore();
export async function withFetchBudget<T>(meta: ExtractionMeta, run: () => Promise<T>, limits = FETCH_LIMITS): Promise<T> {
  const budget = new FetchBudget(limits);
  try { return await context.run(budget, async () => { const result = await run(); budget.check(); return result; }); }
  catch (error) {
    if (error instanceof FetchFailure && error.detail.abortArticle) (meta.resourceLimitations ??= []).push({ source: "article", reason: error.message });
    throw error;
  } finally { budget.stop(); }
}
