import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Tool } from "../types";

// 对应 Pi 的 read。支持 offset/limit 分段读，避免一次塞爆上下文。
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

export const readTool: Tool = {
	name: "read",
	effect: "read",
	description:
		"读取文件内容。文本文件按行返回，可用 offset/limit 分段读（offset 从 1 开始）。图片文件会返回说明（当前模型若无视觉能力则无法真正看到）。",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "文件路径（相对或绝对）" },
			offset: { type: "number", description: "起始行号，从 1 开始（可选）" },
			limit: { type: "number", description: "最多读多少行（可选）" },
		},
		required: ["path"],
	},
	async execute(args) {
		const path = String(args.path);
		try {
			// 图片：这里只做识别与说明。真正的多模态（把图片作为附件发给模型）
			// 需要改造消息类型，属于进阶内容。
			if (IMAGE_EXTS.has(extname(path).toLowerCase())) {
				return `这是一个图片文件（${path}）。当前脚手架未接入多模态，无法把图片内容发给模型。`;
			}

			const raw = await readFile(path, "utf8");
			const allLines = raw.split("\n");
			const total = allLines.length;

			const startLine = args.offset ? Math.max(0, Number(args.offset) - 1) : 0;
			if (startLine >= total) {
				return `读取失败: offset ${args.offset} 超出文件范围（共 ${total} 行）`;
			}

			let selected: string[];
			if (args.limit !== undefined) {
				const end = Math.min(startLine + Number(args.limit), total);
				selected = allLines.slice(startLine, end);
			} else {
				selected = allLines.slice(startLine);
			}

			let text = selected.join("\n");
			let truncated = false;
			if (selected.length > MAX_LINES) {
				text = selected.slice(0, MAX_LINES).join("\n");
				truncated = true;
			}
			if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
				text = text.slice(0, MAX_BYTES);
				truncated = true;
			}
			if (truncated) {
				text += `\n...（已截断。文件共 ${total} 行，可继续用 offset 从第 ${startLine + 1 + MAX_LINES} 行读）`;
			}
			return text || "(空文件)";
		} catch (err) {
			// 关键：出错返回文字，而不是抛异常
			return `读取失败: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
};
