import type { AgentEvent } from "./events";
import {
	bold,
	cyan,
	dim,
	gray,
	red,
	styleLines,
	thinking,
	yellow,
} from "./style";

// 事件 → 终端输出。核心不认识颜色，只发事件；这里才是「界面」。
// 想换界面（JSON、TUI、网页）只要再写一个消费者就行。

// 流式渲染状态：当前正在流式输出「思考」还是「回答」，以及是否已经打过行首
let streamMode: "thinking" | "assistant" | null = null;

/** 结束当前流式块：补一个换行。非流式事件打印前都要先调用。 */
function flushStream(): void {
	if (streamMode !== null) {
		process.stdout.write("\n");
		streamMode = null;
	}
}

function fmtCost(v: number | null): string {
	return v === null ? "（未配置价目表）" : `$${v.toFixed(4)}`;
}

export function renderEvent(e: AgentEvent): void {
	switch (e.type) {
		// ── 流式增量 ──────────────────────────────
		case "thinking_delta":
			if (streamMode !== "thinking") {
				flushStream();
				process.stdout.write("\n" + dim("💭 思考:") + "\n");
				streamMode = "thinking";
			}
			process.stdout.write(thinking(e.text));
			break;
		case "assistant_delta":
			if (streamMode !== "assistant") {
				flushStream();
				process.stdout.write("\n" + bold("🤖 "));
				streamMode = "assistant";
			}
			process.stdout.write(yellow(e.text));
			break;

		// ── 非流式事件 ────────────────────────────
		case "turn_start":
			flushStream();
			console.log(
				"\n" +
					dim(`──────── 第 ${e.turn} 轮：把 ${e.messageCount} 条消息发给模型 ────────`),
			);
			break;
		case "thinking":
			flushStream();
			console.log("\n" + dim("💭 思考:"));
			console.log(styleLines(e.text, thinking));
			break;
		case "assistant":
			flushStream();
			console.log("\n" + bold("🤖 ") + styleLines(e.text, yellow) + "\n");
			break;
		case "tool_call":
			flushStream();
			console.log("\n" + bold(cyan(`🔧 模型要调用工具: ${e.name}`)));
			console.log(cyan(`   参数: ${e.args}`));
			break;
		case "tool_result": {
			flushStream();
			const preview =
				e.output.length > 300
					? e.output.slice(0, 300) +
						`\n   ...（共 ${e.output.length} 字符，已截断显示）`
					: e.output;
			console.log(dim(e.isError ? "   ❌ 结果:" : "   ✅ 结果:"));
			console.log(gray("   " + preview.replace(/\n/g, "\n   ")));
			break;
		}
		case "usage":
			flushStream();
			console.log(
				dim(
					`   💰 本轮 ${e.totalTokens} token（入 ${e.promptTokens} / 出 ${e.completionTokens}` +
						(e.cachedTokens > 0 ? ` · 缓存命中 ${e.cachedTokens}` : "") +
						`） · 会话累计 ${e.sessionTokens} token · 花费 ${fmtCost(e.sessionCostUsd)}`,
				),
			);
			break;
		case "compaction_start":
			flushStream();
			console.log(dim(`\n🗜️  上下文约 ${e.tokens} token，超过预算，开始压缩…`));
			break;
		case "compaction":
			flushStream();
			console.log(
				dim(
					`   ✅ 压缩完成：${e.tokensBefore} → ${e.tokensAfter} token（摘要 ${e.summaryChars} 字）`,
				),
			);
			break;
		case "retry_start":
			flushStream();
			console.log("\n" + yellow(`⏳ 请求失败：${e.error}`));
			console.log(
				dim(
					`   将在 ${(e.delayMs / 1000).toFixed(1)}s 后重试（${e.attempt}/${e.maxAttempts}）…`,
				),
			);
			break;
		case "retry_end":
			flushStream();
			console.log(
				e.success
					? dim(`   ↩︎ 第 ${e.attempt} 次重试成功`)
					: red(`   重试 ${e.attempt} 次后仍失败`),
			);
			break;
		case "notice":
			flushStream();
			console.log(dim(`   ℹ️  ${e.text}`));
			break;
		case "error":
			flushStream();
			console.log("\n" + red(`⚠️  ${e.message}`) + "\n");
			break;
		case "agent_end":
			flushStream();
			break;
	}
}
