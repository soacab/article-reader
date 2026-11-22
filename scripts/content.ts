import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";
import Turndown from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { FetchFailure, type TimeAttempt } from "./types";

const quotedText = String.raw`'((?:[^'\\\r\n]|\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|['"\\/bfnrtv]))*)'`;
const textPage = new RegExp(String.raw`^[ \t]*text_page_info:\s*\{\s*content:\s*${quotedText},\s*content_noencode:\s*${quotedText},\s*short_msg_pic_url:\s*\[\s*\],\s*picture_info:\s*\[\s*\],`, "m");

function wechatTextPost($: cheerio.CheerioAPI) {
  const title = $("meta[property='og:title']").attr("content")?.trim();
  if (!title) return null;
  const data = $("script:not([src])").map((_, element) => $(element).html() || "").get().find(script =>
    /^[ \t]*window\.cgiDataNew\s*=\s*\{\s*base_resp:\s*\{\s*ret:\s*'0'\s*\*\s*1,\s*errmsg:\s*'ok',/m.test(script));
  if (!data || !/^[ \t]*item_show_type:\s*'10'\s*\*\s*1,[ \t]*$/m.test(data)) return null;
  const encoded = textPage.exec(data)?.[2];
  if (!encoded) return null;
  const escapes: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  const body = encoded.replace(/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|(['"\\/bfnrtv]))/g,
    (_, hex, unicode, literal) => literal ? escapes[literal] ?? literal : String.fromCharCode(parseInt(hex || unicode, 16)));
  if (!body.trim()) return null;
  const publishedAt = /^[ \t]*create_time:\s*'([\d :\-]+)',[ \t]*$/m.exec(data)?.[1];
  return { title, body, publishedAt };
}

export function inspectArticle(html: string, finalUrl: string, status: number, requireWechatBody = true) {
  const $ = cheerio.load(html);
  const content = $("#js_content");
  const title = $("#activity-name").text().trim();
  const hasBody = Boolean(title && (content.text().trim() || content.find("img").length));
  const notice = $(".weui-msg, .weui-msg__title, .weui-msg__desc, #js_msg, .page_msg").text().replace(/\s+/g, "");
  const outsideArticle = hasBody ? notice : $("body").clone().find("script,style").remove().end().text().replace(/\s+/g, "");
  if (/wappoc_appmsgcaptcha|\/captcha|\/verify/.test(new URL(finalUrl).pathname) || status === 429 || /环境异常|完成验证|访问过于频繁|操作过于频繁|去验证/.test(outsideArticle)) {
    throw new FetchFailure("verification", "公众号要求验证或限制访问频率，本次没有保存正文");
  }
  if ([404, 410].includes(status) || /该内容已被发布者删除|此内容因违规无法查看|内容已删除|该内容已被删除|页面不存在|链接已过期|内容已过期/.test(outsideArticle)) {
    throw new FetchFailure("deleted", "文章已删除、失效或无法查看");
  }
  if (status === 401 || status === 403) throw new FetchFailure("permission", "来源网站拒绝访问");
  if (status < 200 || status >= 300) throw new FetchFailure("unreachable", `来源网站返回 HTTP ${status}`);
  const textPost = hasBody ? null : wechatTextPost($);
  if (requireWechatBody && !hasBody && !textPost) throw new FetchFailure("parse", "页面缺少有效的文章标题或正文");
  return { $, textPost, hasBody };
}

export function extractTime(html: string, textPostTime?: string) {
  const $ = cheerio.load(html);
  const scripts = $("script").map((_, e) => $(e).html() || "").get().join("\n");
  const primary = /\bcreateTime\s*[:=]\s*['"]([^'"]*)['"]/.exec(scripts)?.[1];
  const secondary = /\bct\s*[:=]\s*['"]?(\d+)['"]?\s*[;,}]/.exec(scripts)?.[1];
  const attempts: TimeAttempt[] = [];
  let value: string | null = null, source: string | null = null;
  const candidates: [string, string | undefined][] = [["createTime", primary], ["ct", secondary]];
  if (textPostTime !== undefined) candidates.push(["cgiDataNew.create_time", textPostTime]);
  for (const [name, raw] of candidates) {
    if (raw === undefined) { attempts.push({ source: name, outcome: "missing" }); continue; }
    let parsed: string | null = null;
    if (name !== "ct") {
      const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
      if (m) {
        const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}+08:00`;
        const date = new Date(iso);
        const expected = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}`;
        if (!Number.isNaN(date.valueOf()) && new Date(date.valueOf() + 8 * 3600000).toISOString().slice(0, 19) === expected) parsed = date.toISOString();
      }
    } else if (/^\d{10}$/.test(raw)) {
      const date = new Date(Number(raw) * 1000);
      if (Number(raw) >= 1262304000 && date.valueOf() <= Date.now() + 86400000) parsed = date.toISOString();
    }
    if (!parsed) attempts.push({ source: name, outcome: "invalid", value: raw, reason: "不是有效的发布时间" });
    else if (value) attempts.push({ source: name, outcome: "not_used", value: raw, reason: parsed === value ? "与优先来源一致" : `与优先来源不同，保留 ${source}` });
    else { value = parsed; source = name; attempts.push({ source: name, outcome: "selected", value: raw }); }
  }
  return { value, source, attempts };
}

export function sanitizeContent(html: string, feishuPlaceholders = false) {
  return sanitizeHtml(html, {
    allowedTags: ["p", "div", "section", "span", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "s", "del", "blockquote", "ul", "ol", "li", "pre", "code", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "a", "img", "figure", "figcaption", "sup", "sub"],
    allowedAttributes: { ...(feishuPlaceholders ? { p: ["class"] } : {}), a: ["href", "title", "rel"], img: ["src", "alt", "width", "height"], th: ["colspan", "rowspan"], td: ["colspan", "rowspan"], code: ["class"] },
    allowedClasses: { ...(feishuPlaceholders ? { p: ["feishu-placeholder"] } : {}), code: [/^language-[a-z0-9_+-]+$/i] },
    allowedSchemes: ["http", "https"], allowProtocolRelative: false,
    transformTags: { a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }) },
    exclusiveFilter: frame => frame.tag === "img" && !/^article-assets-[0-9a-f-]{36}\/[a-f0-9]{64}\.(?:jpeg|jpg|png|webp|gif|avif)$/.test(frame.attribs.src || ""),
  });
}
export function toMarkdown(html: string) {
  const converter = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" });
  converter.use(gfm);
  return converter.turndown(html);
}
export function textCount(html: string) {
  const $ = cheerio.load(html); $("script,style").remove();
  return $("body").text().replace(/\s|\u200b/g, "").length;
}
