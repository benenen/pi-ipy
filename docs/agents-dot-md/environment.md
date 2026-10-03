# 开发环境 / 推送 / 发布

> 本机环境、扩展装法、Git 推送、以及「改行为后怎么验收」的操作手册。

## 一、开发环境

| 项 | 值 |
|---|---|
| 宿主 | pi 1.0.0（`pi --version`）；扩展 API 由宿主在运行时注入 |
| Node | 24.21.0（pi 自带的那个） |
| Python | `python3` = 3.14.4（被执行的解释器；换版本用 `PI_IPY_PYTHON` 覆盖） |
| 本仓库 | 一个本地 pi 扩展，路径无关；仓库在哪个目录，软链就指向哪 |
| 类型检查 | `npm run typecheck`（= `tsc --noEmit`，当前 0 错误）。`typescript` / `@types/node` / `typebox` 是 devDependencies，`node_modules/` 不入库，首次先 `npm install` |

`tsconfig.json`（`include: ["index.ts", "lib/**/*.ts"]`）同时是 **pi-lens 的权威配置**：没有它时 pi-lens 按 inferred settings 检查，会给每个 Node 内建模块和全局变量报假错误（`Cannot find module 'node:child_process'`、`Cannot find name 'Buffer'` 之类，见 docs/memory/known-pitfalls.md）。新增 `.ts` 文件时确认它落在 `include` 覆盖范围内。

> ⚠️ 本仓库**不需要任何凭据**。若日后新增（token、内网地址等），一律放未入库文件（如 `dev-env.local.md`，加进 `.gitignore`），不要写进受版本控制的文件。

## 二、装 / 卸（"部署"就是这个）

pi 启动时自动发现它 agent 目录下 `extensions/` 里的每个**文件夹**，所以"部署"只是软链。下面用 `$PI_AGENT_DIR` 表示 pi 的 agent 目录（默认 `~/.pi/agent`），**不要把它写死成某台机器的绝对路径**，换机器就失效：

```bash
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"

# 装：仓库软链成扩展目录下的一个条目
ln -sfn "$PWD" "$PI_AGENT_DIR/extensions/pi-ipy"

# 卸
rm "$PI_AGENT_DIR/extensions/pi-ipy"
```

改完 `index.ts` 要**重开 pi**（或新会话）才生效——扩展在进程启动时加载，热改不重载。临时试某个版本不必软链，用 `pi -e <index.ts 的路径>`。

## 三、Git 推送

远端 `origin` 指向本仓库的 GitHub 地址（`git remote -v`），主分支 `main`。本机没有 `HTTPS_PROXY`（只有 `GOPROXY` / rustup 镜像那几个变量），直连即可：

```bash
git push
```

若某天出现 TLS 握手失败，按老办法绕过代理：`HTTPS_PROXY= HTTP_PROXY= git push`。

## 四、验收（改「模型行为」后必做）：测比率，不测段子

改 `promptSnippet` / `promptGuidelines` / `description` / 工具结果文案时，`node scripts/smoke.mjs` 全绿**不代表改对了**——它只证明工具能跑，证明不了模型会用。唯一判据是 A/B 对照，而且**一次 A/B 等于没有 A/B**：

> 2026-10-02 实测：同一模型（`deepseek-v4.1-flash`）、同一系统提示（逐字节比对过 guideline 与 snippet 完全一致）、同一提示词，4 次里 3 次用 ipy、1 次整轮不用；换一次跑法 5 轮 0 次。只看单跑，两次都能得出相反结论。

所以下面的仪表一律报**比率**，并且**必须用 `--model` 钉死模型**（不钉就是又换了一个变量，比率不可比）。cwd 用 `/tmp/ipy-acc` 中立目录，避免仓库里的 `AGENTS.md` 进入上下文。

**基线的关键**：不要用 `-ne` 关掉所有扩展（那会连 pi-lens 等一起关，基线就不干净）。用 `-xt ipy` 只把 ipy 摘出去 —— 其余上下文完全一致，唯一变量就是 ipy 是否激活（不激活时它的 guidelines 也不注入）；若改的是工具**结果文案**，则用 `PI_IPY_QUIET=1` 关掉全部复用提示来对照。

```bash
cd /tmp/ipy-acc 2>/dev/null || { mkdir -p /tmp/ipy-acc && cd /tmp/ipy-acc; }

# 一问一答：模型会不会挑 ipy？（n=4 起，报比率）
bash scripts/acc-rate.sh opencode-go/deepseek-v4.1-flash 4                 # 处理组
bash scripts/acc-rate.sh opencode-go/deepseek-v4.1-flash 4 -xt ipy         # 基线

# 两轮：会不会 edit 旧脚本 + 按路径重跑，而不是重发代码？（要分开 ~32% 与 ~28% 这种差，n 得 25 起）
bash scripts/acc-reuse.sh opencode-go/deepseek-v4.1-flash 25
PI_IPY_QUIET=1 bash scripts/acc-reuse.sh opencode-go/deepseek-v4.1-flash 25  # 关掉复用提示的对照
```

两个仪表都自己跑 pi、自己抽 `tool_execution_start` 事件、自己出结论，不再手写抽事件的脚本（旧写法见 git 历史）。它们报的是：

- `acc-rate.sh`：每题里 `ipy` 是否出现、是否退化成 `bash` + `python3 - <<'EOF'`。
- `acc-reuse.sh`：第 1 轮建脚本、第 2 轮提个小改动（**必须是模型心算不出来的改动**，否则它会跳过工具）。现在用 `audit-reuse.py` 对齐 `toolCallId` 的开始/结束事件，只把成功修改后成功重跑**第 1 轮同一路径**的调用计入复用；同时统计 usage、参数字节、工具错误。旧数据没有固定输入/标准答案，不能由「出现过 code/path」推断脚本陈旧或正确。`event_span_seconds` 是日志消息时间跨度，不是 CLI 端到端耗时。输出目录名带臂标识（`nudge`/`quiet`）与 pid，避免同秒启动相互覆盖。

提示词要挑「bash 单独干不了、Python 才顺手」的：一句话 `wc -l` 就能解决的任务两组都走 bash，测不出东西。`acc-rate.sh` 里的提示词要求把 `toolCall.name` 的调用次数和所在 assistant 消息的 `usage.totalTokens` 关联聚合 —— 关联两处嵌套字段，用 shell 硬拼很难受。

**2026-10-02 基准（`deepseek-v4.1-flash`）**

| 问题 | 测法 | 结果 |
|---|---|---|
| 模型会不会挑 ipy？ | `acc-rate.sh`，n=4 | 激活组 **ipy 3/4**，且 **0/4** 退化成 python heredoc |
| 同上基线 | `acc-rate.sh ... -xt ipy`，n=4 | ipy 0/4（本就没这工具）；python heredoc 只 1/4，**3/4 用纯 shell 就做完了** |
| 会不会 edit 旧脚本？ | `acc-reuse.sh`，n=25/组 | 有 nudge：严格 edit+重跑 **8/25**、重写（同名覆写）13/25、脚本变陈旧 3/25、bash+heredoc 1/25 |
| 同上对照 | `PI_IPY_QUIET=1`，n=25 | 严格 **7/25**、重写 13/25、陈旧 3/25、heredoc 1/25、没调工具 1/25 |
| 脚本文件最终是新的？ | 同上（严格 + 重写） | **21/25 vs 20/25**，Fisher 双侧 p=1.00 |

读法：

- guideline 确实把「要写程序时」的第一反应推向 ipy（本轮复用测量的第 1 轮是 16/17 与 15/15、heredoc 0/17 与 2/15），但**基线那条提示词不够「python 必需」**（3/4 纯 shell 解决），所以这一列只能说明取舍、不能说明替代。
- **复用那两行 nudge 判定无效**：n=25/组、模型钉死、第 2 轮换成必须重新读文件才能算的中位数（旧提示词算百分比能心算，出现过一次一次工具不调、还回答「脚本已更新」），严格口径 **8/25 vs 7/25，Fisher p=1.00**；重写 13/25 vs 13/25、陈旧 3/25 vs 3/25、heredoc 1/25 vs 1/25 —— 两臂几乎逐格相同。换成更贴近用户感受的口径「脚本文件最终是否变新」也一样（21/25 vs 20/25，p=1.00）。早期 `percent` 变体（n=11/14）同向无差（4/11 vs 3/14，p=0.66）。→ **它只是把路径交还给模型，不是能推动 edit 的杠杆**；文档、计划、后续改动都不许再按「它能推动」来写。
- **模型实际在用的是「同名重写」**（13/25；更早一批 27 个 session-turn 里 24/27 同名）：`saveScript` 视为覆写，所以文件最终是新的、目录也不攒重复文件——「重写」的代价只有重发 token。真正陈旧的脚本很少（3/25）。
- 两条方法论比结论更值钱：① **噪声地板**——nudge 影响不到的第 1 轮，两组建脚本次数就差 19 vs 27（40%）；② **单跑与小 n 都会骗人**——同一模型、逐字节相同的系统提示，一次 4 跑用 ipy 3 次、另一次 5 轮 0 次；我曾凭 n=3 断言「中位数变体更容易让脚本陈旧」（2/3），n=25 后是 3/25 vs 3/25。
- 真正的开销大头不在第 2 轮，而在**同一轮内的反复重发**：有一例一轮发了 5 遍完整脚本；另一例 `1 create + 5 run`。

## 五、效率验收（2026-10-03）

`scripts/acc-efficiency.py` 用固定种子生成只读 JSONL、独立计算均值/中位数标准答案，交替运行旧扩展快照和当前扩展。两臂都关闭扩展/skill/上下文文件自动发现，只显式加载被测扩展，保证环境相同；这是干净的 pi 核心环境测量，不能直接外推到所有日常扩展组合。每次两轮使用同一 session，记录真实 assistant usage（只统计 `message_end`，不重复统计 `agent_end`）、CLI 墙钟耗时和工具失败；实际执行输出与最终回答都对照标准答案。结果数值正确、仅 JSON 格式合规分开统计。

```bash
# BASELINE 为改动前版本的完整目录，至少有 index.ts 与 lib/store.ts、lib/run.ts。
python3 -B scripts/acc-efficiency.py --model opencode-go/deepseek-v4.1-flash \
  --baseline /tmp/pi-ipy-efficiency-baseline/index.ts --reps 5

# 只重算已保存的数据，不再调模型。
python3 -B scripts/acc-efficiency.py --reanalyze /tmp/ipy-efficiency-67oq9iur

# 无模型的确定性比较：宿主真实 edit/ipy 工具、三种更新方式、独立答案校验。
node scripts/bench-local.mjs /tmp/pi-ipy-efficiency-baseline/index.ts
```

改动前的快照取自 `41eca67`。本地 18 行脚本每种更新方式跑 10 次：完整重发的调用参数 634 B；内置 edit + ipy 重跑为 291 B / 2 次调用；合并 edits + ipy 为 229 B / 1 次调用（比完整重发少约 64%）。这些是 UTF-8 字节和工具调用数，**不能写成 token 节省率**。5000 行输出从 229,225 B 降至 51,575 B，少约 77.5%；这是修复模型视图绕过截断的确定性收益，文件仍保存捕获输出。

真实模型 `opencode-go/deepseek-v4.1-flash` 两批各 n=5/臂，必须同时报告所有阶段：

| 版本 / 范围 | 旧版 | 新版 |
|---|---:|---:|
| 仅合并 edits 的第二轮 totalTokens 中位数 | 19,278 | 30,257 |
| 仅合并 edits 的两轮合计 totalTokens 中位数 | 29,322 | 52,277 |
| 最终版（args 优先 + edits）第二轮 totalTokens 中位数 | 31,771 | 21,524 |
| 最终版第二轮墙钟中位数 | 25.3 s | 17.6 s |
| 最终版第二轮工具调用中位数 | 5 | 2 |
| 最终版第二轮执行 + 回答数值正确 | 5/5 | 5/5 |
| 最终版第二轮仅 JSON 格式合规 | 5/5 | 1/5 |
| 最终版两轮合计 totalTokens 中位数 | 46,135 | 50,045 |
| 最终版两轮合计墙钟中位数 | 51.1 s | 52.5 s |

**结论范围**：最终版这一小批的修改阶段 token 少约 32%、耗时少约 30%；整轮没有检出收益，输出格式也未改善。前一批方向相反，不能把 n=5 的第二轮改善宣传成稳定的整体加速、普遍省 token 或准确率提升；优先保证输出预算、提供低成本调用形态，再积累更大样本。保留两批数据，不挑较好的一批替代全部证据。

汇总保存在 `docs/efficiency-results.json`；原始记录 `/tmp/ipy-efficiency-a8ilztst` 与 `/tmp/ipy-efficiency-67oq9iur` 可能随系统清理消失。临时 agent 目录复制了本机认证/模型配置，目录 0700、文件 0600；不要将整份实验目录入库或上传，只共享不含凭据的派生统计。

## 六、发布

没有发布流程，也没有版本号要维护（扩展只在本地用）。要给别人用就把仓库推上去，对方自己按上面的软链方式装。
