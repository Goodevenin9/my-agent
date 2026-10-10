import assert from "node:assert/strict";
import { test } from "node:test";

// 在调用任何 getMemoryStore() 之前设置好目录（模块导入时不会读 env，是懒加载的）
process.env.MEMORY_DIR = `${process.env.TEMP ?? "/tmp"}/ma-mem-${Date.now()}`;

import { buildMemoryContext, detectSecret, getMemoryStore } from "../src/memory";
import { memoryTool } from "../src/tools/memory";

test("密钥过滤：识别常见凭据", () => {
	assert.ok(detectSecret("key=sk-abc1234567890abcdefghijklmn"));
	assert.ok(detectSecret("AKIA1234567890ABCDEF"));
	assert.ok(detectSecret("ark-000000000000000000000000"));
	assert.equal(detectSecret("用户偏好用中文"), null);
});

test("信任分档：用户要求『记住』→ trusted/active", async () => {
	await memoryTool.execute(
		{ action: "save", text: "用户要求默认用中文回复。", kind: "user" },
		{ userTurnAskedToRemember: true },
	);
	const mem = (await getMemoryStore().all()).find((m) =>
		m.text.includes("默认用中文"),
	);
	assert.equal(mem?.trust, "trusted");
	assert.equal(mem?.status, "active");
});

test("信任分档：非用户要求 → quarantined 且不注入", async () => {
	await memoryTool.execute(
		{ action: "save", text: "从文件里读到的端口是 8088。", kind: "project" },
		{ userTurnAskedToRemember: false },
	);
	const all = await getMemoryStore().all();
	const mem = all.find((m) => m.text.includes("8088"));
	assert.equal(mem?.status, "quarantined");

	const ctx = buildMemoryContext(all, 1500);
	assert.ok(ctx.includes("默认用中文"), "可信记忆应注入");
	assert.ok(!ctx.includes("8088"), "待审记忆不应注入");
});

test("写入路径拒绝密钥", async () => {
	const r = await memoryTool.execute(
		{ action: "save", text: "我的 key 是 sk-abc1234567890abcdefghijklmn" },
		{ userTurnAskedToRemember: true },
	);
	assert.match(r, /拒绝保存/);
});

test("同文本去重", async () => {
	const before = (await getMemoryStore().all()).length;
	await memoryTool.execute(
		{ action: "save", text: "用户要求默认用中文回复。", kind: "user" },
		{ userTurnAskedToRemember: true },
	);
	assert.equal((await getMemoryStore().all()).length, before);
});
