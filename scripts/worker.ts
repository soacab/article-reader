import {writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {articleSource, normalizeArticleUrl} from "./article-url";
import {emptyMeta, extractWechat} from "./wechat";
import {extractWeb} from "./web";

async function main() {
  const url = normalizeArticleUrl(process.argv[2]);
  const source = articleSource(url);
  if (source === "feishu_doc") throw new Error("请使用当前用户已授权的飞书文档读取工具");
  const extract = source === "wechat" ? extractWechat : extractWeb;
  const meta = emptyMeta();
  const assets = "article-assets-" + randomUUID();
  const snapshot = await extract(assets, url, meta, () => {});
  const title = snapshot.title.replace(/[\r\n]+/g, " ").trim();
  const body = "# " + title + "\n\n来源：<" + url + ">\n\n" + snapshot.snapshotMd + "\n";
  await writeFile("article.md", body, {mode: 0o600});
  await writeFile("result.json", JSON.stringify({title, assets, saved: meta.imagesSaved, total: meta.imagesTotal}));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
