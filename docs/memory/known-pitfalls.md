# 已知坑与实测结论

> ipy 实现与「模型会不会真用」相关的实测记录；动手改工具面或提示文案前先扫一遍。

- **2026-10-02｜模型会省略 `name` 参数（3/3 次真实调用都没给）**。落成 `script_232635.py` 这种名字——40 轮后模型既记不住也引用不回来，"复用"就成了空话（现象来自 `/tmp/ipy-acc/a.json` 与 `b.json` 的工具调用序列）。→ 结论：`index.ts` 的 `fallbackName()` 改为优先按 `purpose` 推导语义名（`purpose: "top-3 tools per pi session file"` → `tool_calls_by_session.py`，实测已验证），时间戳名只作最后兜底。
- **2026-10-02｜`truncateMiddle` 不在 pi 的导出面上**。包只导出 `truncateHead` / `truncateTail` / `truncateLine` / `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` / `formatSize` 等；照 bash 工具体验直接写 `truncateMiddle(...)` 会在运行时报 `TypeError: (0 , _piCodingAgent.truncateMiddle) is not a function`（类型检查也拦不住——本仓库没有 tsc）。→ 结论：codemode 用的 `structuredContent.stdout/stderr` 改用 `truncateHead`（1 MiB / 2000 行），模型看的文本视图仍用 `truncateTail`（保尾部、对齐 bash 工具）。
- **2026-10-02｜"改一下刚才那个脚本"没触发复用（待验证）**。续接会话里让模型改上一轮的脚本，它直接又写了一个新脚本（manifest 里 `mode: "create"`），没走 `edit` + `ipy({path})`。原因推测：短会话里旧脚本代码还在它自己的上下文里，重写比"先 edit 再重跑"更省事——复用的收益要等长会话、脚本滚出上下文后才出现。→ 尚未解决。可考虑的低成本做法：`create` 时若目录里已有 purpose 相近的脚本，在结果文本里顺带提一句已有脚本及其路径（及时提示，不占系统提示预算），而不是再加第 3 条 guideline。
