import { currentBudget, withFetchBudget } from "./budget";
import * as cheerio from "cheerio";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { randomUUID } from "node:crypto";
import { safeFetch } from "./network";
import { inspectArticle, extractTime, sanitizeContent, toMarkdown, textCount } from "./content";
import { downloadImage } from "./images";
import { FetchFailure, type ExtractionMeta, type Snapshot, type Asset } from "./types";

export function emptyMeta(): ExtractionMeta {
  return { extractor: "wechat-http", version: "1.0.0", articleRequests: [], timeAttempts: [], selectedTimeSource: null,
    images: [], imagesTotal: 0, imagesSaved: 0, textSourceChars: 0, textSavedChars: 0, textCoverage: 0,
    textCoverageBasis: "取得页面中正文的可解析文本，与净化后正文比较；忽略空白。不代表与未取得的原文逐字核验。" };
}
export async function extractWechat(itemId: string, url: string, meta: ExtractionMeta, progress: (meta: ExtractionMeta) => void, stage: "wechat" | "generic" = "wechat", fetchPage: typeof safeFetch = safeFetch): Promise<Snapshot> {
  if (!currentBudget()) return withFetchBudget(meta, () => extractWechat(itemId, url, meta, progress, stage, fetchPage));
  const response = await fetchPage(url, { trace: meta.articleRequests });
  progress(meta);
  const html = response.body.toString("utf8");
  const { $: page, textPost, hasBody } = inspectArticle(html, response.finalUrl, response.status, stage === "wechat");
  let $ = page;
  let title = textPost?.title ?? $("#activity-name").text().trim();
  let author = $("meta[name='author']").attr("content")?.trim() || $("#js_name").text().trim() || null;
  if (textPost) {
    meta.extractor = "wechat-text-post";
    $ = cheerio.load('<div id="js_content"></div>');
    const content = $("#js_content");
    const body = textPost.body.replace(/\r\n?/g, "\n");
    for (const paragraph of body.split(/\n{2,}/)) {
      const p = $("<p></p>");
      paragraph.split("\n").forEach((line, index) => {
        if (index) p.append("<br>");
        p.append($("<span></span>").text(line));
      });
      content.append(p);
    }
  } else if (stage === "generic" && !hasBody) {
    meta.extractor = "wechat-readability";
    // JSDOM defaults disable scripts and external subresources; never opt into either.
    const dom = new JSDOM(html, { url: response.finalUrl });
    try {
      const article = new Readability(dom.window.document).parse();
      if (!article?.content || !article.textContent?.trim() || !article.title?.trim()) throw new FetchFailure("parse", "通用兜底仍未找到有效正文");
      title = article.title.trim(); author ||= article.byline?.trim() || null;
      $ = cheerio.load('<div id="js_content"></div>');
      $("#js_content").html(article.content);
    } finally { dom.window.close(); }
  }
  const time = extractTime(html, textPost?.publishedAt); meta.timeAttempts = time.attempts; meta.selectedTimeSource = time.source;
  const content = $("#js_content");
  content.find("script,style,iframe,object,embed,mpvoice,mpvideo,mp-miniprogram,vote").remove();
  meta.textSourceChars = textCount(content.html() || "");
  content.find(".code-snippet__line-index").remove();
  content.find(".code-snippet__fix").each((_, element) => {
    const lines = $(element).find("code").map((__, e) => $(e).text()).get();
    const language = $(element).find("pre[data-lang]").attr("data-lang") || "";
    if (lines.length) {
      const pre = $("<pre></pre>"); const code = $("<code></code>").text(lines.join("\n"));
      if (/^[a-z0-9_+-]+$/i.test(language)) code.attr("class", `language-${language}`);
      pre.append(code); $(element).replaceWith(pre);
    }
  });
  const imageUrls = new Map<string, number>();
  content.find("img").each((_, element) => {
    meta.imagesTotal++;
    const raw = $(element).attr("data-src") || $(element).attr("src") || "";
    let source: string;
    try { source = new URL(raw, response.finalUrl).href; if (!raw) throw new Error(); }
    catch {
      source = `invalid:${randomUUID()}`;
    }
    $(element).attr("data-source-url", source);
    imageUrls.set(source, (imageUrls.get(source) || 0) + 1);
  });
  currentBudget()!.countImages(meta.imagesTotal);
  progress(meta);
  const queue = [...imageUrls.entries()]; let cursor = 0;
  const saved: Asset[] = [];
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (cursor < queue.length) {
        currentBudget()!.check();
      const [source, count] = queue[cursor++];
      const downloaded = await downloadImage(itemId, source, count, result => {
        const existing = meta.images.findIndex(r => r.originalUrl === source);
        if (existing >= 0) meta.images[existing] = result; else meta.images.push(result);
        progress(meta);
      });
      if (downloaded.asset) { saved.push(downloaded.asset); meta.imagesSaved += count; }
    }
  }));
  const byUrl = new Map(saved.map(a => [a.originalUrl, a]));
  content.find("img").each((_, element) => {
    const asset = byUrl.get($(element).attr("data-source-url") || "");
    if (asset) $(element).attr("src", asset.relativePath); else $(element).remove();
  });
  const snapshotHtml = sanitizeContent(content.html() || "");
  const snapshotMd = toMarkdown(snapshotHtml);
  meta.textSavedChars = textCount(snapshotHtml);
  meta.textCoverage = meta.textSourceChars ? Math.min(1, meta.textSavedChars / meta.textSourceChars) : 1;
  progress(meta);
  if (!snapshotMd.trim()) throw new FetchFailure("parse", "净化后没有可保存的正文");
  return { title, author, publishedAt: time.value, snapshotHtml, snapshotMd, assets: saved, meta };
}
