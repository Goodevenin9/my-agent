import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { SUMMARY_MARKER } from "./compaction";
import type { Message } from "./types";

// node:sqlite 目前是实验性的，用 createRequire 延迟加载，避免没用它时也弹警告。
const require = createRequire(import.meta.url);

/**
 * 会话存储。
 *
 * 设计要点：**存的是「不可变的原始事件日志」**——每条消息、每次压缩都 append，
 * 永不删除。压缩只影响「发给模型的上下文投影」，不动原始日志，所以压缩可逆、可审计。
 *
 * 存成接口，JSONL 和 SQLite 可互换（工程化：存储不该写死在循环里）。
 */

export interface HeaderEntry {
	type: "header";
	ts: string;
	version: number;
	model: string;
	systemPrompt: string;
}

export interface MessageEntry {
	type: "message";
	ts: string;
	id?: string;
	message: Message;
}

export interface CompactionEntry {
	type: "compaction";
	ts: string;
	summary: string;
	// 压缩后原样保留的消息（重建上下文时用）
	kept: Message[];
	tokensBefore: number;
	tokensAfter: number;
}

/**
 * 「作废」条目：把某些消息从「模型投影」里排除（但原始日志仍然留着）。
 * 用于：一次运行失败后回滚掉那条无人回答的 user 消息。
 */
export interface OmissionEntry {
	type: "omission";
	ts: string;
	ids: string[];
}

export type SessionEntry =
	| HeaderEntry
	| MessageEntry
	| CompactionEntry
	| OmissionEntry;

export function newEntryId(): string {
	return randomUUID().slice(0, 8);
}

export interface SessionStore {
	append(entry: SessionEntry): Promise<void>;
	load(): Promise<SessionEntry[]>;
}

export function nowIso(): string {
	return new Date().toISOString();
}

/**
 * 把事件日志「投影」成发给模型的 history。
 * 规则：找到最后一次压缩；若有，上下文 = 系统提示词 + 摘要 + 保留区 + 此后新增的消息；
 * 若没有，上下文 = 系统提示词 + 全部消息。
 * （原始日志里的旧消息仍在，只是这次不发。）
 */
export function rebuildHistory(
	entries: SessionEntry[],
	fallbackSystemPrompt: string,
): Message[] {
	const header = entries.find((e) => e.type === "header") as HeaderEntry | undefined;
	const systemPrompt = header?.systemPrompt ?? fallbackSystemPrompt;
	const history: Message[] = [{ role: "system", content: systemPrompt }];

	const relevant = entries.filter(
		(e) => e.type === "message" || e.type === "compaction",
	);

	// 被 omit 的消息不进入投影（原始日志仍在）
	const omitted = new Set<string>();
	for (const e of entries) {
		if (e.type === "omission") for (const id of e.ids) omitted.add(id);
	}

	let lastCompaction = -1;
	for (let i = 0; i < relevant.length; i++) {
		if (relevant[i].type === "compaction") lastCompaction = i;
	}

	let start = 0;
	if (lastCompaction >= 0) {
		const c = relevant[lastCompaction] as CompactionEntry;
		history.push({ role: "system", content: `${SUMMARY_MARKER}\n${c.summary}` });
		history.push(...c.kept);
		start = lastCompaction + 1;
	}
	for (let i = start; i < relevant.length; i++) {
		const e = relevant[i];
		if (e.type === "message" && (!e.id || !omitted.has(e.id))) {
			history.push(e.message);
		}
	}
	return history;
}

// ── 实现 1：JSONL（默认）─────────────────────────────────────
// 一行一个 JSON，可 grep、可 diff、可原样重放，最贴近 Pi 的 session 格式。
export class JsonlSessionStore implements SessionStore {
	constructor(private file: string) {}

	async append(entry: SessionEntry): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		await appendFile(this.file, JSON.stringify(entry) + "\n", "utf8");
	}

	async load(): Promise<SessionEntry[]> {
		try {
			const raw = await readFile(this.file, "utf8");
			return raw
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as SessionEntry);
		} catch {
			return [];
		}
	}
}

// ── 实现 2：SQLite（node:sqlite，零依赖，可跨会话查询）────────
export class SqliteSessionStore implements SessionStore {
	private db: import("node:sqlite").DatabaseSync;
	constructor(private file: string) {
		mkdirSync(dirname(this.file), { recursive: true });
		// 延迟到构造时再 require，避免没用 SQLite 时也弹实验性警告
		const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
		this.db = new DatabaseSync(this.file);
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS entries (" +
				"seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)",
		);
	}

	async append(entry: SessionEntry): Promise<void> {
		this.db
			.prepare("INSERT INTO entries (ts, kind, data) VALUES (?, ?, ?)")
			.run(entry.ts, entry.type, JSON.stringify(entry));
	}

	async load(): Promise<SessionEntry[]> {
		const rows = this.db
			.prepare("SELECT data FROM entries ORDER BY seq")
			.all() as { data: string }[];
		return rows.map((r) => JSON.parse(r.data) as SessionEntry);
	}
}

/**
 * 按 .env 选择存储后端。
 *   SESSION_STORE=jsonl|sqlite   （默认 jsonl）
 *   SESSION_ID=default           （会话标识）
 *   SESSION_DIR=.my-agent/sessions
 */
export async function createSessionStore(): Promise<{ store: SessionStore; id: string; kind: string }> {
	const id = process.env.SESSION_ID ?? "default";
	const kind = (process.env.SESSION_STORE ?? "jsonl").toLowerCase();
	const dir = process.env.SESSION_DIR ?? ".my-agent/sessions";
	if (kind === "sqlite") {
		return { store: new SqliteSessionStore(join(dir, `${id}.db`)), id, kind };
	}
	return { store: new JsonlSessionStore(join(dir, `${id}.jsonl`)), id, kind: "jsonl" };
}
