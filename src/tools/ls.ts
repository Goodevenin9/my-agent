import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "../types";

// 对应 Pi 的 ls。
const DEFAULT_LIMIT = 500;

export const lsTool: Tool = {
	name: "ls",
	effect: "read",
	description:
		"列出一个目录的内容。按字母排序，目录名带 '/' 后缀。包含点文件（隐藏文件）。",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "目录，默认当前目录" },
			limit: { type: "number", description: `最多返回多少条（默认 ${DEFAULT_LIMIT}）` },
		},
	},
	async execute(args) {
		const dir = args.path ? String(args.path) : ".";
		const limit = args.limit ? Number(args.limit) : DEFAULT_LIMIT;
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			const names = entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name));
			names.sort((a, b) => a.localeCompare(b));
			const shown = names.slice(0, limit);
			const suffix =
				names.length > limit ? `\n...（共 ${names.length} 条，已截断到 ${limit}）` : "";
			return (shown.join("\n") || "(空目录)") + suffix;
		} catch (err) {
			return `列目录失败: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
};
