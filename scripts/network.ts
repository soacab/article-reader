import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import ipaddr from "ipaddr.js";
import { FetchFailure, resourceRejection, type NetworkHop } from "./types";
import { currentBudget, FETCH_LIMITS } from "./budget";

export const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";
type Address = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<Address[]>;
export type CheckedTarget = { url: URL; address: string; family: number };
export type HttpResult = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
export type Transport = (target: CheckedTarget, headers: Record<string, string>, maxBytes: number) => Promise<HttpResult>;
const dnsResolve: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });
export function isPublicAddress(address: string) {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}
export async function checkPublicUrl(raw: string, resolver: Resolver = dnsResolve, dnsMs = FETCH_LIMITS.dnsMs): Promise<CheckedTarget> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new FetchFailure("unreachable", "链接格式无效", { retryable: false }); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) {
    throw new FetchFailure("unreachable", "只允许不含账号密码的标准 HTTP/HTTPS 地址", { retryable: false });
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || !hostname.includes(".") && !isIP(hostname)) {
    throw new FetchFailure("unreachable", "安全拒绝：本机或内部域名", { retryable: false });
  }
  let addresses: Address[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    currentBudget()?.check();
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
      resolver(hostname), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new FetchFailure("unreachable", `DNS 解析超过 ${dnsMs / 1000} 秒`)), dnsMs); }),
    ]);
    currentBudget()?.check();
  } catch (error) { if (error instanceof FetchFailure) throw error; throw new FetchFailure("unreachable", "域名解析失败"); }
  finally { clearTimeout(timer); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new FetchFailure("unreachable", "安全拒绝：目标含本机、内网或保留地址", { retryable: false });
  }
  const selected = addresses.find(a => a.family === 4) || addresses[0];
  return { url, ...selected };
}
export const directRequest = (target: CheckedTarget, headers: Record<string, string>, maxBytes: number, requestBody?: string): Promise<HttpResult> => new Promise((resolve, reject) => {
  const client = target.url.protocol === "https:" ? https : http;
  const budget = currentBudget();
  let settled = false;
  const finish = (error?: unknown, value?: HttpResult) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    budget?.controller.signal.removeEventListener("abort", abort);
    if (error) reject(error); else resolve(value!);
  };
  const abort = () => { finish(budget?.controller.signal.reason); req.destroy(); };
  // Pin the checked address; every redirect creates a fresh checked target.
  const requestOptions: https.RequestOptions & { autoSelectFamily: boolean } = {
    agent: false, headers, family: target.family, autoSelectFamily: false,
    lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
  };
  const req = client.request(target.url, { ...requestOptions, method: requestBody === undefined ? "GET" : "POST" }, response => {
    const chunks: Buffer[] = []; let bytes = 0;
    response.on("error", error => finish(error));
    if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
      finish(undefined, { status: response.statusCode!, headers: response.headers, body: Buffer.alloc(0) }); response.destroy(); return;
    }
    response.on("data", (chunk: Buffer) => {
      if (settled) return;
      try {
        budget?.charge(chunk.length); bytes += chunk.length;
        if (bytes > maxBytes) throw resourceRejection(`响应超过大小限制（${maxBytes} 字节）`);
        chunks.push(chunk);
      } catch (error) { finish(error); response.destroy(); req.destroy(); }
    });
    response.on("end", () => {
      if (settled) return;
      try {
        budget?.check();
        let body = Buffer.concat(chunks);
        const encoding = response.headers["content-encoding"];
        const options = { maxOutputLength: maxBytes };
        try {
          if (encoding === "gzip") body = gunzipSync(body, options);
          else if (encoding === "deflate") body = inflateSync(body, options);
          else if (encoding === "br") body = brotliDecompressSync(body, options);
          else if (encoding && encoding !== "identity") throw new Error("不支持的响应压缩方式");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
            // The bounded decoder stops before returning a body. Charge the
            // known expanded lower bound even when this image will be omitted.
            budget?.charge(Math.max(0, maxBytes + 1 - bytes));
            throw resourceRejection(`响应解压后超过大小限制（${maxBytes} 字节）`);
          }
          throw error;
        }
        // Each response costs max(wire bytes, expanded bytes), including failed attempts.
        budget?.charge(Math.max(0, body.length - bytes));
        finish(undefined, { status: response.statusCode || 0, headers: response.headers, body });
      } catch (error) { finish(error); }
    });
  });
  const timer = setTimeout(() => { finish(new FetchFailure("unreachable", "请求超过 25 秒")); req.destroy(); }, 25000);
  req.on("error", error => finish(error));
  budget?.controller.signal.addEventListener("abort", abort, { once: true });
  if (budget?.controller.signal.aborted) abort();
  else req.end(requestBody);
});
export async function safeFetch(raw: string, options: { referer?: string; maxBytes?: number; resolver?: Resolver; transport?: Transport; trace?: NetworkHop[] } = {}) {
  const trace = options.trace || []; let url = raw;
  currentBudget()?.check();
  try {
    for (let i = 0; i <= 5; i++) {
      const hop: NetworkHop = { url }; trace.push(hop);
      const target = await checkPublicUrl(url, options.resolver); hop.address = target.address;
      const headers: Record<string, string> = { "User-Agent": USER_AGENT, "Accept-Encoding": "identity", "Accept-Language": "zh-CN,zh;q=0.9" };
      if (options.referer) headers.Referer = options.referer;
      const response = await (options.transport || directRequest)(target, headers, options.maxBytes || 8 * 1024 * 1024);
      if (options.transport) {
        currentBudget()?.charge(response.body.length);
        if (response.body.length > (options.maxBytes || 8 * 1024 * 1024)) throw resourceRejection("响应超过大小限制");
      }
      currentBudget()?.check();
      hop.status = response.status;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.location) throw new Error("跳转缺少目标地址");
        url = new URL(response.headers.location, target.url).href; continue;
      }
      return { ...response, finalUrl: target.url.href, trace };
    }
    throw new Error("重定向次数过多");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (trace.length) trace[trace.length - 1].error = message;
    if (error instanceof FetchFailure) { error.detail.hops = trace; throw error; }
    throw new FetchFailure("unreachable", message, { hops: trace });
  }
}
