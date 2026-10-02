# 技术栈与实现规范

> 技术选型、约定与验证命令；写代码前先看本文，按既有方式扩展。

本文回答「这个项目用了什么、新代码该照着什么写、改完怎么验证」。**系统结构与设计取舍在 `architecture.md`**，两边别重复。

## 一、项目概览

- 定位：给 pi coding agent 增加一个 `ipy` 工具——把「写个脚本跑一下」从 `bash -c "python3 - <<EOF"` 引到「落盘成一个可复用、可 `edit` 的 `.py` 文件」。
- 仓库形态：单包、**无构建步骤**。`index.ts` 由 pi 的 jiti 直接加载，改完即生效。
- 语言：TypeScript（宿主 Node 24），被调用的解释器是 Python 3。
- 结构总览：见 `architecture.md`

## 二、核心技术栈

| 类别 | 选型 | 版本 | 备注 |
|---|---|---|---|
| 运行时 | Node.js | 24.21.0 | pi 自带的那个，不单独装 |
| 扩展宿主 | `@earendil-works/pi-coding-agent` | peerDependency | API 由 pi 在运行时注入 |
| Schema | `typebox` | 由 pi 转发解析 | `import { Type } from "typebox"` |
| 被调解释器 | `/usr/bin/python3` | 3.14.4 | 可用 `PI_IPY_PYTHON` 覆盖 |
| 构建工具 | 无 | — | 故意不加：jiti 直载 TS，加了反而多一层 |

**不要引入 `node_modules`**：仓库里所有 `import` 都靠 pi 的 jiti 别名表在运行时解析（见 `scripts/smoke.mjs` 的 `PI_PACKAGE_ENTRY` 常量）。一旦本地装上依赖，加载路径就会分叉成"本地解析 vs pi 解析"两套，很难查。

## 三、pi 扩展的写法约定

- 每个扩展 `export default function (pi: ExtensionAPI) { ... }`，在函数体内 `pi.registerTool({...})`。
- 工具的四件套必须齐：`description`（路由文本，既说做什么也说何时用）、`promptSnippet`（一行简介）、`promptGuidelines`（**常驻系统提示**，只在工具激活时注入）、`parameters`。
- `execute(id, params, signal, onUpdate, ctx)`：`signal` 必须接、必须真的能中断；`ctx.cwd` 是工作目录，`ctx.sessionManager.getSessionId()` 拿会话 id。
- 想让 codemode 脚本也能调本工具，就声明 `outputSchema` 并返回 `structuredContent`。
- `annotations: { readOnlyHint: false, openWorldHint: true }`（本工具会跑任意脚本，必须如实标注）。

## 四、`promptGuidelines` 的预算（重要）

guideline 是常驻 system prompt，**只写划界，不写号召**，多了会稀释成噪音。当前刻意只有 2 条（`index.ts` 的 `promptGuidelines`）：

1. 「写程序用 ipy，短文件/命令用 bash」——分工划清；
2. 「重跑用 `ipy({path})`，改脚本用 `edit` 改文件，不要重发代码」——复用闭环。

pi 自身已经把 bash 框成「文件操作」（`ls, rg, find`），所以"写程序"这个槽位本来是空的，ipy 占的是这个槽位。**不要**再加"记得用 ipy"这类号召式条目。

## 五、验证与测试

改完代码至少跑一遍：

```bash
# 全量自检（42 项），不需要 API key、不调模型
node scripts/smoke.mjs
```

`scripts/smoke.mjs` 走 pi **真实的扩展加载器**（`discoverAndLoadExtensions`）拿到注册结果，再直接驱动 `definition.execute(...)`。覆盖：三种调用模式、名字消毒、内容复用、按路径重跑、argv、非零退出、截断、超时、abort、**abort 是否连孙子进程一起杀**。

> 本机没有 `tsc`，仓库里也没有 `tsconfig.json` / `node_modules`，因此**没有类型检查脚本**——不要为了"补一个 check 命令"而引入 typescript 依赖。类型问题靠编辑器 LSP 和 smoke 用例暴露。

改「模型会不会真的先用 ipy」这一类行为，smoke 测不出来，要做 A/B：见 `environment.md` 的《验收 A/B》。

## 六、其他约定

- 代码注释一律英文（用户 2026-10-02 要求，见 `docs/memory/`）。
- 提交规范：conventional commits 风格，无 commit 前置检查。
- 日志/报错：错误信息以 `ipy: ` 开头，且**要给出下一步动作**（例：脚本不存在时提示 `ipy({list:true})`），因为读它的通常是模型。
