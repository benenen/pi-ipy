# 代码 checklist（强制自检）

> 写完 / 改完代码必须逐条对照的硬性自检清单；新增条目直接追加本文件。

本文件由 `AGENTS.md`（即 `CLAUDE.md`）拆出，收敛「写代码时必须逐条自检」的硬性条目。顶层只留一条强制指针，条目细节都在这里；新增条目直接追加到本文件，不要写回 `AGENTS.md`。

**通用条目**是跨语言的硬红线；**语言专项**由 agents-dot-md skill 的 `scaffold.py` 按本仓库实际语言注入，是该语言公认的固定规范。落地时请按本项目实际情况增删改——不适用的直接删掉，别留着占位；踩过的坑按下面的格式追加。

## 怎么写一条 checklist

每条包含三部分，缺一不可——只写规则不给例子，下一个 agent 照样会踩：

1. **规则**：一句话说清「必须怎样 / 禁止怎样」。
2. **反例**：真实踩过的写法，标明后果（报什么错、线上出过什么事故）。
3. **正例**：照抄就对的写法。

条目来源优先级：**线上事故 > 评审反复提的意见 > 团队口头约定**。没踩过的坑不必预防性地写进来，这里只放硬性红线；软性建议归 `coding-guidelines.md`。

---

# 通用条目（跨语言）

## 1. 不引入 `node_modules`、不加构建步骤

本仓库所有 `import`（含 `typebox`、`@earendil-works/pi-coding-agent`）都由 pi 的 jiti 别名表在运行时分发。一旦本地装上依赖，加载路径就分叉成「本地解析 vs pi 解析」两套，问题极难复现。

- 反例：为跑 `tsc --noEmit` 而 `npm i -D typescript` → 顺带生成 `node_modules/` + lock 文件，`pi -e ./index.ts` 与软链安装下的解析行为可能不一致；本机根本没有 `tsc`，那条 `check` 脚本是死的。
- 正例：验证一律走 `node scripts/smoke.mjs`（自己用 `PI_PACKAGE_ENTRY` 指向 pi 的本地安装），类型问题交给编辑器 LSP。

## 2. 禁止 1+N：循环里不查库、不调远程接口

循环体内逐条查询 / RPC / HTTP 调用，量一上来就是必然的超时事故。

- 反例：逐个 id 查一次库，`N` 条数据打 `N` 次请求。
- 正例：一次批量查询后在内存里按 key 分组；远程调用同理，优先批量接口。

## 3. 工具的 schema 与提示文案是对外契约

`parameters` / `outputSchema` 的字段名、`description` / `promptSnippet` / `promptGuidelines` 的措辞都是契约：前者被模型和 codemode 脚本依赖，后者直接决定模型的选择倾向。改任何一个都要有验收依据。

- 改字段名 / 加 `outputSchema` 字段：先确认 codemode 调用方，破坏性变更要并存而不是就地改语义。
- 改提示文案：必须做 A/B（做法见 `environment.md` 的《验收 A/B》），凭「我觉得这样更清楚」改 prompt 是本仓库最容易踩的坑。
- `promptGuidelines` 只写划界（什么用 ipy、什么用 bash），不写号召；当前刻意只有 2 条。

## 4. 敏感信息不入库

密钥、密码、token、内网凭据一律不写进受版本控制的文件（含配置文件、测试用例、注释、提交信息）。走环境变量或配置中心；本地开发凭据放未入库文件（见 `environment.md`）。

提交前自检：`git diff` 里有没有出现形如密码 / `AK` / `SK` / 私钥的字面量。

## 5. 沿用既有技术选型，不引入第二套同类方案

新增三方依赖前先检查：根构建文件是否已有同类能力、能否复用项目内的公共封装。无充分理由不得并存两套 HTTP 客户端 / ORM / JSON 库 / 日志门面。

分层、命名、依赖注入方式跟随所在模块既有风格（详见 `tech-stack.md`），不做跨模块风格漂移。

## 6. 路径与进程：两条踩过就非常难查的线

**6.1 凡是用「模型给的名字」拼路径，必须先消毒再断言在界内**。

- 反例：`join(dir, params.name)` 直接用 → `name: "../../evil"` 写到会话目录外；`name: "/etc/x"` 直接覆盖绝对路径。
- 正例：`sanitizeName()`（取 basename + 白名单 `[A-Za-z0-9._-]`，见 `lib/store.ts`）之后再 `assertInside(dir, target)`；写入走临时文件 + `rename`，避免被杀时留半截文件。

**6.2 子进程要按进程组杀，不能只杀直接子进程**。

- 反例：`child.kill()` 只干掉 `python3`，脚本自己 spawn 的子进程活成孤儿、继续占资源。
- 正例：`spawn(..., { detached: true })` + `process.kill(-pid, sig)`（先 TERM、宽限 2s 再 KILL，见 `lib/run.ts` 的 `killGroup`）；smoke 里有专门的孙子进程用例守着这条。

**6.3 工具报错要给下一步动作**。读报错的大概率是模型，`no script at /tmp/...` 这种信息它无处下手。正例：一并给出 `ipy({list:true})` 和「用 `code` 重写」两条恢复路径。

---

# JavaScript 专项

## S1. 一律 `===`，声明用 `const` / `let`

禁止 `==`（隐式类型转换）和 `var`（函数作用域 + 提升）。默认 `const`，需要重新赋值才用 `let`。

## S2. 不允许游离的 Promise

异步调用必须 `await`、`return`，或显式 `.catch(...)`。漏掉会变成 unhandled rejection——Node 18+ 默认直接让进程退出。

- 反例：`doAsync()` 单独一行
- 正例：`await doAsync()` / `void doAsync().catch(err => log.error(...))`

## S3. 循环里不串行 await（1+N 的 JS 版）

`for (const id of ids) { await fetchOne(id) }` 会把 N 次请求串起来。改用 `Promise.all(ids.map(...))`；量大时用并发上限池，别一次打爆下游。

## S4. 错误对象整体交给日志，不要只打 message

`console.error(err.message)` 丢掉堆栈和 cause。传整个 error 对象；跨层抛出时用 `new Error("上下文", { cause: err })` 保留链路。

## S5. 捕获要精确，不吞错

禁止空 `catch {}`。`try` 块只包住可能抛错的那几行，不要整个函数体裹一层。

## S6. 模块顶层不做副作用 I/O

顶层只做定义与导出；连接、读配置、发请求放进显式的初始化函数，避免 import 顺序决定运行结果。

## S7. 对外数据必须校验后再用

接口返回、`JSON.parse` 结果、用户输入在使用前先校验形状与必填字段，不要直接深层解构后透传到下游。

---

# TypeScript 专项

> 以下条目叠加在《JavaScript 专项》之上，JS 的条目同样适用。
>
> 本仓库**没有 `tsconfig.json`、也没有 `tsc`**（见上文通用条目 1），所以 T1 的落点是「写代码时按 `strict` 的标准要求自己」，而不是去加一个配置文件。

## T1. `strict` 必开，禁止关掉 `strictNullChecks`

`tsconfig.json` 保持 `"strict": true`。新模块不得单独放宽严格性开关来绕过报错。

## T2. 禁 `any`，不确定用 `unknown` 再收窄

外部数据先声明为 `unknown`，用类型守卫 / schema 校验（zod 等）收窄后再使用。项目若开了 `no-explicit-any` lint 规则，不要用注释豁免。

## T3. 不用 `as` 强断言绕过类型系统

`as` 只在你比编译器多掌握信息、且写明理由时使用；禁止 `as any as T` 这种双重断言。需要运行时保证的地方写类型守卫函数（`x is T`）。

## T4. 用 `@ts-expect-error` 而非 `@ts-ignore`，且必须注明原因

`@ts-expect-error` 在错误消失后会自己报错提醒清理，`@ts-ignore` 会永远静默。两者都要跟一行说明「为什么必须忽略、何时可以删」。

## T5. 对外 API 显式标注返回类型

导出的函数、hook、service 方法写明返回类型，不依赖推断——推断结果会随实现改动悄悄变化，破坏调用方而编译不报错。

## T6. 用可辨识联合表达互斥状态

`{ status: "loading" } | { status: "ok"; data: T } | { status: "error"; error: Error }`，而不是一堆可选字段（`data?`、`error?`、`loading?`）互相组合出非法状态。

## T7. 类型与运行时校验在边界处对齐

接口响应、环境变量、localStorage 等外部输入，类型声明必须配一个运行时校验；只写 `interface` 不校验等于没有保证。
