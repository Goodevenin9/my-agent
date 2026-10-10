import { MODEL } from "./config";

// 成本核算：累计 token，按价目表换算成美元。
// 你没有分词器也没关系——用量以模型 API 返回的 usage 为准，最准。

export interface Pricing {
	inputPerMTok: number; // 每百万输入 token（未命中缓存）的价格
	outputPerMTok: number; // 每百万输出 token 的价格
	cachedInputPerMTok?: number; // 每百万「命中缓存的输入 token」的价格（通常更便宜，缺省=同输入价）
}

// 内置价目表：按你实际账单填（默认空，表示「不知道价格」）。
const BUILTIN: Record<string, Pricing> = {
	// 例：
	// "doubao-seed-2-0-mini-260428": { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.03 },
};

function num(name: string): number | undefined {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** 价格来源优先级：.env 覆盖 > 内置表 > 未知（返回 null）。 */
export function resolvePricing(): Pricing | null {
	const i = num("PRICE_INPUT_PER_MTOK");
	const o = num("PRICE_OUTPUT_PER_MTOK");
	const c = num("PRICE_CACHED_INPUT_PER_MTOK");
	if (i !== undefined || o !== undefined || c !== undefined) {
		return {
			inputPerMTok: i ?? 0,
			outputPerMTok: o ?? 0,
			cachedInputPerMTok: c,
		};
	}
	return BUILTIN[MODEL] ?? null;
}

export class CostTracker {
	promptTokens = 0;
	completionTokens = 0;
	cachedTokens = 0;

	constructor(private pricing: Pricing | null) {}

	add(promptTokens: number, completionTokens: number, cachedTokens = 0): void {
		this.promptTokens += promptTokens;
		this.completionTokens += completionTokens;
		this.cachedTokens += cachedTokens;
	}

	get totalTokens(): number {
		return this.promptTokens + this.completionTokens;
	}

	/** 累计花费（美元）。没有价目表时返回 null。 */
	get costUsd(): number | null {
		if (!this.pricing) return null;
		const cached = Math.min(this.cachedTokens, this.promptTokens);
		const uncached = this.promptTokens - cached;
		const cachedPrice = this.pricing.cachedInputPerMTok ?? this.pricing.inputPerMTok;
		return (
			(uncached / 1_000_000) * this.pricing.inputPerMTok +
			(cached / 1_000_000) * cachedPrice +
			(this.completionTokens / 1_000_000) * this.pricing.outputPerMTok
		);
	}
}
