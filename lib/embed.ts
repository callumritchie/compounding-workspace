/* ---------------------------------------------------------------------------
   embed.ts — turn text into vectors, locally and for free.

   Uses Transformers.js (all-MiniLM-L6-v2) running IN THIS PROCESS — no API, no
   key, no server. The first call downloads the model (~90MB) and caches it;
   after that it's instant. Vectors are 384 numbers that capture MEANING, so two
   differently-worded-but-related texts land close together.
--------------------------------------------------------------------------- */

import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// Load the model once and reuse it (a cached promise = a singleton).
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  return extractorPromise;
}

// Embed many texts at once → an array of 384-dim vectors (mean-pooled, unit
// length, so a plain dot product IS the cosine similarity).
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  return output.tolist() as number[][];
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0];
}

// How many tokens each text costs THIS model's tokenizer (incl. the [CLS]/[SEP]
// specials). all-MiniLM has a ~256-token window and silently truncates past it,
// so the indexer uses this to guarantee no chunk overflows (see vectors.ts).
export async function countTokens(texts: string[]): Promise<number[]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  // The feature-extraction pipeline exposes the model's own tokenizer.
  const tokenizer = (extractor as unknown as { tokenizer: (t: string) => { input_ids: { dims: number[] } } }).tokenizer;
  return texts.map((t) => {
    const enc = tokenizer(t);
    const dims = enc.input_ids.dims; // [1, seqLen]
    return dims[dims.length - 1];
  });
}

// The embedder's usable context. Keep chunks at or under this so nothing is
// truncated at embed time. Exported so the indexer and any splitter share it.
export const MAX_EMBED_TOKENS = 256;
