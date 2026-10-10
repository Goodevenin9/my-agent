import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Message } from "./types";
import { SYSTEM_PROMPT, type ApprovalRequest, runAgent } from "./agent";
import { MODEL } from "./config";
import { createSessionStore, nowIso, rebuildHistory } from "./session-store";
import { buildMemoryContext, getMemoryStore } from "./memory";
import { renderEvent } from "./render";
import { bold, cyan, dim, green, red, yellow } from "./style";

// 命令行界面。它只做三件事：创建会话存储、消费事件、读你输入。
// 核心逻辑全在 agent.ts，界面换掉也不影响核心。

const { store, id, kind } = await createSessionStore();
let entries = await store.load();
if (entries.length === 0) {
	await store.append({
		type: "header",
		ts: nowIso(),
		version: 1,
		model: MODEL,
		systemPrompt: SYSTEM_PROMPT,
	});
	entries = await store.load();
}
let history: Message[] = rebuildHistory(entries, SYSTEM_PROMPT);

// 把「可信 + 生效」的长期记忆注入系统提示词（会话开始时一次性注入）。
const memories = await getMemoryStore().all();
const memCtx = buildMemoryContext(
	memories,
	Number(process.env.MEMORY_BUDGET_TOKENS) || 1500,
);
if (memCtx && history[0]?.role === "system") {
	history[0] = { role: "system", content: `${history[0].content}\n\n${memCtx}` };
}
const activeMemories = memories.filter(
	(m) => m.status === "active" && m.trust === "trusted",
).length;
const quarantineMemories = memories.filter((m) => m.status === "quarantined").length;

/** 问一行。每次用完就关掉 readline——运行期间才不会有 readline 抢 stdin。 */
async function ask(promptText: string): Promise<string> {
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		return await rl.question(promptText);
	} finally {
		rl.close();
	}
}

/**
 * 运行期间接管 stdin（这是「打字打断输出」那个 bug 的修复）：
 * - 忽略普通打字（不回显、不缓冲）；
 * - 只把 Ctrl+C（字节 0x03）当作「取消」。
 * 返回一个恢复函数。
 */
// 当前生效的「还原终端」函数（强退 / 崩溃时也能把 raw 模式关掉）
let activeRestore: (() => void) | null = null;
// 无论怎样退出（含强制退出 / 未捕获异常），都把终端还原成能打字的状态
process.on("exit", () => {
	try {
		(
			stdin as unknown as { setRawMode?: (v: boolean) => void }
		).setRawMode?.(false);
	} catch {
		/* ignore */
	}
});
function beginTakeover(controller: AbortController): () => void {
	const s = stdin as unknown as {
		setRawMode?: (v: boolean) => void;
		resume?: () => void;
	};
	const onData = (buf: Buffer) => {
		if (buf.includes(3)) {
			if (!controller.signal.aborted) {
				stdout.write("\n" + dim("（正在取消…再按一次 Ctrl+C 强制退出）") + "\n");
				controller.abort();
			} else {
				// 强退前先把终端还原，否则会留在 raw 模式（回到系统后也打不了字）
				activeRestore?.();
				process.exit(130);
			}
		}
	};
	try {
		s.setRawMode?.(true); // 关回显 + 逐字符送达
	} catch {
		/* 非 TTY 忽略 */
	}
	stdin.on("data", onData);
	s.resume?.();
	const restore = () => {
		stdin.off("data", onData);
		try {
			s.setRawMode?.(false);
		} catch {
			/* ignore */
		}
		if (activeRestore === restore) activeRestore = null;
	};
	activeRestore = restore;
	return restore;
}

console.log(
	green("🤖 my-agent 已启动。") +
		"直接输入你的需求，" +
		bold("Ctrl+C") +
		" 退出。",
);
console.log(dim(`会话「${id}」· 存储 ${kind}`));
console.log(
	dim(
		`🧠 长期记忆：生效 ${activeMemories} 条` +
			(quarantineMemories > 0 ? ` · 待审 ${quarantineMemories} 条` : ""),
	),
);
if (history.length > 1) {
	console.log(dim(`已恢复 ${history.length - 1} 条历史消息（输入「继续」可接着上次）。`));
}
console.log();

// 本次会话里被「总是允许」的工具
const sessionAllowed = new Set<string>();

while (true) {
	const input = (await ask(bold(cyan("你 > ")))).trim();
	if (!input) continue;

	// 每次运行一个独立的取消控制器
	const controller = new AbortController();
	let endInput = beginTakeover(controller);

	// 权限门：非只读工具执行前问一句。问的时候要暂停 stdin 接管，让 readline 能读。
	const approve = async (req: ApprovalRequest): Promise<boolean> => {
		if (sessionAllowed.has(req.name)) return true;
		endInput();
		const ans = (
			await ask(
				"\n" +
					yellow("⚠️  要执行工具 ") +
					bold(req.name) +
					dim(`（${req.effect}）`) +
					"\n" +
					dim(`   参数: ${req.args}`) +
					"\n" +
					"允许执行吗？" +
					dim(" [y]允许 / [n]拒绝 / [a]本次会话总是允许 "),
			)
		)
			.trim()
			.toLowerCase();
		endInput = beginTakeover(controller);
		if (ans === "a" || ans === "always") {
			sessionAllowed.add(req.name);
			return true;
		}
		return ans === "y" || ans === "yes" || ans === "是";
	};

	try {
		history = await runAgent(input, history, {
			emit: renderEvent,
			store,
			signal: controller.signal,
			approve,
		});
	} catch (err) {
		console.error(
			"\n" + red("⚠️  " + (err instanceof Error ? err.message : err)) + "\n",
		);
	} finally {
		endInput();
	}
}
