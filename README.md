# Article Reader · 读文章

把本仓库的 GitHub 链接交给你的 coding agent，告诉它“请按首次安装步骤，让我的飞书机器人能总结文章、把原文存到我的笔记目录”。第一版面向 macOS、本机 Codex 和飞书。公开文章用本机网络读取；总结使用你的助手。需要微信验证时返回失败原因。Mac 和机器人后台服务需要在线。

## 给安装助手的首次安装步骤

1. 在用户机器上克隆这个仓库。Git 克隆遇到网络问题时，可使用 GitHub 的 Code → Download ZIP；需要复核固定版本时，可下载 [0.1.1 的官方源码包](https://api.github.com/repos/soacab/article-reader/tarball/9eda865)，解压后进入含 install.mjs 的目录。确认运行机器人的是哪个本机 Codex、它的技能目录、Node 和 npm 版本。本项目所需的 Node 版本见 package.json 的 engines。准备实测文章及用户指定的笔记目录。
2. 核对用户已有机器人的名称与绑定。已有 AAMP 时用其 list/status 查看并复用配对。如用户需要从零接入，按 [AAMP 安装包说明](https://www.npmjs.com/package/@larktask/aamp-feishu-task-agent) 在交互终端运行 `npx --package @larktask/aamp-feishu-task-agent feishu-task-agent install`。引导用户在官方界面授权自己的机器人并选择自己的 Codex；如需管理员批准，等批准后继续。已有其他绑定时使用 AAMP 的 add 流程增配。保留原有账号与绑定，不收集用户凭证。以实际配对和服务就绪为准。
3. 运行 `node install.mjs`，或传入机器人实际使用的技能父目录。安装器按锁文件装依赖、执行自检，再交付独立副本。若用户已安装，先检查目标路径和现有版本。让机器人在新会话加载技能；若仍找不到，先核实运行端技能目录和加载状态。
4. 在飞书向机器人发“请总结这篇的三个要点：〈公开文章链接〉”。对照原文检查三个具体要点。再发“把这篇原文保存到〈绝对目录〉：〈文章链接〉”，核对飞书回复、实际 Markdown 文件的来源、末段及成功保存的图片。目录应在执行端可访问范围内。
5. 记录每步结果。收不到消息查配对和收发权限；消息能达但没用技能查运行端；读取失败查实际错误；写入失败查目标目录权限。新安装、配对、飞书往返和写入分别核验。私有飞书文档另走用户自己的飞书文档工具与授权。

## 本地直接读取

在已安装技能目录运行 `node read.mjs 'https://example.org/article'`。保存可在命令末尾加 `--save-dir '/绝对路径/待读'`。抓取在独立进程中运行，失败时退出码非零；遇到重名文件自动选择新文件名。图片保存在笔记旁的独立附件目录里。

## 首次配对超时怎么办

如果飞书已完成授权，但 AAMP 的首次绑定在 90 秒时报超时，先用 `feishu-task-agent list` 核对新应用仍在绑定列表中，再查看 `feishu-task-agent status` 和 `logs`。本次 macOS 验收中，配对成功的一次用了 106 秒。对仍为 pending 的已有绑定，可以在交互终端运行 `AAMP_TASK_READY_TIMEOUT_MS=240000 feishu-task-agent start`，选择本次需要运行的绑定。若 AAMP 已经回退到只运行旧绑定，先告知用户已有机器人的短暂中断，在可中断时用 stop 后再运行上述 start。若机器上有多份 Codex，检查实际命中的 codex --version 与之前可用的版本。以飞书消息往返和后台服务的就绪状态验收。
