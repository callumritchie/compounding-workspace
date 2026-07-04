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
