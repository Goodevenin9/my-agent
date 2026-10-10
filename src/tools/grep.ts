import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import type { Tool } from "../types";
import { matchGlob, walkFiles } from "./utils";

// 对应 Pi 的 grep：内容搜索，支持 glob 过滤、忽略大小写、字面量、上下文行。
const DEFAULT_LIMIT = 100;
const MAX_LINE_LENGTH = 200;

export const grepTool: Tool = {
	name: "grep",
	effect: "read",
	description:
		"搜索文件内容，返回「文件:行号: 内容」。可用 glob 过滤文件、ignoreCase 忽略大小写、" +
		"literal 按字面量搜、context 显示上下文行。默认跳过 node_modules/.git 等目录。",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "搜索模式（正则，或配合 literal 作为普通文本）" },
			path: { type: "string", description: "要搜索的目录或文件，默认当前目录" },
			glob: { type: "string", description: "用 glob 过滤文件，例如 '*.ts'（可选）" },
			ignoreCase: { type: "boolean", description: "忽略大小写（默认 false）" },
			literal: { type: "boolean", description: "把 pattern 当普通文本而非正则（默认 false）" },
			context: { type: "number", description: "每个匹配前后各显示几行（默认 0）" },
			limit: { type: "number", description: `最多返回多少条匹配（默认 ${DEFAULT_LIMIT}）` },
		},
		required: ["pattern"],
	},
	async execute(args) {
		const pattern = String(args.pattern);
		const root = args.path ? String(args.path) : ".";
		const glob = args.glob ? String(args.glob) : "";
		const limit = args.limit ? Number(args.limit) : DEFAULT_LIMIT;
		const ctx = args.context ? Number(args.context) : 0;

		const flags = args.ignoreCase ? "i" : "";
		let re: RegExp;
		try {
			re = new RegExp(args.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, flags);
		} catch {
			re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
		}

		try {
			// path 可能是文件，也可能是目录
			const info = await stat(root).catch(() => null);
			let files: string[];
			if (info?.isFile()) {
				files = [root];
			} else {
				files = await walkFiles(root);
			}

			const hits: string[] = [];
			for (const file of files) {
				const rel = relative(root, file) || file;
				if (glob && !matchGlob(rel, glob)) continue;
				let content: string;
				try {
					content = await readFile(file, "utf8");
				} catch {
					continue;
				}
				if (content.includes("\u0000")) continue; // 二进制，跳过
				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (!re.test(lines[i])) continue;
					const from = Math.max(0, i - ctx);
					const to = Math.min(lines.length - 1, i + ctx);
					for (let j = from; j <= to; j++) {
						const mark = j === i ? ":" : "-";
						const text = lines[j].trim().slice(0, MAX_LINE_LENGTH);
						hits.push(`${rel}${mark}${j + 1}${mark} ${text}`);
					}
					if (hits.length >= limit) break;
				}
				if (hits.length >= limit) break;
			}

			if (hits.length === 0) return `没有匹配「${pattern}」（搜索了 ${files.length} 个文件）`;
			const suffix = hits.length >= limit ? `\n...（已达上限 ${limit}，请收窄范围）` : "";
			return hits.join("\n") + suffix;
		} catch (err) {
			return `搜索失败: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
};
