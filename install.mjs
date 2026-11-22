import {cp, mkdir, mkdtemp, readFile, stat, rename, rm} from "node:fs/promises";
import path from "node:path";
import {homedir} from "node:os";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {applyChoice, selectBot} from "./scripts/setup.mjs";

async function install() {
  const args = process.argv.slice(2);
  const configureOnly = args[0] === "--configure";
  if (configureOnly) args.shift();
  if (args.length > 1) throw new Error("用法：node install.mjs [--configure] [技能父目录]");
  const choice = await selectBot();
  const source = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(args[0] || path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "skills"));
  const target = path.join(root, "article-reader");
  await mkdir(root, {recursive:true});
  const lock = target + ".install-lock";
  await mkdir(lock).catch(e => {
    if (e.code === "EEXIST") throw new Error("已有安装正在进行。若前次异常退出，请检查 " + lock);
    throw e;
  });
  try {
    const exists = await stat(target).catch(e => {if (e.code !== "ENOENT") throw e;});
    if (exists && JSON.parse(await readFile(path.join(target,"package.json"),"utf8")).name !== "article-reader") {
      throw new Error("安装位置已有其他项目：" + target);
    }
    if (configureOnly) {
      await stat(path.join(target,"scripts/summary.mjs"));
      await applyChoice(choice);
      return;
    }
    const stage = await mkdtemp(path.join(root,".install-article-reader-"));
    try {
      for (const file of ["SKILL.md","read.mjs","scripts","package.json","package-lock.json"]) {
        await cp(path.join(source,file),path.join(stage,file),{recursive:true});
      }
      const npm = spawnSync("npm",["ci","--engine-strict","--no-audit","--no-fund"],{cwd:stage,stdio:"inherit"});
      if (npm.status !== 0) throw new Error("安装依赖失败，请核对 Node 版本和 npm 网络连接");
      const test = spawnSync(process.execPath,["--import","tsx","--test","scripts/reader.test.ts"],{cwd:stage,stdio:"inherit"});
      if (test.status !== 0) throw new Error("阅读自检失败");
      let backup;
      if (exists) {
        const backups = path.join(root,"..","article-reader-install-backups");
        await mkdir(backups,{recursive:true,mode:0o700});
        backup = path.join(await mkdtemp(path.join(backups,"previous-")), "article-reader");
        await rename(target,backup);
      }
      try {
        await rename(stage,target);
        try { await applyChoice(choice); }
        catch (error) { await rename(target,stage); throw error; }
      } catch (error) { if (backup) await rename(backup,target); throw error; }
      if (backup) console.log("升级备份：",backup);
      console.log("已安装：",target);
    } finally { await rm(stage,{recursive:true,force:true}); }
  } finally { await rm(lock,{recursive:true,force:true}); }
}
install().catch(e=>{console.error(e.message);process.exitCode=1;});
