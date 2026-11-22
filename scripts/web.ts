import { currentBudget, withFetchBudget } from "./budget";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import * as cheerio from "cheerio";
import { safeFetch } from "./network";
import { downloadImage } from "./images";
import { sanitizeContent, textCount, toMarkdown } from "./content";
import { FetchFailure, type Asset, type ExtractionMeta, type Snapshot } from "./types";

function publishedTime(document: Document, readableTime: string | null | undefined, meta: ExtractionMeta) {
  let selected: string | null = null;
  for (const [source, value] of [
    ["Readability/JSON-LD", readableTime],
    ["article:published_time", document.querySelector('meta[property="article:published_time"]')?.getAttribute("content")],
    ["datePublished", document.querySelector('[itemprop="datePublished"]')?.getAttribute("content") || document.querySelector('time[itemprop="datePublished"]')?.getAttribute("datetime")],
  ]) {
    const raw = value?.trim();
    if (!raw) { meta.timeAttempts.push({ source: source!, outcome: "missing" }); continue; }
    // Require an explicit calendar date; do not turn bare numbers or relative words into dates.
    const calendar = new Date(raw.slice(0, 10));
    const validCalendar = Number.isFinite(calendar.valueOf()) && calendar.toISOString().slice(0, 10) === raw.slice(0, 10);
    const parsed = validCalendar && /^\d{4}-\d{2}-\d{2}(?:T|\s|$)/.test(raw) ? new Date(raw) : new Date(NaN);
    if (!Number.isFinite(parsed.valueOf())) meta.timeAttempts.push({ source: source!, outcome: "invalid", value: raw });
    else if (selected) meta.timeAttempts.push({ source: source!, outcome: "not_used", value: raw });
    else { selected = parsed.toISOString(); meta.selectedTimeSource = source!; meta.timeAttempts.push({ source: source!, outcome: "selected", value: raw }); }
  }
  return selected;
}

export function inspectWebPage(document: Document, status: number, meta: ExtractionMeta) {
  const heading = [document.title, ...Array.from(document.querySelectorAll("h1")).map(e => e.textContent)].join(" ").trim();
  const visible = document.body?.cloneNode(true) as HTMLElement | undefined;
  visible?.querySelectorAll("script,style,noscript").forEach(e => e.remove());
  const text = visible?.textContent?.replace(/\s+/g, " ").trim() || "";
  const gate = /just a moment|checking your browser|verify (?:that )?you are human|access denied|安全验证|访问验证|人机验证|访问受限|请求被拦截|访问过于频繁/i;
  if (status === 429 || gate.test(heading) || (text.length < 300 && !document.querySelector("article") && gate.test(text))) {
    meta.page!.diagnosis = "access_restricted";
    throw new FetchFailure("verification", "网站要求验证或限制访问，普通请求未取得正文");
  }
  if (status === 401 || status === 403 || /^(?:\s*(?:sign in|log in|登录|用户登录)\s*(?:[-|—].*)?)$/i.test(document.title)) {
    meta.page!.diagnosis = "access_restricted";
    throw new FetchFailure("permission", `网页需要登录或没有访问权限（HTTP ${status}）`);
  }
  if (status === 404 || status === 410 || /^(?:404\b|page not found|页面不存在|文章已删除)/i.test(heading)) throw new FetchFailure("deleted", "网页已删除或不存在");
  if (status < 200 || status >= 300) throw new FetchFailure("unreachable", `网页返回 HTTP ${status}`);
  // Explicit structured paywall declarations: never mistake an available teaser for the full article.
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const value = JSON.parse(script.textContent || "null");
      const entries = Array.isArray(value) ? value : [value, ...(Array.isArray(value?.["@graph"]) ? value["@graph"] : [])];
      if (entries.some(entry => entry && /Article|BlogPosting/.test(String(entry["@type"])) && [false, "false"].includes(entry.isAccessibleForFree))) {
        meta.page!.diagnosis = "access_restricted";
        throw new FetchFailure("permission", "网页标明正文需要订阅或付费，未将预览内容保存为完整文章");
      }
    } catch (error) { if (error instanceof FetchFailure) throw error; }
  }
  if (!text || (text.length < 120 && /enable javascript|javascript is required|请启用\s*javascript|加载中|loading\.\.\./i.test(text + " " + (document.querySelector("noscript")?.textContent || "")))) {
    meta.page!.diagnosis = "dynamic_suspected";
    throw new FetchFailure("parse", "普通请求未取得正文，页面可能依赖 JavaScript；当前不执行页面脚本");
  }
}

export async function extractWeb(itemId: string, url: string, meta: ExtractionMeta, progress: (meta: ExtractionMeta) => void, stage: "wechat" | "generic" = "generic", fetchPage: typeof safeFetch = safeFetch): Promise<Snapshot> {
  if (!currentBudget()) return withFetchBudget(meta, () => extractWeb(itemId, url, meta, progress, stage, fetchPage));
  if (stage !== "generic") throw new FetchFailure("parse", "普通网页任务的提取阶段无效", { retryable: false });
  meta.extractor = "web-readability"; meta.version = "1.0.0"; meta.resourceLimitations = [];
  const response = await fetchPage(url, { trace: meta.articleRequests });
  const contentType = String(response.headers["content-type"] || "");
  meta.page = { status: response.status, finalUrl: response.finalUrl, contentType, diagnosis: "no_body" };
  progress(meta);
  if (contentType && !/^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType)) {
    if (response.status === 429) { meta.page.diagnosis = "access_restricted"; throw new FetchFailure("verification", "网站限制访问（HTTP 429）"); }
    if ([401, 403].includes(response.status)) { meta.page.diagnosis = "access_restricted"; throw new FetchFailure("permission", `网页访问被拒绝（HTTP ${response.status}）`); }
    if ([404, 410].includes(response.status)) throw new FetchFailure("deleted", "网页已删除或不存在");
    if (response.status >= 500) throw new FetchFailure("unreachable", `网页返回 HTTP ${response.status}`);
    meta.page.diagnosis = "non_html";
    throw new FetchFailure("parse", "资源限制：只支持 HTML 网页，暂不支持 PDF、文件或接口响应", { retryable: false });
  }
  // A Buffer lets JSDOM honor HTTP charset, BOM and meta charset. Scripts/resources remain disabled.
  const dom = new JSDOM(response.body, { url: response.finalUrl, contentType: contentType || "text/html", virtualConsole: new VirtualConsole() });
  try {
    const document = dom.window.document;
    inspectWebPage(document, response.status, meta);
    // Resolve lazy images before Readability discards their containing picture/source nodes.
    for (const image of document.querySelectorAll("img")) {
      const candidates = image.getAttribute("data-srcset") || image.getAttribute("srcset") || image.closest("picture")?.querySelector("source[srcset]")?.getAttribute("srcset");
      const largest = candidates?.split(",").map(part => part.trim().split(/\s+/)).sort((a, b) => (parseFloat(b[1]) || 1) - (parseFloat(a[1]) || 1))[0]?.[0];
      const source = image.getAttribute("data-src") || image.getAttribute("data-original") || image.getAttribute("data-lazy-src") || largest || image.getAttribute("src");
      if (source) { try { image.setAttribute("src", new URL(source, document.baseURI).href); } catch { /* Recorded as a rejected image below. */ } }
      image.removeAttribute("srcset");
    }
    for (const resource of document.querySelectorAll("article svg, main svg, article img, main img")) {
      const source = resource.tagName.toLowerCase() === "svg" ? "inline:svg" : resource.getAttribute("src") || "";
      if (source === "inline:svg" || /\.svg(?:[?#]|$)/i.test(source)) {
        meta.resourceLimitations.push({ source, reason: "资源限制：原网页文章区域包含 SVG，本阶段不保存 SVG（含未被正文提取选中的资源）" });
      }
    }
    const article = new Readability(document.cloneNode(true) as Document, { keepClasses: true, maxElemsToParse: 100_000 }).parse();
    if (!article?.content || !article.textContent?.trim()) throw new FetchFailure("parse", "已取得页面，但 Readability 未找到可保存的正文");
    const publishedAt = publishedTime(document, article.publishedTime, meta);
    const $ = cheerio.load(article.content);
    $("script,style,iframe,object,embed,form").remove();
    $("svg").each(() => { meta.resourceLimitations!.push({ source: "inline:svg", reason: "资源限制：暂不支持 SVG 图片" }); });
    $("svg").remove();
    meta.textSourceChars = textCount($("body").html() || "");
    const urls = new Map<string, number>();
    $("img").each((_, image) => {
      const source = $(image).attr("src") || "invalid:missing-image-url";
      urls.set(source, (urls.get(source) || 0) + 1); meta.imagesTotal++;
    });
    currentBudget()!.countImages(meta.imagesTotal);
    const saved: Asset[] = [];
    const queue = [...urls.entries()]; let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (cursor < queue.length) {
        currentBudget()!.check();
        const [source, count] = queue[cursor++];
        const downloaded = await downloadImage(itemId, source, count, result => {
          const index = meta.images.findIndex(image => image.originalUrl === source);
          if (index < 0) meta.images.push(result); else meta.images[index] = result;
          progress(meta);
        }, fetchPage, new URL(response.finalUrl).origin + "/");
        if (downloaded.asset) { saved.push(downloaded.asset); meta.imagesSaved += count; }
        for (const attempt of downloaded.result.attempts) if (attempt.reason?.startsWith("资源限制：")) meta.resourceLimitations!.push({ source, reason: attempt.reason });
      }
    }));
    const byUrl = new Map(saved.map(asset => [asset.originalUrl, asset]));
    $("img").each((_, image) => {
      const asset = byUrl.get($(image).attr("src") || "");
      if (asset) $(image).attr("src", asset.relativePath); else $(image).remove();
    });
    const snapshotHtml = sanitizeContent($("body").html() || "");
    const snapshotMd = toMarkdown(snapshotHtml);
    if (!snapshotMd.trim()) throw new FetchFailure("parse", "净化后没有可保存的正文");
    meta.textSavedChars = textCount(snapshotHtml);
    meta.textCoverage = meta.textSourceChars ? Math.min(1, meta.textSavedChars / meta.textSourceChars) : 1;
    meta.page.diagnosis = "article"; progress(meta);
    return { title: article.title?.trim() || document.title || new URL(response.finalUrl).hostname, author: article.byline?.trim() || null, publishedAt, snapshotHtml, snapshotMd, assets: saved, meta };
  } finally { dom.window.close(); }
}
