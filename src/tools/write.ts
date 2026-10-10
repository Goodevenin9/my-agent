import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "../types";
import { withFileMutationQueue } from "./file-mutation-queue";
import { atomicWriteFile } from "./utils";

// 对应 Pi 的 write。整体覆盖式写入。
export const writeTool: Tool = {
	name: "write",
	effect: "mutate",
	description:
		"把内容写入文件（会覆盖原文件）。文件不存在则创建，父目录会自动创建。",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "文件路径（相对或绝对）" },
			content: { type: "string", description: "要写入的完整内容" },
		},
		required: ["path", "content"],
	},
	async execute(args) {
		try {
			const path = String(args.path);
			const content = String(args.content ?? "");
			// 写入同一文件的操作排队，防止并发踩踏；原子写防止半成品
			await withFileMutationQueue(path, async () => {
				await mkdir(dirname(path), { recursive: true });
				await atomicWriteFile(path, content);
			});
			const lines = content.split("\n").length;
			return `已写入 ${path}（${content.length} 字符，${lines} 行）`;
		} catch (err) {
			return `写入失败: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
};
