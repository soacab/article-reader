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

import {load} from "cheerio";
import {preserveWechatLayout} from "./wechat-layout";
import {sanitizeContent, toMarkdown} from "./content";

test("保存笔记保留标题层级、局部字重、编号标题和图片说明", () => {
  const image = "article-assets-00000000-0000-0000-0000-000000000000/" + "a".repeat(64) + ".png";
  const $ = load('<article><h3>原生标题</h3><section style="text-align:center;font-size:20px"><p>02</p><p>测试，</p><p>结果</p></section>' +
    '<p>前文<span style="font-weight:700">重点<span style="font-weight:normal">例外</span></span>后文</p>' +
    '<figure><img src="'+image+'"><figcaption>实验结果</figcaption></figure><p>结语</p></article>');
  preserveWechatLayout($, $("article")[0]);
  const md = toMarkdown(sanitizeContent($("article").html()!));
  assert.match(md, /### 原生标题\s+## 02 测试，结果/);
  assert.ok(md.includes("前文**重点**例外后文"));
  assert.ok(md.includes("![](" + image + ")\n\n_实验结果_\n\n结语"));
});

import {answer, complete, endpoint, profileId} from "./summary.mjs";

test("独立摘要接口发送指定模型与认证，失败不会切换服务", async (t) => {
  assert.throws(()=>endpoint("http://example.org/v1"));
  assert.throws(()=>profileId("../another-bot"));
  const fetch = t.mock.method(globalThis,"fetch", async (url, options) => {
    assert.equal(String(url),"https://provider.example/v1/chat/completions");
    assert.equal(options.headers.Authorization,"Bearer fixture");
    assert.equal(options.redirect,"error");
    assert.deepEqual(JSON.parse(options.body),{model:"test-model",messages:[{role:"user",content:"测试"}]});
    return Response.json({choices:[{message:{content:"两个要点"}}]});
  });
  const config = {base:"https://provider.example/v1/",model:"test-model"};
  const messages = [{role:"user",content:"测试"}];
  assert.equal(await complete(config,"fixture",messages),"两个要点");
  fetch.mock.mockImplementation(async()=>new Response(null,{status:401}));
  await assert.rejects(complete(config,"fixture",messages),/401/);
  assert.equal(fetch.mock.callCount(),2);
});

test("未配置独立接口的机器人沿用自己的 AI", async (t) => {
  const fetch = t.mock.method(globalThis,"fetch",async()=>{ throw new Error("意外调用 API"); });
  const id = "test-" + crypto.randomUUID();
  assert.deepEqual(await answer(id,"总结","正文"),{mode:"agent",article:"正文"});
  assert.equal(fetch.mock.callCount(),0);
});
