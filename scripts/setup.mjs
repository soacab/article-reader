import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import path from "node:path";
import {createInterface} from "node:readline/promises";
import {execFile,spawnSync} from "node:child_process";
import {promisify} from "node:util";
import {configure,endpoint,profileId} from "./summary.mjs";

const exec = promisify(execFile);

async function botName(bot) {
  const bin = path.join(homedir(),".aamp/npm-global/bin/lark-cli");
  const env = {...process.env,LARKSUITE_CLI_CONFIG_DIR:process.env.LARKSUITE_CLI_CONFIG_DIR ||
    path.join(homedir(),".lark-cli-aamp-one-click-v1")};
  try {
    const {stdout} = await exec(bin,["--profile",bot.lark_cli_profile,"api","GET","/open-apis/bot/v3/info","--as","bot"],{env,timeout:5000});
    return JSON.parse(stdout).data?.app_name || bot.display_name;
  } catch { return bot.display_name; }
}

export async function selectBot() {
  const rl = createInterface({input:process.stdin,output:process.stdout});
  try {
    let bots = [];
    try {
      const file = path.join(homedir(),".aamp/feishu-task-agent/bindings-v1.json");
      bots = JSON.parse(await readFile(file,"utf8")).bindings.map(({bot})=>bot).filter(b=>b?.lark_cli_profile);
    } catch(error) { if (error.code !== "ENOENT") throw error; }
    console.log("要给哪个已有的飞书机器人添加读文章功能？");
    const names = await Promise.all(bots.map(botName));
    bots.forEach((bot,i)=>console.log(i+1,names[i],bot.app_id));
    console.log("0 我的机器人未列出，手动输入后台传递的机器人标识");
    const index = (await rl.question("选择编号：")).trim();
    const id = profileId(index === "0" ? (await rl.question("已有机器人的运行标识：")).trim() :
      (/^[1-9]\d*$/.test(index) && bots[Number(index)-1]?.lark_cli_profile));
    const mode = (await rl.question("文章总结用哪个 AI？ 1 机器人的 AI（默认）  2 单独填 URL、Key 和模型：")).trim() || "1";
    if (mode === "1") return {id,config:{mode:"agent"}};
    if (mode !== "2") throw new Error("请选择 1 或 2");
    const base = (await rl.question("API Base URL（例如 https://服务地址/v1）：")).trim();
    endpoint(base);
    const model = (await rl.question("模型名称：")).trim();
    rl.close();
    console.log("请在本机输入 API Key（隐藏输入），然后回车：");
    const secret = spawnSync("/bin/zsh",["-c",'IFS= read -rs key </dev/tty && print -rn -- "$key"'],{encoding:"utf8",stdio:["inherit","pipe","inherit"]});
    if (secret.status !== 0 || !secret.stdout) throw new Error("未取得 Key，请在本机交互终端运行安装器");
    return {id,config:{mode:"api",base,model},key:secret.stdout};
  } finally {rl.close();}
}

export async function applyChoice(choice) {
  await configure(choice.id,choice.config,choice.key);
  console.log("已为",choice.id,"启用",choice.config.mode === "api" ? "独立 API" : "机器人自己的 AI");
}
