import { MODEL, client } from "./config";
import type { Message } from "./types";

/**
 * 「总结式压缩」—— Pi 的 compaction 的简化版。
 *
 * 上下文快撑爆窗口时，不是简单地把旧消息**扔掉**（那会丢语义），
 * 而是让模型把旧消息**总结成一份结构化摘要**，再用摘要替换掉它们。
 * 既省 token，又不会「忘记」之前做过什么。
 *
 * 对应 Pi 的：core/compaction/compaction.ts
 */

// 摘要消息的标记。下次压缩时靠它认出「上一份摘要」，把它一起带上（累加）。
export const SUMMARY_MARKER = "【历史摘要】";

/** 粗略估算一段消息有多少 token。没有分词器，用字符数换算。 */
export function estimateTokens(messages: Message[]): number {
	let chars = 0;
	for (const m of messages) {
		chars += (m.content ?? "").length;
		if (m.role === "assistant" && m.tool_calls) {
			chars += JSON.stringify(m.tool_calls).length;
		}
	}
	// 英文约 4 字符/token，中文约 1.5~2 字符/token。取 2.5 偏保守：宁可早点压缩。
	return Math.ceil(chars / 2.5);
}

/**
 * 把消息序列化成纯文本，喂给「摘要模型」。
 * 工具结果太长就截断到 2000 字符（Pi 也这么做，防止摘要请求本身爆掉）。
 */
export function serializeConversation(messages: Message[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		if (m.role === "system") {
			lines.push(`[System]: ${m.content}`);
		} else if (m.role === "user") {
			lines.push(`[User]: ${m.content}`);
		} else if (m.role === "assistant") {
			if (m.content) lines.push(`[Assistant]: ${m.content}`);
			if (m.tool_calls?.length) {
				const calls = m.tool_calls
					.map((c) => `${c.function.name}(${c.function.arguments})`)
					.join("; ");
				lines.push(`[Assistant tool calls]: ${calls}`);
			}
		} else {
			const text =
				m.content.length > 2000
					? m.content.slice(0, 2000) +
						`...（已截断，共 ${m.content.length} 字符）`
					: m.content;
			lines.push(`[Tool result]: ${text}`);
		}
	}
	return lines.join("\n");
}

/**
 * 找切割点：从最新往回数，保留至少 keepRecentTokens 个 token，
 * 剩下的旧消息交给摘要。返回「保留区」的起始下标。
 *
 * 关键约束：切割点**不能落在 tool 消息上**——它必须和对应的 assistant
 * tool_calls 待在一起，否则模型会收到一条「孤儿工具结果」直接报错。
 * （Pi 里的规则：never cut at tool results）
 */
export function findCutPoint(history: Message[], keepRecentTokens: number): number {
	let acc = 0;
	let cut = history.length;
	for (let i = history.length - 1; i >= 1; i--) {
		acc += estimateTokens([history[i]]);
		cut = i;
		if (acc >= keepRecentTokens) break;
	}
	while (cut > 1 && history[cut].role === "tool") cut--;
	return cut;
}

/** 历史开头若已有上一轮压缩留下的摘要，读出来（用于累加），并返回真正开始总结的位置。 */
function readPreviousSummary(history: Message[]): { text: string; start: number } {
	const m = history[1];
	if (
		m &&
		m.role === "system" &&
		typeof m.content === "string" &&
		m.content.startsWith(SUMMARY_MARKER)
	) {
		return { text: m.content, start: 2 };
	}
	return { text: "", start: 1 };
}

const SUMMARY_PROMPT = [
	"你是对话压缩助手。把下面这段 Agent 与用户的对话历史，压缩成一份结构化的中文摘要，",
	"供 Agent 之后继续干活时使用。只输出摘要本身，不要寒暄。",
	"",
	"必须包含这些小标题：",
	"## 目标",
	"## 约束与偏好",
	"## 进展（已完成 / 进行中 / 受阻）",
	"## 关键决定",
	"## 下一步",
	"## 关键上下文",
	"",
	"要求：",
	"- 保留文件路径、命令、变量名、报错等关键细节。",
	"- 明确区分「已经做完」和「还没做」，不要含糊。",
	"- 目标是让人能接着干，而不是复述对话。",
].join("\n");

export interface CompactionResult {
	history: Message[];
	summary: string;
	// 压缩后「原样保留」的那些消息（写进数据库的 compaction 条目，用于重建上下文）
	kept: Message[];
	tokensBefore: number;
	tokensAfter: number;
	// 摘要这次调用消耗的 token（计入总成本）
	usage?: { promptTokens: number; completionTokens: number };
}

/** 执行一次压缩：把旧消息总结成一段摘要，再用摘要替换掉它们。 */
export async function compact(
	history: Message[],
	keepRecentTokens: number,
	instructions?: string,
): Promise<CompactionResult> {
	const tokensBefore = estimateTokens(history);
	const { text: previousSummary, start } = readPreviousSummary(history);
	const cut = findCutPoint(history, keepRecentTokens);
	const toSummarize = history.slice(start, cut);
	const kept = history.slice(cut);

	if (toSummarize.length === 0) {
		throw new Error("没有可压缩的旧消息");
	}

	const payload =
		(instructions ? `【本次压缩的额外要求】\n${instructions}\n\n` : "") +
		(previousSummary ? `【更早的摘要】\n${previousSummary}\n\n` : "") +
		serializeConversation(toSummarize);

	const res = await client.chat.completions.create({
		model: MODEL,
		messages: [
			{ role: "system", content: SUMMARY_PROMPT },
			{ role: "user", content: payload },
		],
	});
	const summary =
		res.choices[0]?.message?.content?.trim() || previousSummary || "（摘要生成失败）";

	// 摘要作为一条 system 消息插在系统提示词后面，然后接上「保留区」
	const summaryMessage: Message = {
		role: "system",
		content: `${SUMMARY_MARKER}\n${summary}`,
	};
	const nextHistory: Message[] = [history[0], summaryMessage, ...kept];

	return {
		history: nextHistory,
		summary,
		kept,
		tokensBefore,
		tokensAfter: estimateTokens(nextHistory),
		usage: res.usage
			? {
					promptTokens: res.usage.prompt_tokens ?? 0,
					completionTokens: res.usage.completion_tokens ?? 0,
				}
			: undefined,
	};
}
