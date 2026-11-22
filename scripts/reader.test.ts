import test from "node:test";
import assert from "node:assert/strict";
import {emptyMeta, extractWechat} from "./wechat";
import {extractWeb} from "./web";
import {safeFetch} from "./network";

const wx = "https://mp.weixin.qq.com/s/fixture";
const body = "来自测试文章的最后一句。";
const fixture = (html:string) => async (url:string) => ({
  status:200, finalUrl:url, headers:{"content-type":"text/html; charset=utf-8"}, body:Buffer.from(html)
}) as Awaited<ReturnType<typeof safeFetch>>;
test("公众号正文、标题、末段",async()=>{
  const result = await extractWechat("test",wx,emptyMeta(),()=>{},"wechat",fixture('<h1 id="activity-name">示例</h1><div id="js_content"><p>第一段</p><p>'+body+'</p></div>'));
  assert.equal(result.title,"示例"); assert.ok(result.snapshotMd.endsWith(body));
});
test("验证页返回原因",async()=>{
  await assert.rejects(extractWechat("test",wx,emptyMeta(),()=>{},"wechat",fixture("<p>环境异常</p>")), /要求验证/);
});
test("普通网页正文",async()=>{
  const result=await extractWeb("test","https://example.org",emptyMeta(),()=>{},"generic",fixture("<title>标题</title><article><h1>标题</h1><p>"+body.repeat(30)+"</p></article>"));
  assert.ok(result.snapshotMd.includes(body));
});

import {copyImages} from "./copy-images.mjs";
import {mkdtemp, mkdir, readFile, writeFile, rm} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
test("图片写入预先创建的笔记附件目录并保留文件内容", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reader-test-"));
  try {
    const source = path.join(root, "download");
    const target = path.join(root, "attachments");
    await mkdir(source); await mkdir(target);
    const bytes = Buffer.from([1,2,3]);
    await writeFile(path.join(source,"image.png"),bytes);
    await copyImages(source,target);
    assert.deepEqual(await readFile(path.join(target,"image.png")),bytes);
    await assert.rejects(copyImages(source,target), {code: "EEXIST"});
  } finally { await rm(root, {recursive:true,force:true}); }
});
