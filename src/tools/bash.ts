import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "../types";

const run = promisify(exec);

// 对应 Pi 的 bash。Windows 下 exec 默认走 cmd.exe。
export const bashTool: Tool = {
	name: "bash",
	effect: "execute",
	description:
		"执行一条 shell 命令，返回标准输出和标准错误。可用 timeout 指定超时秒数（默认 30）。" +
		"输出过大时会自动截断（保留末尾）并把完整输出落盘。",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "要执行的命令" },
			timeout: { type: "number", description: "超时时间（秒），可选，默认 30" },
		},
		required: ["command"],
	},
	async execute(args, ctx) {
		const timeout = args.timeout ? Number(args.timeout) * 1000 : 30_000;
		try {
			const { stdout, stderr } = await run(String(args.command), {
				timeout,
				maxBuffer: 10 * 1024 * 1024,
				signal: ctx?.signal,
			});
			return (stdout + stderr).trim() || "(命令执行完成，没有输出)";
		} catch (err) {
			if (ctx?.signal?.aborted) return "命令已取消（用户中断）";
			// 命令失败也返回文字（含 stderr），让模型自己修正
			return `命令失败: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
};
