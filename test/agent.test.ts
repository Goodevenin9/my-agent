import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgent } from "../src/agent";
import type { AgentEvent } from "../src/events";
import { JsonlSessionStore, rebuildHistory } from "../src/session-store";
import type { Message } from "../src/types";
import { scriptError, scriptModel } from "./helpers";

const tmp = () => mkdtemp(join(tmpdir(), "ma-agent-"));

test("工具并行执行，但结果按原始顺序写回", async () => {
	const cmd = (ms: number, n: number) =>
		JSON.stringify({ command: `node -e "setTimeout(()=>{},${ms});console.log(${n})"` });
	scriptModel([
		{
			toolCalls: [
				{ id: "a", name: "bash", args: cmd(300, 1) },
				{ id: "b", name: "bash", args: cmd(100, 2) },
				{ id: "c", name: "bash", args: cmd(200, 3) },
			],
		},
		{ content: "done" },
	]);
	const ids: string[] = [];
	const history = await runAgent("go", [], {
		emit: (e) => {
			if (e.type === "tool_result") ids.push(e.id);
		},
	});
	assert.deepEqual(ids, ["a", "b", "c"]);
	const toolIds = history
		.filter((m) => m.role === "tool")
		.map((m) => (m as { tool_call_id: string }).tool_call_id);
	assert.deepEqual(toolIds, ["a", "b", "c"]);
});

test("流式：delta 拼起来等于完整回答", async () => {
	scriptModel([{ content: "你好世界", reasoning: "先想一下" }]);
	const assistant: string[] = [];
	let thinkingText = "";
	await runAgent("hi", [], {
		emit: (e) => {
			if (e.type === "assistant_delta") assistant.push(e.text);
			if (e.type === "thinking_delta") thinkingText += e.text;
		},
	});
	assert.equal(assistant.join(""), "你好世界");
	assert.equal(thinkingText, "先想一下");
});

test("运行中取消：中断工具并干净收尾", async () => {
	scriptModel([
		{
			toolCalls: [
				{
					id: "t",
					name: "bash",
					args: JSON.stringify({ command: 'node -e "setTimeout(()=>{},5000)"' }),
				},
			],
		},
	]);
	const events: AgentEvent[] = [];
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 150);
	const t0 = Date.now();
	await runAgent("跑长命令", [], { emit: (e) => events.push(e), signal: ac.signal });
	assert.ok(Date.now() - t0 < 2000, "应被及时中断，而不是跑满 5s");
	assert.ok(events.some((e) => e.type === "agent_end" && e.reason === "abort"));
});

test("失败回滚：不留无人回答的 user 消息，并记 omission", async () => {
	const dir = await tmp();
	const store = new JsonlSessionStore(join(dir, "s.jsonl"));
	scriptError(Object.assign(new Error("bad request"), { status: 400 }));
	const history = await runAgent("这会被回滚", [], { store, emit: () => {} });
	assert.deepEqual(
		history.map((m) => m.role),
		["system"],
		"内存历史应回滚到只剩 system",
	);

	const entries = (await store.load()) as never;
	assert.ok(
		(entries as { type: string }[]).some((e) => e.type === "omission"),
		"应记录 omission",
	);
	const rebuilt = rebuildHistory(entries, "SYS");
	assert.deepEqual(
		rebuilt.map((m) => m.role),
		["system"],
		"重建上下文也应排除被回滚的消息",
	);
});

test("权限门：拒绝则不执行，允许则执行", async () => {
	const dir = await tmp();
	const target = join(dir, "x.txt");
	const writeTurn = {
		toolCalls: [
			{ id: "w", name: "write", args: JSON.stringify({ path: target, content: "hi" }) },
		],
	};

	scriptModel([writeTurn, { content: "done" }]);
	const denied = await runAgent("写文件", [], {
		emit: () => {},
		approve: async () => false,
		approvalMode: "all",
	});
	const toolMsg = denied.find((m) => m.role === "tool") as { content: string };
	assert.match(toolMsg.content, /拒绝/);
	await assert.rejects(readFile(target, "utf8"), "被拒绝时不应写文件");

	scriptModel([writeTurn, { content: "done" }]);
	await runAgent("写文件", [], {
		emit: () => {},
		approve: async () => true,
		approvalMode: "all",
	});
	assert.equal(await readFile(target, "utf8"), "hi");
});

test("输出被截断：本批工具一律不执行", async () => {
	const dir = await tmp();
	const target = join(dir, "y.txt");
	scriptModel([
		{
			toolCalls: [
				{ id: "w", name: "write", args: JSON.stringify({ path: target, content: "hi" }) },
			],
			finishReason: "length",
		},
		{ content: "done" },
	]);
	const history = await runAgent("写", [], { emit: () => {} });
	const toolMsg = history.find((m) => m.role === "tool") as { content: string };
	assert.match(toolMsg.content, /未执行/);
	await assert.rejects(readFile(target, "utf8"));
});

test("compact 工具：主循环拦截并真正压缩历史", async () => {
	// 造一段足够大的历史（超过 keepRecentTokens，压缩才有东西可总结）
	const filler = "这是一段用来把上下文撑大的内容。".repeat(250);
	const big: Message[] = [{ role: "system", content: "SYS" }];
	for (let i = 0; i < 12; i++) {
		big.push({ role: "user", content: `第${i}问：${filler}` });
		big.push({ role: "assistant", content: `第${i}答：${filler}` });
	}
	scriptModel([
		{ toolCalls: [{ id: "c1", name: "compact", args: "{}" }] },
		{ content: "done" },
	]);
	const events: AgentEvent[] = [];
	const out = await runAgent("压缩一下", big, { emit: (e) => events.push(e) });
	assert.ok(
		events.some((e) => e.type === "compaction_start"),
		"应发出压缩开始事件",
	);
	assert.ok(
		events.some((e) => e.type === "compaction"),
		"应完成压缩",
	);
	assert.ok(out.length < big.length, "压缩后历史应变短");
});

test("compact 工具：没有可压内容时给提示，不崩", async () => {
	scriptModel([
		{ toolCalls: [{ id: "c1", name: "compact", args: "{}" }] },
		{ content: "done" },
	]);
	const events: AgentEvent[] = [];
	await runAgent("压缩", [], { emit: (e) => events.push(e) });
	assert.ok(events.some((e) => e.type === "notice"));
});
