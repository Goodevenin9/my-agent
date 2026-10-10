import type { Tool } from "../types";
import {
	coerceKind,
	detectSecret,
	getMemoryStore,
} from "../memory";

// 长期记忆工具（P1）。写入一律由模型发起，但**信任档由 harness 决定**：
// 只有「用户本轮明确要求记住」时才是可信；否则进待审区，不注入、不生效。
export const memoryTool: Tool = {
	name: "memory",
	description:
		"长期记忆（跨会话）。action=save 保存一条事实；search 按关键词查；list 列出。\n" +
		"什么时候用 save：①用户明确要求「记住…」；②用户纠正了你；③你发现跨会话仍成立、且无法从代码直接看出的事实。\n" +
		"不要保存：临时任务细节、能从代码/git 看出的东西、密钥等敏感信息。",
	parameters: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["save", "search", "list"], description: "要做什么" },
			text: { type: "string", description: "save 时要记住的一句话事实（原子、可独立理解）" },
			kind: {
				type: "string",
				enum: ["user", "project", "feedback", "reference"],
				description: "类别：user=用户偏好，project=项目状态，feedback=纠正/教训，reference=外部资源。默认 project",
			},
			tags: { type: "array", items: { type: "string" }, description: "可选标签" },
			query: { type: "string", description: "search 时的关键词" },
		},
		required: ["action"],
	},
	async execute(args, ctx) {
		const store = getMemoryStore();
		const action = String(args.action);

		if (action === "save") {
			const text = String(args.text ?? "").trim();
			if (!text) return "保存失败：text 不能为空";

			const secret = detectSecret(text);
			if (secret) {
				return `拒绝保存：内容疑似包含密钥（${secret}）。记忆是长期留存的，不会保存凭据。`;
			}

			// 关键：信任来自「用户本轮是否明确要求记住」，不是模型自己说。
			const userInitiated = ctx?.userTurnAskedToRemember === true;
			const source = userInitiated ? "user" : "inferred";
			const mem = await store.add({
				text,
				kind: coerceKind(args.kind),
				source,
				tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
				fromSession: process.env.SESSION_ID,
			});

			return userInitiated
				? `已记住（可信，会话间生效）：${mem.text}`
				: `已记录到待审区（未验证，暂不生效，需人工确认）：${mem.text}`;
		}

		if (action === "search") {
			const q = String(args.query ?? "").trim().toLowerCase();
			if (!q) return "search 需要 query";
			const hits = (await store.all()).filter((m) =>
				m.text.toLowerCase().includes(q),
			);
			if (!hits.length) return `没有匹配「${args.query}」的记忆`;
			return hits
				.map((m) => `[${m.status}/${m.trust}] (${m.kind}) ${m.text}`)
				.join("\n");
		}

		if (action === "list") {
			const all = await store.all();
			const active = all.filter((m) => m.status === "active");
			const quarantine = all.filter((m) => m.status === "quarantined");
			const head = `生效记忆 ${active.length} 条，待审 ${quarantine.length} 条`;
			const body = active.map((m) => `[生效] (${m.kind}) ${m.text}`).join("\n");
			return body ? `${head}\n${body}` : head;
		}

		return `未知 action: ${action}（可选 save / search / list）`;
	},
};
