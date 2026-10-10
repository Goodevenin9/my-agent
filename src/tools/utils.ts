import { readdir } from "node:fs/promises";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// find / grep / ls 共用的底层工具。

/** 遍历时跳过的目录，避免把 node_modules 之类扫进来。 */
export const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	"__pycache__",
	".venv",
	"venv",
	".cache",
]);

/** 递归收集目录下的所有文件（绝对/相对完整路径）。返回的是 path.join(root, ...) 形式。 */
export async function walkFiles(
	root: string,
	maxFiles = 5000,
): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		if (out.length >= maxFiles) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // 没权限就跳过
		}
		for (const e of entries) {
			if (out.length >= maxFiles) return;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name)) continue;
				await walk(full);
			} else if (e.isFile()) {
				out.push(full);
			}
		}
	}
	await walk(root);
	return out;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把一个 glob 模式转成正则。支持 `*`、`**`、`?`、`{a,b}`。 */
export function globToRegExp(glob: string): RegExp {
	const g = glob.replace(/\\/g, "/");
	let re = "";
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === "*") {
			if (g[i + 1] === "*") {
				if (g[i + 2] === "/") {
					re += "(?:.*/)?"; // **/ 可以匹配零层或多层目录
					i += 2;
				} else {
					re += ".*"; // ** 匹配任意字符
					i += 1;
				}
			} else {
				re += "[^/]*"; // * 不跨目录
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if (c === "{") {
			const end = g.indexOf("}", i);
			if (end > -1) {
				const opts = g
					.slice(i + 1, end)
					.split(",")
					.map(escapeRegExp);
				re += "(?:" + opts.join("|") + ")";
				i = end;
			} else {
				re += "\\{";
			}
		} else if ("+^$.()|[]".includes(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
	}
	return new RegExp("^" + re + "$");
}

/**
 * 判断一个相对路径是否匹配 glob。
 * 不带 `/` 的模式（如 `*.ts`）按「文件名」匹配，即任意层级都能命中。
 */
export function matchGlob(relPath: string, glob: string): boolean {
	const p = relPath.replace(/\\/g, "/");
	const g = glob.replace(/\\/g, "/");
	if (!g.includes("/")) {
		const base = p.slice(p.lastIndexOf("/") + 1);
		return globToRegExp(g).test(base);
	}
	return globToRegExp(g).test(p);
}

/** 把文本按字符数截断，附上提示。 */
export function truncateText(text: string, maxChars: number): string {
	return text.length > maxChars
		? text.slice(0, maxChars) + `\n...（已截断，原始 ${text.length} 字符）`
		: text;
}

/**
 * 原子写：先写同目录的临时文件，再 rename 覆盖目标。
 * 好处：写到一半被中断（Ctrl+C / 崩溃），目标文件不会变成半成品。
 * rename 在同一文件系统内是原子的。
 */
export async function atomicWriteFile(
	path: string,
	content: string,
): Promise<void> {
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, content, "utf8");
	await rename(tmp, path);
}
