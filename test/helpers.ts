import { client } from "../src/config";

// 测试用的「假模型」工具：把一段脚本化的回复变成流式 chunk。
// 这样测循环、重试、取消、权限门……都不用花真 token。

export interface ScriptedTurn {
	content?: string;
	reasoning?: string;
	toolCalls?: { id: string; name: string; args: string }[];
	usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
	finishReason?: string;
}

/** 把一段回复切成流式 chunk（故意把 content / arguments 拆成两半，检验聚合）。 */
export function streamChunks(turn: ScriptedTurn): any[] {
	const chunks: any[] = [];
	if (turn.reasoning) {
		chunks.push({
			choices: [{ index: 0, delta: { reasoning_content: turn.reasoning } }],
		});
	}
	if (turn.content) {
		const mid = Math.ceil(turn.content.length / 2);
		chunks.push({
			choices: [{ index: 0, delta: { content: turn.content.slice(0, mid) } }],
		});
		chunks.push({
			choices: [{ index: 0, delta: { content: turn.content.slice(mid) } }],
		});
	}
	for (const [i, tc] of (turn.toolCalls ?? []).entries()) {
		const mid = Math.ceil(tc.args.length / 2);
		chunks.push({
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: i,
								id: tc.id,
								type: "function",
								function: { name: tc.name, arguments: tc.args.slice(0, mid) },
							},
						],
					},
				},
			],
		});
		chunks.push({
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [{ index: i, function: { arguments: tc.args.slice(mid) } }],
					},
				},
			],
		});
	}
	chunks.push({
		choices: [{ index: 0, delta: {}, finish_reason: turn.finishReason ?? "stop" }],
		usage: turn.usage,
	});
	return chunks;
}

function asAsyncIterable(chunks: any[]) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const c of chunks) yield c;
		},
	};
}

/** 让假模型按顺序返回脚本化的回复（最后一个会重复使用）。
 *  非流式调用（例如压缩摘要）返回固定摘要，且不消耗脚本。 */
export function scriptModel(turns: ScriptedTurn[]): void {
	let i = 0;
	(client.chat.completions as any).create = async (body: any) => {
		if (!body?.stream) {
			return {
				choices: [
					{
						message: { role: "assistant", content: "## 目标\n(测试摘要)" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
			};
		}
		const turn = turns[Math.min(i, turns.length - 1)];
		i++;
		return asAsyncIterable(streamChunks(turn));
	};
}

/** 让假模型每次都抛出指定错误。 */
export function scriptError(err: unknown): void {
	(client.chat.completions as any).create = async () => {
		throw err;
	};
}
