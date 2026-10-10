import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "../types";

const run = promisify(execFile);
// 强制 PowerShell 输出 UTF-8，避免中文乱码（Pi 也这么做）
const UTF8_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}";

// 对应 Pi 的 powershell（Windows 专用）。
// 用 execFile 把命令作为参数直接传给 powershell.exe，避免经过 shell 的引号解析。
export const powershellTool: Tool = {
	name: "powershell",
	effect: "execute",
	description:
		"在 Windows 上执行一条 PowerShell 命令。其它平台不可用。可用 timeout 指定超时秒数（默认 30）。" +
		"输出过大时会自动截断（保留末尾）并把完整输出落盘。",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "要执行的 PowerShell 命令" },
			timeout: { type: "number", description: "超时时间（秒），可选，默认 30" },
		},
		required: ["command"],
	},
	async execute(args, ctx) {
		if (process.platform !== "win32") {
			return "powershell 工具仅在 Windows 上可用。";
		}
		const timeout = args.timeout ? Number(args.timeout) * 1000 : 30_000;
		const script = `${UTF8_PREFIX}\n${String(args.command)}`;
		try {
			const { stdout, stderr } = await run(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-Command", script],
				{ timeout, maxBuffer: 10 * 1024 * 1024, signal: ctx?.signal },
			);
			return (stdout + stderr).trim() || "(命令执行完成，没有输出)";
		} catch (err) {
			if (ctx?.signal?.aborted) return "命令已取消（用户中断）";
			return `命令失败: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
};
