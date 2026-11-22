import {spawnSync} from "node:child_process";
import {copyFile, link, mkdir, mkdtemp, readFile, rm} from "node:fs/promises";
import {copyImages} from "./scripts/copy-images.mjs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const [url, option, destination, ...extra] = process.argv.slice(2);

async function read() {
  if (!url || (option !== undefined && (option !== "--save-dir" || !destination)) || extra.length) {
    throw new Error("用法：node read.mjs URL [--save-dir 目标文件夹]");
  }
  const temp = await mkdtemp(path.join(tmpdir(), "article-reader-"));
  try {
    const child = spawnSync(process.execPath, ["--import", require.resolve("tsx"), fileURLToPath(new URL("./scripts/worker.ts", import.meta.url)), url], {
      cwd: temp, stdio: ["ignore", "ignore", "inherit"], timeout: 300000, killSignal: "SIGKILL"
    });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error("读取失败");
    const result = JSON.parse(await readFile(path.join(temp, "result.json"), "utf8"));
    if (result.saved < result.total) console.error("已保存图片 " + result.saved + "/" + result.total);
    const article = path.join(temp, "article.md");
    if (!destination) {
      process.stdout.write(await readFile(article, "utf8"));
      return;
    }
    const dir = path.resolve(destination);
    await mkdir(dir, {recursive: true});
    // Stage on the same volume so publication via link is atomic and never overwrites a note.
    const stage = await mkdtemp(path.join(dir, ".article-reader-"));
    let assetDir;
    try {
      const staged = path.join(stage, "note.md");
      await copyFile(article, staged);
      if (result.saved) {
        const target = path.join(dir, result.assets);
        await mkdir(target, {mode: 0o700});
        assetDir = target;
        await copyImages(path.join(temp, result.assets), target);
      }
      const stem = Array.from(result.title.replace(/[\x00-\x1f/\\:*?"<>|#^\[\]]/g, " ").trim().replace(/^\.+/, "") || "文章").slice(0, 48).join("");
      let index = 1;
      while (true) {
        const target = path.join(dir, stem + (index === 1 ? "" : " (" + index + ")") + ".md");
        try { await link(staged, target); assetDir = undefined; console.log(target); break; }
        catch (error) { if (error.code !== "EEXIST") throw error; index++; }
      }
    } finally {
      if (assetDir) await rm(assetDir, {recursive: true, force: true});
      await rm(stage, {recursive: true, force: true});
    }
  } finally { await rm(temp, {recursive: true, force: true}); }
}
read().catch(error => { console.error(error.message); process.exitCode = 1; });
