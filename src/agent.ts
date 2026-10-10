import type { Message, ToolEffect } from "./types";
import {
	APPROVAL_MODE,
	COMPACT_TRIGGER_TOKENS,
	CONTEXT_WINDOW,
	KEEP_RECENT_TOKENS,
	MODEL,
	RESERVE_TOKENS,
	RETRY_BASE_DELAY_MS,
	RETRY_ENABLED,
	RETRY_MAX,
	RETRY_MAX_DELAY_MS,
	STREAM,
	client,
} from "./config";
import { compact, estimateTokens } from "./compaction";
import { CostTracker, resolvePricing } from "./cost";
import { type Emit, noopEmit } from "./events";
import { limitToolOutput } from "./output";
import { type RetryPolicy, AbortError, withRetry } from "./retry";
import { type SessionStore, newEntryId, nowIso } from "./session-store";
import { findTool, toOpenAITools } from "./tools/index";

const RETRY_POLICY: RetryPolicy = {
	enabled: RETRY_ENABLED,
	maxRetries: RETRY_MAX,
	baseDelayMs: RETRY_BASE_DELAY_MS,
	maxDelayMs: RETRY_MAX_DELAY_MS,
};

// 系统提示词：决定 agent 的性格、边界和行为。后面可以随意改来观察效果。
export const SYSTEM_PROMPT = [
	"你是一个命令行编码助手。",
	"可用工具：read（读文件）、write（写文件）、edit（精确替换原文）、grep（搜内容）、",
	"find（按 glob 找文件）、ls（列目录）、bash（执行 shell）、powershell（Windows）、memory（长期记忆）。",
	"修改已有代码优先用 edit 做精确替换，不要整篇重写；创建新文件用 write。",
	"当用户明确要求「记住…」、纠正了你、或你发现跨会话仍成立且无法从代码直接看出的事实时，用 memory 工具保存。",
	"上下文很长、token 开销大时，可调用 compact 工具压缩上下文。",
	"回答尽量简洁。完成用户的目标后，用一句话总结你做了什么。",
].join("\n");

// 用户本轮是否明确要求「记住」——决定记忆能否被当作可信。
// 判断基于用户原话，模型无法伪造（抗间接注入）。
const REMEMBER_RE =
	/(记住|记一下|记下|以后都|以后请|从现在起|从现在开始|接下来都|往后都|以后默认|always use|remember that|from now on|keep in mind)/i;

// ── 护栏：防止 agent 跑飞、token 失控 ──────────────────────────────
// 不设硬轮数上限（与 Pi 一致）。成本控制交给总结式压缩；
// 这里只保留一个「重复调用检测」，专治卡死式的空转。
const MAX_REPEAT = 3; // 同一组「工具 + 参数」连续重复几次，就判定卡死
const MAX_HISTORY = 40; // 压缩失败时的兜底：硬裁到多少条消息

/**
 * 兜底方案：当总结式压缩失败（比如摘要模型报错）时，退化成「直接丢掉最旧的消息」。
 * 注意：不能裁出一个「孤儿 tool 消息」——它找不到对应的 assistant tool_calls，
 * 模型会直接报错。所以裁剪后要保证从一条 user 消息开始。
 */
function emergencyTrim(history: Message[]): Message[] {
	const hasSystem = history[0]?.role === "system";
	const head = hasSystem ? [history[0]] : [];
	const rest = history.slice(hasSystem ? 1 : 0);
	if (rest.length <= MAX_HISTORY) return history;

	let kept = rest.slice(-MAX_HISTORY);
	while (kept.length && kept[0].role === "tool") kept.shift();
	const firstUser = kept.findIndex((m) => m.role === "user");
	if (firstUser > 0) kept = kept.slice(firstUser);
	return [...head, ...kept];
}

/** 权限门：某个工具执行前的确认请求。 */
export interface ApprovalRequest {
	name: string;
	args: string;
	effect: ToolEffect;
}
export type ApproveFn = (req: ApprovalRequest) => Promise<boolean>;

/** 权限门模式：什么时候需要确认。 */
export type ApprovalMode = "off" | "execute" | "mutate" | "all";

function needsApproval(mode: ApprovalMode, effect: ToolEffect): boolean {
	switch (mode) {
		case "all":
			return effect !== "read";
		case "execute":
			return effect === "execute";
		case "mutate":
			return effect === "mutate";
		default:
			return false;
	}
}

export interface RunOptions {
	/** 消费结构化事件（终端渲染、存库、统计……） */
	emit?: Emit;
	/** 会话存储；给了就把每条消息 / 每次压缩 append 进去 */
	store?: SessionStore;
	/** 取消信号：中止本次运行（会传给模型请求和工具） */
	signal?: AbortSignal;
	/** 权限门：非只读工具执行前调用，返回 false 则拒绝执行。不传则不拦截。 */
	approve?: ApproveFn;
	/** 权限门模式（默认取 .env 的 APPROVAL_MODE，即 off） */
	approvalMode?: ApprovalMode;
}

/** 一次模型回复被拼装后的结果（流式累积出来的）。 */
interface AssistantTurn {
	content: string | null;
	reasoning: string;
	tool_calls:
		| { id: string; type: "function"; function: { name: string; arguments: string } }[]
		| null;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
	};
	finishReason: string | null;
	emittedContent: boolean;
	emittedThinking: boolean;
}

/**
 * 调用模型并消费流：一边收一边 emit delta 事件，最后拼出完整回复。
 * 流式的关键坑：tool_calls 的 arguments 是**分片**送来的，必须按 index 聚合。
 */
async function streamTurn(
	history: Message[],
	signal: AbortSignal | undefined,
	emit: Emit,
): Promise<AssistantTurn> {
	const body: Record<string, unknown> = {
		model: MODEL,
		messages: history,
		tools: toOpenAITools(),
	};
	if (STREAM) {
		body.stream = true;
		body.stream_options = { include_usage: true };
	}

	const response = await client.chat.completions.create(body as never, { signal });

	let content = "";
	let reasoning = "";
	let emittedContent = false;
	let emittedThinking = false;
	const toolAcc = new Map<number, { id: string; name: string; args: string }>();
	let usage: AssistantTurn["usage"];
	let finishReason: string | null = null;

	// 非流式：一次拿到完整结果
	const asAny = response as any;
	if (!STREAM) {
		const msg = asAny.choices?.[0]?.message ?? {};
		const reasoningText = msg.reasoning_content as string | undefined;
		if (reasoningText) {
			emit({ type: "thinking", text: reasoningText });
			emittedThinking = true;
		}
		return {
			content: msg.content ?? null,
			reasoning: reasoningText ?? "",
			tool_calls: msg.tool_calls ?? null,
			usage: asAny.usage,
			finishReason: asAny.choices?.[0]?.finish_reason ?? null,
			emittedContent: false,
			emittedThinking,
		};
	}

	for await (const chunk of asAny) {
		if (chunk.usage) usage = chunk.usage;
		const choice = chunk.choices?.[0];
		if (!choice) continue;
		const delta: any = choice.delta ?? {};

		if (typeof delta.content === "string" && delta.content) {
			content += delta.content;
			emittedContent = true;
			emit({ type: "assistant_delta", text: delta.content });
		}
		if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
			reasoning += delta.reasoning_content;
			emittedThinking = true;
			emit({ type: "thinking_delta", text: delta.reasoning_content });
		}
		for (const tc of delta.tool_calls ?? []) {
			const idx: number = tc.index ?? 0;
			const cur = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
			if (tc.id) cur.id = tc.id;
			if (tc.function?.name) cur.name += tc.function.name;
			if (tc.function?.arguments) cur.args += tc.function.arguments;
			toolAcc.set(idx, cur);
		}
		if (choice.finish_reason) finishReason = choice.finish_reason;
	}

	const tool_calls = toolAcc.size
		? [...toolAcc.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([, t]) => ({
					id: t.id,
					type: "function" as const,
					function: { name: t.name, arguments: t.args },
				}))
		: null;

	return {
		content: content || null,
		reasoning,
		tool_calls,
		usage,
		finishReason,
		emittedContent,
		emittedThinking,
	};
}

/**
 * Agent 主循环。
 *
 * 设计：核心只做三件事——问模型、执行工具、把过程 emit 成事件；
 * 打印、持久化、成本统计都由外部消费事件完成。核心不依赖任何界面。
 *
 * 返回更新后的 history（供下一轮继续）。
 */
export async function runAgent(
	userInput: string,
	history: Message[] = [],
	opts: RunOptions = {},
): Promise<Message[]> {
	const emit = opts.emit ?? noopEmit;
	const store = opts.store;
	const signal = opts.signal;
	const approve = opts.approve;
	const approvalMode: ApprovalMode =
		opts.approvalMode ?? (APPROVAL_MODE as ApprovalMode);
	const cost = new CostTracker(resolvePricing());
	// 本轮用户是否明确要求「记住」——传给工具，决定记忆的信任档
	const userTurnAskedToRemember = REMEMBER_RE.test(userInput);

	// 权限门串行化：一批工具里可能有多个需要确认，逐个问，避免提示互相打断
	let approvalChain: Promise<unknown> = Promise.resolve();
	const askApproval = (req: ApprovalRequest): Promise<boolean> => {
		if (!approve) return Promise.resolve(true);
		const p = approvalChain.then(() => approve(req));
		approvalChain = p.then(
			() => undefined,
			() => undefined,
		);
		return p;
	};

	// 1. 第一次对话时，先放一条系统提示词（行为准则）
	if (history.length === 0) {
		history.push({ role: "system", content: SYSTEM_PROMPT });
	}
	// 把用户这次说的话记进账本，并落库（带 id，失败时可作废）
	const userMessage: Message = { role: "user", content: userInput };
	const userEntryId = newEntryId();
	history.push(userMessage);
	await store?.append({
		type: "message",
		ts: nowIso(),
		id: userEntryId,
		message: userMessage,
	});

	// 2. 主循环：一直转，直到模型不再要求调用工具（与 Pi 一致，无硬轮数上限）
	let turn = 0;
	let lastSignature = "";
	let repeatCount = 0;
	while (true) {
		// 已被取消 → 干净地结束本次运行
		if (signal?.aborted) {
			emit({ type: "agent_end", reason: "abort", turns: turn });
			return history;
		}
		turn++;

		// 🗜️ 每个回合开始前（上一批工具已跑完），看上下文是否超预算；
		// 超了就总结式压缩——对应 Pi 的 prepareNextTurn。
		const tokens = estimateTokens(history);
		const budget =
			COMPACT_TRIGGER_TOKENS > 0
				? COMPACT_TRIGGER_TOKENS
				: CONTEXT_WINDOW - RESERVE_TOKENS;
		if (tokens > budget) {
			emit({ type: "compaction_start", tokens });
			try {
				const r = await compact(history, KEEP_RECENT_TOKENS);
				history = r.history;
				if (r.usage) cost.add(r.usage.promptTokens, r.usage.completionTokens);
				emit({
					type: "compaction",
					tokensBefore: r.tokensBefore,
					tokensAfter: r.tokensAfter,
					summaryChars: r.summary.length,
				});
				// 压缩落库：记摘要 + 保留区，重建上下文时用
				await store?.append({
					type: "compaction",
					ts: nowIso(),
					summary: r.summary,
					kept: r.kept,
					tokensBefore: r.tokensBefore,
					tokensAfter: r.tokensAfter,
				});
			} catch (err) {
				emit({
					type: "notice",
					text: `压缩失败，退回硬裁剪：${err instanceof Error ? err.message : String(err)}`,
				});
				history = emergencyTrim(history);
			}
		}

		// 3. 把整段历史发给模型（流式 + 自动重试）
		emit({ type: "turn_start", turn, messageCount: history.length });

		let res: AssistantTurn;
		try {
			res = await withRetry(
				() => streamTurn(history, signal, emit),
				RETRY_POLICY,
				signal,
				{
					onRetryScheduled: (attempt, maxAttempts, delayMs, error) =>
						emit({ type: "retry_start", attempt, maxAttempts, delayMs, error }),
					onRetryFinished: (success, attempt) => {
						if (attempt > 0) emit({ type: "retry_end", success, attempt });
					},
				},
			);
		} catch (err) {
			// 取消不是错误：保留用户消息（可「继续」），干净收尾
			if (err instanceof AbortError || signal?.aborted) {
				emit({ type: "agent_end", reason: "abort", turns: turn });
				return history;
			}
			// 不可恢复的失败：回滚这条「无人回答的 user 消息」，并记一条 omission
			const idx = history.indexOf(userMessage);
			if (idx >= 0) history.splice(idx, 1);
			await store?.append({ type: "omission", ts: nowIso(), ids: [userEntryId] });
			emit({
				type: "error",
				message: `本轮请求失败，已回滚：${err instanceof Error ? err.message : String(err)}`,
			});
			emit({ type: "agent_end", reason: "error", turns: turn });
			return history;
		}

		// 4. 成本核算
		if (res.usage) {
			const promptTokens = res.usage.prompt_tokens ?? 0;
			const completionTokens = res.usage.completion_tokens ?? 0;
			const cachedTokens = res.usage.prompt_tokens_details?.cached_tokens ?? 0;
			cost.add(promptTokens, completionTokens, cachedTokens);
			emit({
				type: "usage",
				turn,
				promptTokens,
				completionTokens,
				cachedTokens,
				totalTokens:
					res.usage.total_tokens ?? promptTokens + completionTokens,
				sessionTokens: cost.totalTokens,
				sessionCachedTokens: cost.cachedTokens,
				costUsd: cost.costUsd,
				sessionCostUsd: cost.costUsd,
			});
		}
		// 思考兜底：万一模型没走 delta（非流式路径已单独处理）
		if (res.reasoning && !res.emittedThinking) {
			emit({ type: "thinking", text: res.reasoning });
		}

		const assistantMessage = {
			role: "assistant",
			content: res.content,
			tool_calls: res.tool_calls ?? undefined,
		} as Message;
		history.push(assistantMessage);
		await store?.append({
			type: "message",
			ts: nowIso(),
			id: newEntryId(),
			message: assistantMessage,
		});

		// 5. 没要求调工具 → 给出最终回答，结束
		if (!res.tool_calls || res.tool_calls.length === 0) {
			if (res.content && !res.emittedContent) {
				emit({ type: "assistant", text: res.content });
			} else if (!res.content) {
				emit({ type: "assistant", text: "(没说话)" });
			}
			emit({ type: "agent_end", reason: "done", turns: turn });
			return history;
		}

		// 输出被 token 上限截断：这批工具调用的参数可能不完整 → 一律不执行
		const truncated = res.finishReason === "length";

		// 🛡️ 护栏：这轮要调的「工具 + 参数」和上轮一模一样，很可能是卡死了
		const signature = res.tool_calls
			.filter((c) => c.type === "function")
			.map((c) => `${c.function.name}:${c.function.arguments}`)
			.join(" | ");
		repeatCount = signature === lastSignature ? repeatCount + 1 : 1;
		lastSignature = signature;
		if (repeatCount >= MAX_REPEAT) {
			emit({
				type: "error",
				message: `检测到连续 ${repeatCount} 次重复相同的工具调用，判定为卡死，已中止。`,
			});
			emit({ type: "agent_end", reason: "repeat", turns: turn });
			return history;
		}

		// 6. 并行执行本批工具调用（读可并行；写同一文件由工具内部排队串行化）
		const functionCalls = res.tool_calls.filter((c) => c.type === "function");

		// 模型是否要求压缩上下文（compact 工具）——真正的压缩放在本回合工具跑完后
		const compactCall = functionCalls.find((c) => c.function.name === "compact");
		let compactInstructions: string | undefined;
		if (compactCall) {
			try {
				const a = JSON.parse(compactCall.function.arguments || "{}");
				compactInstructions =
					typeof a.instructions === "string" ? a.instructions : undefined;
			} catch {
				/* 参数不合法就算了 */
			}
		}

		// 先把「这一批要调什么」全部发出去，终端能看到模型这次想干什么
		for (const call of functionCalls) {
			emit({
				type: "tool_call",
				id: call.id,
				name: call.function.name,
				args: call.function.arguments,
			});
		}

		// 并行执行：Promise.all 让多个工具同时干。
		// 注意：写文件的工具自己会用 withFileMutationQueue 把「同一文件」串行化，
		// 所以这里可以放心并行，不会出现并发覆盖。
		const results = await Promise.all(
			functionCalls.map(async (call) => {
				const started = Date.now();
				const tool = findTool(call.function.name);
				let output: string;
				let isError = false;

				if (!tool) {
					output = `没有叫 ${call.function.name} 的工具`;
					isError = true;
				} else if (truncated) {
					output = "未执行：上一条回复被 token 上限截断，参数可能不完整，请重新发起。";
					isError = true;
				} else if (tool.effect && needsApproval(approvalMode, tool.effect)) {
					// 权限门：非只读工具先问一句
					const ok = await askApproval({
						name: call.function.name,
						args: call.function.arguments,
						effect: tool.effect,
					});
					if (!ok) {
						output = "已被用户拒绝执行";
						isError = true;
					} else {
						try {
							const args = JSON.parse(call.function.arguments || "{}");
							output = await tool.execute(args, {
								userTurnAskedToRemember,
								signal,
							});
						} catch (err) {
							output = `出错: ${err instanceof Error ? err.message : String(err)}`;
							isError = true;
						}
					}
				} else {
					try {
						const args = JSON.parse(call.function.arguments || "{}");
						output = await tool.execute(args, { userTurnAskedToRemember, signal });
					} catch (err) {
						output = `出错: ${err instanceof Error ? err.message : String(err)}`;
						isError = true;
					}
				}
				// 工具输出封顶：超限就截断 + 落盘（完整输出存临时文件，消息里留路径）
				const limited = limitToolOutput(call.function.name, output);
				return {
					call,
					output: limited.content,
					isError,
					durationMs: Date.now() - started,
				};
			}),
		);

		// 关键：按「原始顺序」把结果写回历史 / 落库 / 发事件。
		// tool 消息必须和 tool_calls 一一对应且顺序一致，否则 API 会报错。
		for (const r of results) {
			emit({
				type: "tool_result",
				id: r.call.id,
				name: r.call.function.name,
				output: r.output,
				isError: r.isError,
				durationMs: r.durationMs,
			});

			const toolMessage: Message = {
				role: "tool",
				tool_call_id: r.call.id,
				content: r.output,
			};
			history.push(toolMessage);
			await store?.append({
				type: "message",
				ts: nowIso(),
				id: newEntryId(),
				message: toolMessage,
			});
		}

		// 手动压缩：模型调用了 compact → 现在工具结果都已入历史，执行压缩
		if (compactCall) {
			emit({ type: "compaction_start", tokens: estimateTokens(history) });
			try {
				const r = await compact(history, KEEP_RECENT_TOKENS, compactInstructions);
				history = r.history;
				if (r.usage) cost.add(r.usage.promptTokens, r.usage.completionTokens);
				emit({
					type: "compaction",
					tokensBefore: r.tokensBefore,
					tokensAfter: r.tokensAfter,
					summaryChars: r.summary.length,
				});
				await store?.append({
					type: "compaction",
					ts: nowIso(),
					summary: r.summary,
					kept: r.kept,
					tokensBefore: r.tokensBefore,
					tokensAfter: r.tokensAfter,
				});
			} catch (err) {
				emit({
					type: "notice",
					text: `手动压缩未执行：${err instanceof Error ? err.message : String(err)}`,
				});
			}
		}
		// 循环回到第 3 步：带着工具结果再问模型一次
	}
}
