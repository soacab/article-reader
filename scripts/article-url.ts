import { normalizeWechatUrl } from "./wechat-url";

// Shared syntax validation. The server and every fetch separately enforce public addresses.
export function normalizeArticleUrl(raw: string) {
  if (raw.length > 4096) throw new Error("链接过长，请检查后重试");
  let url: URL;
  try { url = new URL(raw.trim().replace(/\\([&?=])/g, "$1").replace(/&amp;/g, "&")); }
  catch { throw new Error("请输入完整的 HTTP/HTTPS 文章链接"); }
  if (url.hostname === "mp.weixin.qq.com") return normalizeWechatUrl(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) {
    throw new Error("只允许不含账号密码的标准 HTTP/HTTPS 地址");
  }
  url.hash = "";
  feishuLink(url.href);
  return url.href;
}

export const unsupportedFeishuFile = "暂不支持这种飞书文件";
export function feishuLink(raw: string): { kind: "docx" | "wiki"; id: string } | { kind: "unsupported"; id: null } | null {
  const { hostname, pathname } = new URL(raw);
  if (!/(^|\.)(feishu\.cn|larkoffice\.com)$/.test(hostname.replace(/\.$/, ""))) return null;
  const [, kind, id] = pathname.split("/");
  if (kind === "docx" || kind === "wiki") {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id || "")) throw new Error("飞书链接缺少有效的文档标识");
    return { kind, id };
  }
  if (["doc", "sheets", "sheet", "base", "bitable", "mindnote", "slides", "slide", "file", "folder", "board"].includes(kind) ||
      (kind === "drive" && ["file", "folder"].includes(id))) {
    return { kind: "unsupported" as const, id: null };
  }
  return null;
}

export function articleSource(url: string): "wechat" | "web" | "feishu_doc" {
  if (new URL(url).hostname === "mp.weixin.qq.com") return "wechat";
  return feishuLink(url) ? "feishu_doc" : "web";
}

export function articleDomain(url: string) {
  try { return new URL(url).hostname; } catch { return "网页"; }
}
