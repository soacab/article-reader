// Shared by the form and server; no network access or Node-only dependencies.
export function normalizeWechatUrl(raw: string) {
  if (raw.length > 4096) throw new Error("链接过长，请检查后重试");
  const value = raw.trim().replace(/\\([&?=])/g, "$1").replace(/&amp;/g, "&");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("请输入完整的公众号文章链接"); }
  if (["http:", "https:"].includes(url.protocol) && url.hostname !== "mp.weixin.qq.com") throw new Error("暂时只支持公众号链接");
  if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "mp.weixin.qq.com" || url.username || url.password || url.port || !/^\/s(?:\/[^/]+)?$/.test(url.pathname)) {
    throw new Error("请输入 mp.weixin.qq.com 的公众号文章链接");
  }
  url.protocol = "https:"; url.hash = ""; return url.href;
}
