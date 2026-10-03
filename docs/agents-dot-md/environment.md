# 开发环境 / 推送 / 发布

> 本机环境、扩展装法、Git 推送、以及「改行为后怎么验收」的操作手册。

## 一、开发环境

| 项 | 值 |
|---|---|
| 宿主 | pi 1.0.0（`pi --version`）；扩展 API 由宿主在运行时注入 |
| Node | 24.21.0（pi 自带的那个） |
| Python | `python3` = 3.14.4（被执行的解释器；换版本用 `PI_IPY_PYTHON` 覆盖） |
| 本仓库 | 一个本地 pi 扩展，路径无关；仓库在哪个目录，软链就指向哪 |

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

# 两轮：会不会 edit 旧脚本 + 按路径重跑，而不是重发代码？（n=3 起）
bash scripts/acc-reuse.sh opencode-go/deepseek-v4.1-flash 3
PI_IPY_QUIET=1 bash scripts/acc-reuse.sh opencode-go/deepseek-v4.1-flash 3  # 关掉复用提示的对照
```

两个仪表都自己跑 pi、自己抽 `tool_execution_start` 事件、自己出结论，不再手写抽事件的脚本（旧写法见 git 历史）。它们报的是：

- `acc-rate.sh`：每题里 `ipy` 是否出现、是否退化成 `bash` + `python3 - <<'EOF'`。
- `acc-reuse.sh`：第 1 轮建脚本、第 2 轮提个小改动。判定分四类 —— `严格 edit+重跑`（最优）、`仅按路径重跑`、`重写`（又发一遍代码）、`bash+heredoc`／`没调工具`；并回读 `/tmp/pi-ipy-*/ipy-acc-*/.index.jsonl` 的 `mode` 序列交叉验证。

提示词要挑「bash 单独干不了、Python 才顺手」的：一句话 `wc -l` 就能解决的任务两组都走 bash，测不出东西。`acc-rate.sh` 里的提示词要求把 `toolCall.name` 的调用次数和所在 assistant 消息的 `usage.totalTokens` 关联聚合 —— 关联两处嵌套字段，用 shell 硬拼很难受。

**2026-10-02 基准（`deepseek-v4.1-flash`）**

| 问题 | 测法 | 结果 |
|---|---|---|
| 模型会不会挑 ipy？ | `acc-rate.sh`，n=4 | 激活组 **ipy 3/4**，且 **0/4** 退化成 python heredoc |
| 同上基线 | `acc-rate.sh ... -xt ipy`，n=4 | ipy 0/4（本就没这工具）；python heredoc 只 1/4，**3/4 用纯 shell 就做完了** |
| 会不会 edit 旧脚本？ | `acc-reuse.sh`，n=11/组 | 有 nudge：严格 edit+重跑 **4/11**、edit 或仅重跑 5/11、重写 3、bash 1 |
| 同上对照 | `PI_IPY_QUIET=1`，n=11 | 严格 **2/11**、edit 或仅重跑 5/11、重写 5、bash 1 |

读法：

- guideline 确实把「要写程序时」的第一反应推向 ipy（3/4），但**基线那条提示词不够「python 必需」**（3/4 纯 shell 解决），所以这一列只能说明取舍、不能说明替代。
- **复用那一行 nudge 没测出效果**：严格口径 4/11 vs 2/11 在 n=11 下分不开（重写 3 vs 5 也是），宽松口径（edit 或仅重跑）两边都是 5/11。
- 最该记住的是**噪声地板有多高**：nudge 在第 1 轮的建脚本次数上一字影响不了——而两组第 1 轮发了 19 份 vs 27 份代码。处理组在它不影响的量上相差 40%，说明 n=11 时任何 ≤ 这个尺度的效应都测不出来。要定这件事需要 n≈25/组（FI 检验），或换个更干净的判据。
- 真正的开销大头不在第 2 轮，而在**同一轮内的反复重发**：对照组有一例一轮发了 5 遍完整脚本；而处理组有一例 `1 create + 5 run`——同一个模型里这行为是做得到的。

## 五、发布

没有发布流程，也没有版本号要维护（扩展只在本地用）。要给别人用就把仓库推上去，对方自己按上面的软链方式装。
