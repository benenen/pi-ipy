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

## 四、验收 A/B（改「模型行为」后必做）

改 `promptSnippet` / `promptGuidelines` / `description` 时，`node scripts/smoke.mjs` 全绿**不代表改对了**——它只证明工具能跑，证明不了模型会用。唯一判据是 A/B 对照。

**控制变量的关键**：不要用 `-ne` 关掉所有扩展（那会连 pi-lens 等一起关，基线就不干净）。装好扩展后，用 `-xt ipy` 只把 ipy 摘出去当基线 —— 其余上下文完全一致，唯一变量就是 ipy 是否激活（不激活时它的 guidelines 也不注入）。

```bash
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"       # pi 的 agent 目录，同上
mkdir -p /tmp/ipy-acc/sessions && cd /tmp/ipy-acc     # 中立目录，避免仓库里的 AGENTS.md 干扰

# 要挑「bash 单独干不了、Python 才顺手」的任务（解析 JSONL / 聚合 / CSV），
# 一句话 wc -l 就能解决的任务两组都走 bash，测不出东西。
PROMPT="统计 $PI_AGENT_DIR/sessions 下最新的那个 .jsonl 会话文件里各种工具被调用了多少次，按次数从多到少列出前 10 个。"

# A 基线：ipy 不激活
pi -p --mode json -xt ipy --session-dir /tmp/ipy-acc/sessions "$PROMPT" > /tmp/ipy-acc/a.json

# B 处理组：ipy 激活
pi -p --mode json          --session-dir /tmp/ipy-acc/sessions "$PROMPT" > /tmp/ipy-acc/b.json
```

`--mode json` 是逐行 JSON 事件流，抽工具调用序列：

```bash
python3 - <<'EOF'
import json
def calls(p):
    out=[]
    for l in open(p):
        l=l.strip()
        if not l: continue
        try: e=json.loads(l)
        except: continue
        if e.get("type")=="tool_execution_start":
            out.append((e.get("toolName"), e.get("args") or {}))
    return out
for tag in ("a","b"):
    c=calls(f"/tmp/ipy-acc/{tag}.json")
    print(tag, [n for n,_ in c])
    for n,a in c:
        if n=="ipy": print("   ", json.dumps(a,ensure_ascii=False)[:200])
EOF
```

**2026-10-02 的基准结果**（同一提示词，按上表跑）：

| | 工具序列 |
|---|---|
| A 基线（`-xt ipy`） | `bash × 5`，其中两次是 `python3 - "$F" <<'EOF'` heredoc |
| B 处理组 | `bash × 1`（仅 `ls` / `find` 定位文件）+ `ipy × 2` |

即：guideline 咬上了——短文件操作仍归 bash，需要写程序时第一反应变成 ipy。

## 五、发布

没有发布流程，也没有版本号要维护（扩展只在本地用）。要给别人用就把仓库推上去，对方自己按上面的软链方式装。
