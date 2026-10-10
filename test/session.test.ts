import assert from "node:assert/strict";
import { test } from "node:test";
import { type SessionEntry, rebuildHistory } from "../src/session-store";

test("rebuildHistory：omission 把消息从投影里排除", () => {
	const entries: SessionEntry[] = [
		{ type: "header", ts: "t", version: 1, model: "m", systemPrompt: "SYS" },
		{ type: "message", ts: "t", id: "u1", message: { role: "user", content: "会保留" } },
		{ type: "message", ts: "t", id: "u2", message: { role: "user", content: "被作废" } },
		{ type: "omission", ts: "t", ids: ["u2"] },
	];
	const h = rebuildHistory(entries, "SYS");
	assert.deepEqual(
		h.map((m) => m.role),
		["system", "user"],
	);
	assert.equal((h[1] as { content: string }).content, "会保留");
});

test("rebuildHistory：压缩投影 = system + 摘要 + 保留区 + 之后新增", () => {
	const entries: SessionEntry[] = [
		{ type: "header", ts: "t", version: 1, model: "m", systemPrompt: "SYS" },
		{ type: "message", ts: "t", id: "u1", message: { role: "user", content: "很旧" } },
		{
			type: "compaction",
			ts: "t",
			summary: "摘要内容",
			kept: [{ role: "assistant", content: "保留的" }],
			tokensBefore: 100,
			tokensAfter: 50,
		},
		{ type: "message", ts: "t", id: "u2", message: { role: "user", content: "新的" } },
	];
	const h = rebuildHistory(entries, "SYS");
	assert.deepEqual(
		h.map((m) => m.role),
		["system", "system", "assistant", "user"],
	);
	assert.ok((h[1] as { content: string }).content.includes("摘要内容"));
	assert.equal((h[2] as { content: string }).content, "保留的");
	assert.equal((h[3] as { content: string }).content, "新的");
});
