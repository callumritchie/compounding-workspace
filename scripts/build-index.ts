/* Build the vector index from the whole corpus.
   Run: npm run index   (first run downloads the embedding model ~90MB) */
export {};

async function main() {
  const { buildIndex } = await import("../lib/vectors");
  console.log("chunking + embedding the corpus…");
  const n = await buildIndex();
  console.log(`✅ indexed ${n} chunks → workspace/index/vectors.db`);
}

main();
