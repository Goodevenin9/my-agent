import { relative } from "node:path";
import type { Tool } from "../types";
import { matchGlob, walkFiles } from "./utils";

// 对应 Pi 的 find：按 glob 找文件。
const DEFAULT_LIMIT = 1000;

export const findTool: Tool = {
	name: "find",
	effect: "read",
	description:
		"按 glob 模式查找文件，例如 '*.ts'、'**/*.json'、'src/**/*.spec.ts'。返回相对于搜索目录的路径。",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "glob 模式" },
			path: { type: "string", description: "搜索目录，默认当前目录" },
			limit: { type: "number", description: `最多返回多少条（默认 ${DEFAULT_LIMIT}）` },
		},
		required: ["pattern"],
	},
	async execute(args) {
		const pattern = String(args.pattern);
		const root = args.path ? String(args.path) : ".";
		const limit = args.limit ? Number(args.limit) : DEFAULT_LIMIT;
		try {
			const files = await walkFiles(root);
			const hits: string[] = [];
			for (const f of files) {
				const rel = relative(root, f);
				if (matchGlob(rel, pattern)) {
					hits.push(rel);
					if (hits.length >= limit) break;
				}
			}
			if (hits.length === 0) return `没有匹配「${pattern}」的文件（扫描了 ${files.length} 个文件）`;
			const suffix = hits.length >= limit ? `\n...（已达上限 ${limit}，请收窄模式）` : "";
			return hits.join("\n") + suffix;
		} catch (err) {
			return `查找失败: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
};
