import "dotenv/config";
import OpenAI from "openai";

// 读 .env 里的配置。OPENAI_BASE_URL 让你能用任何「兼容 OpenAI 协议」的厂商。
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
	console.error(
		"\n❌ 缺少 OPENAI_API_KEY。\n" +
			"   请把 .env.example 复制成 .env，然后填上你的 key。\n",
	);
	process.exit(1);
}

export const MODEL = process.env.MODEL ?? "gpt-4o-mini";

// ── 可调参数（都能用 .env 覆盖）─────────────────────────────
// num() 把环境变量转成数字；不合法就用默认值。
function num(name: string, fallback: number): number {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 模型上下文窗口大小（GLM-5.3-Flash 约 128k）。
export const CONTEXT_WINDOW = num("CONTEXT_WINDOW", 128_000);
// 留给模型生成回复的余量；上下文超过「窗口 - 余量」就触发压缩。
export const RESERVE_TOKENS = num("RESERVE_TOKENS", 16_384);
// 压缩时「最近多少 token 不总结、原样保留」。
export const KEEP_RECENT_TOKENS = num("KEEP_RECENT_TOKENS", 20_000);

// 压缩触发线（绝对 token 数）。> 0 时优先用它；否则用「窗口 − 余量」。
// 想更早压缩、更省 token，就把它设小（例如 40000）。
export const COMPACT_TRIGGER_TOKENS = (() => {
	const n = Number(process.env.COMPACT_TRIGGER_TOKENS);
	return Number.isFinite(n) && n > 0 ? n : 0;
})();

// ── 重试（临时性错误自动重试）──────────────────────────────
export const RETRY_ENABLED = (process.env.RETRY_ENABLED ?? "true") !== "false";
export const RETRY_MAX = (() => {
	const n = Number(process.env.RETRY_MAX);
	return Number.isFinite(n) && n >= 0 ? n : 3;
})();
export const RETRY_BASE_DELAY_MS = num("RETRY_BASE_DELAY_MS", 2000);
export const RETRY_MAX_DELAY_MS = num("RETRY_MAX_DELAY_MS", 60_000);

// 流式输出开关
// 某些兼容端点不支持 stream_options.include_usage，如遇 400 可设 STREAM=false
export const STREAM = (process.env.STREAM ?? "true") !== "false";

// 权限门模式（默认 off，不打扰）：
//   off     不拦（直接执行）
//   execute 只拦命令类工具（bash/powershell）
//   mutate  只拦改文件类工具（write/edit）
//   all     非只读工具都拦
// 无论哪种模式，只要没提供确认回调（headless），都直接放行。
export const APPROVAL_MODE = (process.env.APPROVAL_MODE ?? "off").toLowerCase();

export const client = new OpenAI({
	apiKey,
	baseURL: process.env.OPENAI_BASE_URL, // 不填就用 OpenAI 官方
});
