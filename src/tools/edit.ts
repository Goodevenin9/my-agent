import { readFile } from "node:fs/promises";
import type { Tool } from "../types";
import { withFileMutationQueue } from "./file-mutation-queue";
import { atomicWriteFile } from "./utils";

// 对应 Pi 的 edit：精确文本替换。这是编程 Agent 最重要的工具——
// 模型只需给出「旧片段 → 新片段」，不必整篇重写。

interface Edit {
	oldText: string;
	newText: string;
}

/** 找出 needle 在 hay 中所有出现的起始下标。 */
function findAll(hay: string, needle: string): number[] {
	const res: number[] = [];
	if (!needle) return res;
	let i = hay.indexOf(needle);
	while (i !== -1) {
		res.push(i);
		i = hay.indexOf(needle, i + needle.length);
	}
	return res;
}

export const editTool: Tool = {
	name: "edit",
	effect: "mutate",
	description:
		"对文件做精确文本替换。edits[].oldText 必须在原文件中唯一匹配、且各段互不重叠。" +
		"如果两处修改挨得很近，请合并成一次 edit，不要给出重叠的片段。",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "要编辑的文件路径" },
			edits: {
				type: "array",
				description: "一组替换操作，每个都基于原文件匹配（不是增量匹配）",
				items: {
					type: "object",
					properties: {
						oldText: { type: "string", description: "要被替换的原文（必须唯一）" },
						newText: { type: "string", description: "替换后的新文本" },
					},
					required: ["oldText", "newText"],
				},
			},
		},
		required: ["path", "edits"],
	},
	async execute(args) {
		const path = String(args.path);
		let edits: Edit[];
		try {
			edits = Array.isArray(args.edits) ? args.edits : JSON.parse(String(args.edits));
		} catch {
			return "编辑失败: edits 必须是数组";
		}
		if (!edits.length) return "编辑失败: edits 为空";

		try {
			// 整个「读 → 校验 → 重建 → 写」放进写队列：
			// 同一文件的并发 edit 会排队，后一个能读到前一个的结果，不会互相覆盖。
			return await withFileMutationQueue(path, async () => {
				const original = await readFile(path, "utf8");

				// 1) 先对「原文件」逐一校验唯一性，并记录位置
				const regions: { start: number; end: number; edit: Edit }[] = [];
				for (const e of edits) {
					if (!e.oldText) return "编辑失败: oldText 不能为空";
					const hits = findAll(original, e.oldText);
					if (hits.length === 0) {
						return `编辑失败: 没找到这段原文（请检查是否与文件完全一致）：\n${e.oldText.slice(0, 200)}`;
					}
					if (hits.length > 1) {
						return `编辑失败: 这段原文匹配到 ${hits.length} 处，不唯一。请多带一些上下文使其唯一：\n${e.oldText.slice(0, 200)}`;
					}
					regions.push({ start: hits[0], end: hits[0] + e.oldText.length, edit: e });
				}

				// 2) 检查是否有重叠
				regions.sort((a, b) => a.start - b.start);
				for (let i = 1; i < regions.length; i++) {
					if (regions[i].start < regions[i - 1].end) {
						return "编辑失败: 有两处 edit 的 oldText 重叠了。请把它们合并成一次 edit。";
					}
				}

				// 3) 基于原文件重建结果（从后往前替换，避免下标位移）
				let result = original;
				for (let i = regions.length - 1; i >= 0; i--) {
					const { start, end, edit } = regions[i];
					result = result.slice(0, start) + edit.newText + result.slice(end);
				}

				if (result === original) return `未改动 ${path}（新文本与原文相同）`;
				await atomicWriteFile(path, result);
				return `已编辑 ${path}（${edits.length} 处替换）`;
			});
		} catch (err) {
			return `编辑失败: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
};
