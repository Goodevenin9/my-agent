import type { Tool } from "../types";

// 让模型主动压缩上下文以省 token（对应 Pi 的 /compact，这里做成工具）。
// 压缩需要替换整个 history，所以真正动作由 agent 主循环执行；
// 这个工具只负责「表态」，主循环在本回合工具跑完后完成压缩。
export const compactTool: Tool = {
	name: "compact",
	description:
		"压缩当前对话上下文以节省 token：把较早的消息总结成一段摘要，摘要会替代它们继续参与对话。" +
		"当上下文很长、token 开销大，或用户要求压缩时调用。可用 instructions 指定总结时希望侧重的内容。",
	parameters: {
		type: "object",
		properties: {
			instructions: {
				type: "string",
				description: "总结时希望侧重的内容（可选）",
			},
		},
	},
	async execute() {
		return "压缩请求已登记，将在本回合工具执行完成后进行。";
	},
};
