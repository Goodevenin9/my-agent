# my-agent

一个「从零学 Agent 原理」的脚手架。

当前状态：主循环、8+1 工具、事件流、成本核算、会话持久化（JSONL/SQLite）、总结式压缩、长期记忆、并行工具 + 写串行化、自动重试 + 可取消、流式输出、权限门均已完成；有测试套件（`npm test`）。

---

## 目录结构

```
my-agent/
├── .env.example        # 复制成 .env 填 key
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts        # ✅ 命令行界面（创建会话存储 + 消费事件）
    ├── agent.ts        # ✅ Agent 主循环（emit 事件 + 调工具 + 成本核算）
    ├── render.ts       # ✅ 事件 → 终端输出（界面与核心解耦）
    ├── events.ts       # ✅ AgentEvent 类型（核心与界面之间的契约）
    ├── cost.ts         # ✅ 成本核算（累计 token、缓存命中、按价目表换算）
    ├── output.ts       # ✅ 工具输出封顶：截断 + 落盘（对应 Pi 的 OutputAccumulator）
    ├── retry.ts        # ✅ 自动重试（错误分类 + 指数退避 + 可取消）
    ├── session-store.ts# ✅ 会话存储（JSONL / SQLite 可切，原始日志 + 上下文投影）
    ├── memory.ts       # ✅ 长期记忆（跨会话；信任分档 + 密钥过滤）
    ├── config.ts       # ✅ 读 .env、模型客户端、可调参数
    ├── compaction.ts   # ✅ 总结式压缩（Pi compaction 的简化版）
    ├── types.ts        # ✅ 消息 / 工具的类型定义（先读懂它）
    └── tools/
        ├── index.ts       # ✅ 工具注册表（10 个工具：8 个对齐 Pi + memory + compact）
        ├── read.ts        # ✅ 读文件（支持 offset/limit）
        ├── write.ts       # ✅ 写文件（覆盖 / 自动建目录，写队列串行化）
        ├── edit.ts        # ✅ 精确文本替换（唯一匹配 + 防重叠，写队列串行化）
        ├── grep.ts        # ✅ 搜内容（glob / 忽略大小写 / 上下文）
        ├── find.ts        # ✅ 按 glob 找文件
        ├── ls.ts          # ✅ 列目录
        ├── bash.ts        # ✅ 执行 shell
        ├── powershell.ts  # ✅ 执行 PowerShell（Windows）
        ├── memory.ts      # ✅ 长期记忆工具（save / search / list）
        ├── compact.ts     # ✅ 压缩上下文工具（主循环拦截并执行压缩）
        ├── file-mutation-queue.ts # ✅ 同一文件的写操作串行化（移植自 Pi）
        └── utils.ts       # ✅ 递归遍历 + glob 匹配等共享工具
```

> **护栏**（`src/agent.ts`）：只保留「重复工具调用检测」（`MAX_REPEAT`）。**不设硬轮数上限**——与 Pi 一致，只要模型还在调工具就继续。防跑飞靠：人随时 `Ctrl+C` + 压缩控成本。上下文窗口、压缩参数在 `config.ts`，可用 `.env` 覆盖。
>
> **事件流**（`src/events.ts` + `src/render.ts`）：核心不打印、不依赖界面，只 `emit` 结构化事件；终端渲染、成本统计、存库都是事件的消费者。换界面（JSON / TUI / 网页）不用动核心。
>
> **成本核算 + 输出封顶**（`src/cost.ts` + `src/output.ts`）：每轮以模型 `usage` 为准累计 token（含**缓存命中** `cached_tokens`），按价目表换算美元（`.env` 的 `PRICE_*`）。工具输出封顶 2000 行 / 50KB（`bash`/`powershell` 留尾部，其余留头部）；超限就把**完整输出落盘**、消息里只留路径，模型需要时用 `read` 回读。压缩触发可用 `COMPACT_TRIGGER_TOKENS` 独立设小，以便更早省 token。
>
> **压缩工具**（`src/tools/compact.ts`）：模型可调用 `compact`（可带 `instructions` 指定侧重）主动压缩上下文。真正动作在 `src/agent.ts` 主循环里执行（需替换整个 history），并落库为压缩条目。
>
> **会话存储**（`src/session-store.ts`）：存的是**不可变的原始事件日志**（消息 + 压缩），压缩只改变「发给模型的上下文投影」，不动日志——所以压缩可逆、可审计。后端可在 JSONL 与 SQLite（`node:sqlite`，零依赖）之间切换。
>
> **自动重试 + 可取消**（`src/retry.ts` + `src/agent.ts` + `src/index.ts`）：临时性错误（429/5xx/网络/超时）按 `base*2^(n-1)` 退避重试，确定性错误（配额/400/401）立即失败；退避的等待**可被 Ctrl+C 打断**。运行时用一个 `AbortController`，signal 传进模型请求、工具、退避等待。
>
> **运行时输入接管**（`src/index.ts`）：agent 运行时接管 stdin——**忽略普通打字**（不回显，不会再打乱输出），只把 **Ctrl+C** 当作取消。
>
> **并行工具 + 写串行化**（`src/agent.ts` + `src/tools/file-mutation-queue.ts`）：一批工具调用用 `Promise.all` **并行**执行，结果按原始顺序写回历史；写文件的工具（`write`/`edit`/`memory`）把「读-改-写」套进 `withFileMutationQueue`，**同一文件排队、不同文件并行**。移植自 Pi 的 `file-mutation-queue`。
>
> **流式输出**（`src/agent.ts` + `src/render.ts`）：`stream: true` + `include_usage`，边收边 `emit` `assistant_delta` / `thinking_delta`，终端实时打印。参数分片的 `tool_calls` 按 index 聚合。
>
> **权限门**（`src/agent.ts` + `src/index.ts`）：工具带 `effect`（`read`/`mutate`/`execute`）。**默认 `APPROVAL_MODE=off`（不打扰）**；想开改成 `execute`/`mutate`/`all`，非只读工具执行前会问「[y]允许 / [n]拒绝 / [a]本次会话总是允许」，默认拒绝。
>
> **失败回滚 + 原子写**：模型调用不可恢复地失败时，回滚那条「无人回答的 user 消息」并记一条 `omission`（重建上下文时排除），内存与磁盘状态保持一致；写文件用「先写临时文件再 rename」的**原子写**，中断也不留半成品。
>
> **测试**：`npm test`（`node:test` + 假模型），覆盖重试、原子写/写队列、记忆、压缩投影、并行顺序、取消、回滚、权限门、截断保护。
>
> **长期记忆**（`src/memory.ts`）：跨会话的「蒸馏事实」，与 session 分开。**信任由来源决定，模型无法自升级**——用户明确要求记住 → `trusted`（会注入）；模型自己推断 / 来自文件 → 待审区（不注入）。写入时过滤密钥，同文本去重。只有 `trusted + active` 才注入系统提示词。
>
> **成本控制**（`src/compaction.ts`）：上下文超过「窗口 − 余量」时，让模型把旧消息**总结成结构化摘要**再替换（Goal / Progress / Next Steps…），既省 token 又不丢语义。万一压缩失败，才退回硬裁剪。对应 Pi 的 `core/compaction/`。

---

## 第一步：跑起来

```bash
cd my-agent
npm install
cp .env.example .env     # Windows: copy .env.example .env
# 然后用编辑器打开 .env，填上你的 OPENAI_API_KEY
npm start
```

现在你会看到一句报错：

```
TODO: 还没实现 runAgent...
```

**这是故意的**——去 `src/agent.ts` 把它实现掉。

---

## 学习任务（按顺序做，别跳）

### 任务 1：实现 Agent 主循环 ⭐最重要

打开 `src/agent.ts`，里面用注释写清楚了 6 个步骤。照着写，完成后 `npm start` 就能对话了。

试着对它说：

```
看下当前目录有哪些文件
```

你会看到模型自己调用 `bash`，拿到结果，再决定下一步——**这就是 Agent 的本质**。

**自检问题**（答不上来就回去看代码）：
- 为什么工具调用要放在 `while` 循环里，而不是调一次就结束？
- 为什么工具报错要「返回文字」而不是「抛异常」？
- `role: "tool"` 的消息为什么必须带 `tool_call_id`？

---

### 任务 2：并行执行工具 ✅ 已实现

看 `src/agent.ts`：一批工具调用用 `Promise.all` 并行跑，结果按原始顺序写回。

**关键**：写文件的工具自己用 `withFileMutationQueue` 把「同一文件」串行化（`src/tools/file-mutation-queue.ts`，移植自 Pi）——否则两个 `edit` 同批执行会互相覆盖。所以规则是：**读并行，写同一文件排队**。

---

### 任务 3：加一个新工具 ✅ 已实现

8 个内置工具已全部对齐 Pi：`read` `write` `edit` `grep` `find` `ls` `bash` `powershell`，见 `src/tools/`。其中 `edit` 是编程 Agent 最关键的工具。

**思考**：为什么 `write` 要在描述里告诉模型「会覆盖原文件」？描述写得好不好，直接影响模型用得对不对。

---

### 任务 4：让对话持久化 ✅ 已实现

看 `src/session-store.ts`：消息与压缩事件 append 到 JSONL / SQLite，启动时 `rebuildHistory` 重建上下文。压缩以「事件」形式落库，原始对话永不删——可回放、可审计。

---

### 任务 5：上下文压缩 ✅ 已实现

看 `src/compaction.ts`：上下文超过「窗口 − 余量」时，让模型把旧消息**总结成结构化摘要**再替换掉。

**这就是 Pi 的 compaction**。特别注意 `findCutPoint` 里那条规则：切割点不能落在 `tool` 消息上——否则会造出「孤儿工具结果」让模型报错。

---

### 任务 6：流式输出 ✅ 已实现

`src/agent.ts` 用 `stream: true` + `stream_options.include_usage` 消费流，边收边 `emit` delta 事件，`src/render.ts` 实时打印。关键坑：`tool_calls.arguments` 是**分片**送来的，必须按 index 聚合。

---

## 进阶：做完上面之后

上面 6 个任务做完，你就复刻了 Pi 的核心。接下来可以去看 Pi 的文档 `docs/how-pi-works.md`，把你做的东西和它的架构一一对应：

| 你写的 | Pi 里的对应物 |
|---|---|
| `agent.ts` 的 while 循环 | `agent-loop.js` |
| `tools/` 数组 | `core/tools/` |
| JSONL 历史 | `session-manager.js` |
| 你的压缩逻辑 | `core/compaction/` |
| `index.ts` 的 readline | `pi-tui` |

---

## 卡住了怎么办

- 先看 `src/agent.ts` 里的注释，步骤写得很细。
- 报错先看最后一行英文，翻译一下通常就懂了。
- 实在写不出来，随时让 Pi 给你**参考答案 + 逐行讲解**（但先自己试至少 20 分钟，那 20 分钟才是真正学到东西的时候）。
