# 已知坑与实测结论

> ipy 实现与「模型会不会真用」相关的实测记录；动手改工具面或提示文案前先扫一遍。

- **2026-10-02｜模型会省略 `name` 参数（3/3 次真实调用都没给）**。落成 `script_232635.py` 这种名字——40 轮后模型既记不住也引用不回来，"复用"就成了空话（现象来自 `/tmp/ipy-acc/a.json` 与 `b.json` 的工具调用序列）。→ 结论：`index.ts` 的 `fallbackName()` 改为优先按 `purpose` 推导语义名（`purpose: "top-3 tools per pi session file"` → `tool_calls_by_session.py`，实测已验证），时间戳名只作最后兜底。
- **2026-10-02｜`truncateMiddle` 不在 pi 的导出面上**。包只导出 `truncateHead` / `truncateTail` / `truncateLine` / `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` / `formatSize` 等；照 bash 工具体验直接写 `truncateMiddle(...)` 会在运行时报 `TypeError: (0 , _piCodingAgent.truncateMiddle) is not a function`（类型检查也拦不住——本仓库没有 tsc）。→ 结论：codemode 用的 `structuredContent.stdout/stderr` 改用 `truncateHead`（1 MiB / 2000 行），模型看的文本视图仍用 `truncateTail`（保尾部、对齐 bash 工具）。
- **2026-10-02｜单跑的 A/B 是噪声，不能当证据**。同一模型（`deepseek-v4.1-flash`）、**逐字节相同的系统提示**（比对过 guideline 与 snippet）、同一提示词，`scripts/acc-rate.sh` 实测 n=4 时 ipy 命中 3/4；而另一次 5 轮会话（`/tmp/ipy-acc/base/`）5 轮一次 ipy 都没用——`ipy` 工具当时确实已加载、guideline 也在系统提示里。→ 结论：这类问题只能报比率，且必须 `--model` 钉死模型；此前 environment.md 里「guideline 咬上了」的单次结论已按此重写。
- **2026-10-02｜「改一下刚才那个脚本」多数仍是重写（已量化，至 n=11/组仍测不出 nudge 的效果）**。`scripts/acc-reuse.sh`（第 1 轮建脚本、第 2 轮提个小改动，同一会话）：有 nudge 组 **严格 edit+重跑 4/11**（edit 或仅按路径重跑 5/11、重写 3、bash 1、没调工具 1），`PI_IPY_QUIET=1` 对照组 **严格 2/11**（宽松 5/11、重写 5、bash 1）。两边宽松口径完全一样（5/11 vs 5/11），严格口径方向偏好但 n=11 分不开（Fisher p≈0.6）。
  → **结论：`create` 结果里那句 `to change it: edit that file, then ipy({path})` 效果未证实**（代码保留：一行、代价低，且严格口径方向偏好；但文档里不得当成有效杠杆，也不再加第二条同类句子）。
  → **关键领悟：噪声地板比要测的效应还大**。nudge 在第 1 轮一字影响不了，而两组第 1 轮发了 19 份 vs 27 份完整脚本（相差 40%）——n=11 时任何 ≤ 这个尺度的效应都测不出来；要定这件事得 n≈25/组，或换更干净的判据。
  → **真正的开销大头在同一轮内的反复重发，不是第 2 轮**：对照组有一例一轮发了 5 遍完整脚本（manifest 全 `create`）；处理组有一例 `1 create + 5 run`——同一模型里这行为做得到。
  → 另记一个**不调工具也报成已完成**的失败：有一例第 2 轮一次工具都没调，手算了百分比（数字算对了），却在回答里写「脚本已更新：`/tmp/pi-ipy-1000/stats.py`」——文件根本没动。「改脚本」这类小改动在上下文里可心算时，模型会跳过工具并误报落地；这类情况任何写在工具结果里的 nudge 都碰不到。
- **2026-10-02｜`sessionDir()` 只用 sessionId 前 8 位，手写 id 会撞**。实测 `--session-id ipy-reuse-base-1790955872` 落进 `/tmp/pi-ipy-1000/ipy-acc-ipy-reus/`——两个前 8 位相同的手写 id 会共用同一个脚本目录（`list` 会列出别人的脚本）。pi 自己生成的 `01a0fd2b-...` 这类 UUID 前缀足够唯一，所以暂不改目录布局；但**用 `--session-id` 手写 id 时要保证前 8 个字符唯一**（验收脚本因此用随机 hex 前缀）。
