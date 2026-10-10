import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 工具输出的「截断 + 落盘」（对应 Pi 的 OutputAccumulator / truncate）。
 *
 * 目的：单条工具结果不能无限大。超出上限时：
 *   1. 只保留一段（read 类留头部，bash 类留尾部——报错常在末尾）；
 *   2. 把**完整输出写到临时文件**，并在消息里给出路径；
 *   3. 模型需要细节时，可以用 read 工具再去看那个文件。
 * 这样既把上下文压住，又**不丢信息**。
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB，和 Pi 一致

// 这些工具的输出保留「尾部」，其余保留「头部」
const TAIL_TOOLS = new Set(["bash", "powershell"]);

export interface TruncationInfo {
	truncatedBy: "lines" | "bytes";
	totalLines: number;
	shownLines: number;
	fullOutputPath: string;
}

export interface LimitedOutput {
	content: string;
	truncation?: TruncationInfo;
}

function byteLength(s: string): number {
	return Buffer.byteLength(s, "utf8");
}

/** 从 lines 里取最多 maxLines 行、且不超过 maxBytes 字节；fromEnd 决定从头还是从尾取。 */
function takeLines(
	lines: string[],
	maxLines: number,
	maxBytes: number,
	fromEnd: boolean,
): { text: string; count: number } {
	const picked: string[] = [];
	let bytes = 0;
	const iter = fromEnd ? [...lines].reverse() : lines;
	for (const line of iter) {
		if (picked.length >= maxLines) break;
		const b = byteLength(line) + 1;
		if (bytes + b > maxBytes && picked.length > 0) break;
		picked.push(line);
		bytes += b;
	}
	if (fromEnd) picked.reverse();
	let text = picked.join("\n");
	// 单行就超字节上限时，硬切
	if (byteLength(text) > maxBytes) {
		text = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
	}
	return { text, count: picked.length };
}

/** 把完整输出写到临时文件，返回路径。 */
export function persistFullOutput(text: string, prefix = "my-agent-output"): string {
	const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
	const file = join(dir, "output.txt");
	writeFileSync(file, text, "utf8");
	return file;
}

/** 对某个工具的输出做「截断 + 落盘」；没超限就原样返回。 */
export function limitToolOutput(
	toolName: string,
	output: string,
	opts: { maxLines?: number; maxBytes?: number } = {},
): LimitedOutput {
	const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

	const lines = output.split("\n");
	const totalLines = lines.length;
	if (totalLines <= maxLines && byteLength(output) <= maxBytes) {
		return { content: output };
	}

	const fromEnd = TAIL_TOOLS.has(toolName);
	const { text, count } = takeLines(lines, maxLines, maxBytes, fromEnd);
	const fullOutputPath = persistFullOutput(output, `my-agent-${toolName}`);

	const size = `${Math.round(byteLength(output) / 1024)}KB`;
	const note = fromEnd
		? `\n\n[输出过大，仅显示最后 ${count} 行（共 ${totalLines} 行 / ${size}）。完整输出已存到：${fullOutputPath} —— 需要时用 read 工具查看]`
		: `\n\n[输出过大，仅显示前 ${count} 行（共 ${totalLines} 行 / ${size}）。完整输出已存到：${fullOutputPath} —— 需要时用 read 工具查看]`;

	const truncatedBy: "lines" | "bytes" =
		totalLines > maxLines ? "lines" : "bytes";

	return {
		content: text + note,
		truncation: { truncatedBy, totalLines, shownLines: count, fullOutputPath },
	};
}
