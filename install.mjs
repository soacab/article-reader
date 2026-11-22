import {cp, mkdir, mkdtemp, stat, rename, rm} from "node:fs/promises";
import path from "node:path";
import {homedir} from "node:os";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const source = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "skills"));
const target = path.join(root, "article-reader");
await mkdir(root, {recursive: true});
if (await stat(target).catch(e => {if (e.code !== "ENOENT") throw e;})) {
  throw new Error("目标已存在，请检查已安装版本：" + target);
}
const stage = await mkdtemp(path.join(root, ".install-article-reader-"));
try {
  for (const file of ["SKILL.md","read.mjs","scripts","package.json","package-lock.json"]) {
    await cp(path.join(source,file),path.join(stage,file),{recursive:true});
  }
  const install = spawnSync("npm", ["ci","--engine-strict","--no-audit","--no-fund"],{cwd:stage,stdio:"inherit"});
  if (install.status !== 0) throw new Error("安装依赖失败，请核对 Node 版本和 npm 网络连接");
  const test = spawnSync(process.execPath,["--import","tsx","--test","scripts/reader.test.ts"],{cwd:stage,stdio:"inherit"});
  if (test.status !== 0) throw new Error("阅读自检失败");
  await rename(stage,target);
  console.log("已安装：" + target);
} finally {await rm(stage,{recursive:true,force:true});}
