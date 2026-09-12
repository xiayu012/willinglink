import "server-only";

import { embed, embedMany } from "ai";
import { getEmbeddingModel } from "@/lib/ai/providers";
import { trackedGatewayCall } from "./gateway-ledger";

/**
 * 判例与资料的向量化。
 *
 * **只用于检索证据，不用于行为规则。** 行为准则留在 doctrine/*.md 里——
 * 规则越多越互相抵消（见 AGENT_LOG 2026-08-30 的「按周轮换」事故），
 * 而"这类事以前怎么收场的"是知识，多多益善。
 *
 * 维度必须与建表时的 `vector(1536)` 一致。换模型就要改列定义并重算全部向量。
 */
export const EMBEDDING_DIM = 1536;

function modelId(): string {
  return process.env.COLIVING_EMBEDDING_MODEL?.trim() || "openai/text-embedding-3-small";
}

/** pgvector 的字面量格式是 `[0.1,0.2,...]`，不是 postgres 数组 */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

export async function embedOne(text: string): Promise<number[]> {
  const id = modelId();
  // embedding 没有 step hook：整个调用是一步，走台账的 embedding 口径
  // （tokens 只有总量、无缓存明细）。生产无台账时原样透传。
  const { embedding } = await trackedGatewayCall(
    "embed",
    id,
    () => embed({ model: getEmbeddingModel(id), value: text }),
    { kind: "embedding" }
  );
  return embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  const id = modelId();
  const { embeddings } = await trackedGatewayCall(
    "embed-batch",
    id,
    () => embedMany({ model: getEmbeddingModel(id), values: texts }),
    { kind: "embedding" }
  );
  return embeddings;
}
