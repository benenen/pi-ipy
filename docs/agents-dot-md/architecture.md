# 系统架构

> 组件边界、关键链路与设计决策；动结构、加模块前先看本文。

本文回答「这个系统由哪些部分组成、一次调用怎么流过它们、为什么这么切」。**技术选型与验证命令在 `tech-stack.md`**。

## 一、整体结构

```
模型 ──工具调用──> pi 扩展 (index.ts)
                      │
                      ├─ 落盘 ──> lib/store.ts ──> <tmp>/pi-ipy-<uid>/<cwd名>-<sid8>/*.py
                      │                              └─ .index.jsonl（追加式 manifest）
                      │
                      └─ 执行 ──> lib/run.ts ──> python3 -u <script> [args...]
                                                  └─ 输出截断/落盘、超时、杀进程组
```

- 部署形态：**不是服务**，是一个跑在 pi 进程内的扩展。`<pi agent 目录>/extensions/pi-ipy` 是指向本仓库的软链，pi 启动时自动发现（装法见 `environment.md`）。
- 进程边界：pi 是宿主；被执行的 Python 脚本是 pi 的子进程，且**单独建进程组**（见下）。

## 二、模块与依赖方向

| 模块 | 职责（一句话） | 允许依赖 | 禁止依赖 |
|---|---|---|---|
| `index.ts` | 工具定义：schema、两种提示、三种模式的分派、结果渲染 | `lib/*`、pi / typebox | 直接 `child_process`（执行一律走 `lib/run.ts`） |
| `lib/store.ts` | 路径与名字的**安全边界**：消毒、目录校验、原子写、manifest | node 标准库 | 执行、schema |
| `lib/run.ts` | 执行：spawn、流式收集、截断、超时、杀进程组 | node 标准库 | 路径规则、manifest |

依赖方向单向：`index.ts → lib/*`，两个 lib 之间互不依赖。

## 三、一次调用的完整链路

**`ipy({code, purpose})`（写并跑）**
1. `parseInput()` 把参数判成一个可辨识联合（`list` / `create` / `run`），非法组合直接抛错；
2. `store.sessionDir()` 拿到 / 建本会话目录（0o700、非软链、属当前 uid）；
3. `store.saveScript()` 消毒名字 → 临时文件 + `rename` 原子替换；**同名同内容即复用**（不动文件，返回 `reused: true`）；
4. `lib/run.ts` spawn `python3 -u`，`detached: true` 建进程组，cwd 取 `ctx.cwd`；
5. `store.appendManifest()` 记一条：时间 / 名字 / hash / purpose / 退出码 / 耗时；
6. `renderRun()` 渲染给模型看：`create` 时多两行**复用提示** —— `otherScripts()` 列出本会话其它脚本（最多 3 条、按最近运行排序、不带相似度打分），加一句 `to change it: edit that file, then ipy({path}) — don't send the code again`；实测这两行**不构成可测影响**（严格 edit 口径 n=25/组 8/25 vs 7/25，p=1.00），作用是交还路径，见 docs/memory/known-pitfalls.md；
7. `structuredContent` 给 codemode 脚本用。

**`ipy({path})`（重跑）** 跳过 2、3 的写入，直接校验文件存在再执行；不存在时**报错里点名两条恢复路径**（`ipy({list:true})` / 用 `code` 重写）。

**`ipy({path, edits})`（修改并重跑）**：只允许修改当前 session 目录内的普通 `.py` 文件；在宿主 `withFileMutationQueue` 中读取原文件，逐条验证 `oldText` 在原文件中恰好出现一次、替换范围互不重叠，再临时文件 + rename 一次落盘。任意验证失败则不写、不运行。修改完成后走同一执行链路，manifest 的 mode 为 `edit`。输入/选项变化优先使用已有 `args`，代码逻辑变化再用 `edits`。

**并发边界**：`index.ts` 对创建或运行的目标路径取得宿主 `withFileMutationQueue`，覆盖保存 / 修改、Python 执行与 manifest 记录；`saveScript()` / `editScript()` 由持有该队列的调用方执行，不再嵌套取得同一队列。同路径调用和宿主 edit/write 串行，不同路径仍可并行。队列只协调同一宿主进程内的操作，外部进程直接写文件不受它约束。

**取消边界**：调用开始时检查 AbortSignal；等待队列期间可立即拒绝，队列回调取得执行权后再次检查，跳过已取消的保存 / 修改。队列回调开始后由 runPython() 处理运行中的取消，捕获文件在 finally 中关闭与清理。

**Python 执行语义**：code 仅用 trim() 判断是否空白，保存原始源码；位于本会话目录的 scratchpad 在继承的 PYTHONPATH 前加入 cwd，创建和按路径重跑都能导入项目模块。外部 path 脚本保持普通文件执行的导入路径。每次执行仍是独立 Python 进程。

**超时边界**：秒数必须为有限正数，转换时向上取整且至少 1ms；超过 Node 定时器的 2,147,483,647ms 上限时拒绝并提示减小 timeout 或省略以使用无限时运行。

**输出预算**：stdout/stderr 连同分节标签共用 `truncateTail` 的 2000 行 / 50 KiB 预算，`renderRun` 只能接收截断后的 `outputView`。`store.createOutputCapture()` 预先打开两个独占、0600 的临时流文件，runPython() 通过 pipe 背压写入并等待文件完成；内存仍各保留最多 4 MiB 的头尾片段。视图或内存捕获截断时，按 stdout/stderr 两个分节流式合成完整 output_path，保留原输出换行；内存省略标记不会写入该文件。结束后删除临时流文件，保留的输出文件占用随输出规模增加的磁盘空间。写入失败会杀进程组并报告带 cause 的错误。

**`ipy({list:true})`** 以磁盘上的 `*.py` 为准（manifest 只用来补运行次数和最近退出码），所以模型手写一个文件进去也能被列出来。

manifest 行在 JSON 解析后还要验证必需字段与类型，坏行跳过；运行统计按完整脚本路径关联，外部同名文件的记录不会归到本会话脚本。

## 四、存储与安全边界

```
<os.tmpdir()>/pi-ipy-<uid>/
    <cwd 名>-<sessionId 前 8 位>/
        parse_logs.py        ← 模型自己起的名字（或由 purpose 推导）
        .index.jsonl
        .out/<script>-<rand>.out ← 输出被截断时落的全量文件，每次运行独立保存
        .tmp-<pid>-<rand>    ← 写入中转，rename 后消失
```

三条硬约束（都有对应 smoke 用例）：

- **名字来自模型，必须先消毒**：`sanitizeName` 取 basename + 白名单 `[A-Za-z0-9._-]`，再 `assertInside` 兜一层；`../../evil` → `evil.py`。
- **目录必须是私有的**：0o700、非软链、属当前 uid；不满足就拒绝使用（共享 /tmp 下防他人预建）。
- **写入必须原子**：临时文件 + `rename`，目标为软链时拒绝覆写。被 kill 不会留下半截脚本。

## 五、为什么这么切（关键取舍）

- **复用提示写在「工具结果」里，不是加第 3 条 guideline**：guideline 只在会话开头被读一次，而「到底重发代码还是 edit 旧文件」是在**下一轮**才决的；结果文本正好出现在那一轮的上下文里（实测 2/3 次重发代码，就是这句话要打的点）。提示**不做相似度打分**：purpose 用什么语言写都不一定，模糊匹配会瞎认亲；只把邻居名字摆出来让模型自己判断。`PI_IPY_QUIET=1` 把这两行整体关掉，供 A/B 对照（`scripts/acc-reuse.sh`）。
- **放 /tmp 而不是用户缓存目录**：/tmp 会话级、重启自清，不污染 git、不触发"脏仓库"守卫，与 Claude Code 一致。代价是跨会话不可复用——这是有意接受的。
- **复用靠内容 hash，不靠时间戳**：同名同内容 = 复用（不改文件、不改 mtime）；同名新内容 = 覆写，这就是"改脚本"。hash 只做判据，文件名始终是模型给的语义名——因为 40 轮后模型能记住 `parse_logs.py`，记不住 `a3f9c1.py`。
- **合并修改与运行**：`path + edits` 是新增的可选调用形态，原有 `code` / `path` / `list` 保持兼容；沿用 pi 的原文件唯一匹配、禁止重叠语义，让小改动不必先调内置 `edit` 再调 `ipy`。文件仍可用内置工具编辑。模型是否选择该形态、是否节省整轮 token/耗时，需用固定输入验收，不能由工具调用数直接推断。
- **不自动 pip install**：`ModuleNotFoundError` 原样回给模型，由它决定装不装。装依赖是副作用很大的动作，不该藏在"跑个脚本"里面。
- **杀进程用 `kill(-pid)` 杀整组**：脚本常常自己再 spawn 子进程；只杀直接子进程会留下孤儿。`detached: true` + 负 pid 是唯一可靠做法，smoke 里有专门的孙子进程用例守着。
- **输出截断沿用 pi 自己的尺度**（`DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`，全量落盘并把路径回给模型）：和 bash 工具行为对齐，模型不用学第二套。

## 六、扩展点

- 加一种调用模式：在 `Mode` 联合里加分支 + `parseInput()` 判分支 + `execute` 里补渲染，别做成可选字段互相组合。
- 换解释器：`PI_IPY_PYTHON` 环境变量，不要改代码默认值。
- 跨会话复用：目前**明确不做**。真要做，改 `store.sessionDir()` 的根目录并自己管回收——但那会连带引入清理策略，属于重新评估这个取舍，先改本文。
- 禁止：在 `index.ts` 里绕过 `lib/store.ts` 自己拼路径；在工具里 `execSync` 图省事。
