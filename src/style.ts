// 终端样式工具：只用 ANSI 转义码，不需要安装任何库。
// 注意：这些颜色只有在真正的终端里才生效，在普通文本编辑器里看不到。

const c = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	italic: "\x1b[3m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	gray: "\x1b[90m",
};

function wrap(open: string) {
	return (text: string) => `${open}${text}${c.reset}`;
}

export const bold = wrap(c.bold);
export const dim = wrap(c.dim);
export const yellow = wrap(c.yellow);
export const cyan = wrap(c.cyan);
export const green = wrap(c.green);
export const red = wrap(c.red);
export const gray = wrap(c.gray);

/** 思考过程：斜体 + 浅灰 */
export const thinking = (text: string) =>
	`${c.italic}${c.gray}${text}${c.reset}`;

/** 把一段多行文本逐行套上样式，避免某些终端在换行时丢掉样式 */
export function styleLines(
	text: string,
	fn: (line: string) => string,
): string {
	return text
		.split("\n")
		.map((line) => (line.trim() === "" ? line : fn(line)))
		.join("\n");
}
