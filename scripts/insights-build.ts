/* ---------------------------------------------------------------------------
   insights-build.ts — compute the EXPENSIVE latent layer, deliberately.

   The deep triangulation (Opus), delivery-theme propositions (emergent themes), and
   web enrichment cost real tokens, so they must NOT run on every inbox load. This
   script computes them once and writes workspace/signals/deep.json, which the feed
   then just reads. Run it when the signals have meaningfully changed:

       npm run insights:build

   Everything else in the feed (offers, follow-ons, demand propositions) is
   deterministic and always live — this only refreshes the model-derived layer.
--------------------------------------------------------------------------- */

async function run() {
  const { computeDeepInsights } = await import("../lib/deep-insights");
  console.log("Computing latent layer (Opus triangulation + emergent themes + web enrichment)…");
  const t0 = Date.now();
  const { triangulated, deliveryPropositions } = await computeDeepInsights();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (!triangulated.length && !deliveryPropositions.length) {
    console.log(`\n⚠️  Nothing computed in ${secs}s — the model layer returned empty (check the API key / credits). The cache was left untouched.`);
    process.exit(1);
  }
  console.log(`\n✅ Built in ${secs}s → workspace/signals/deep.json`);
  console.log(`   ${triangulated.length} triangulated insight(s):`);
  for (const t of triangulated) console.log(`     • ${t.insight.slice(0, 90)}  [${t.connected.length} signals · conf ${t.confidence}]`);
  console.log(`   ${deliveryPropositions.length} delivery-theme proposition(s):`);
  for (const p of deliveryPropositions) console.log(`     • ${p.label.slice(0, 90)}`);
  const web = [...triangulated, ...deliveryPropositions].filter((x) => x.webContext).length;
  console.log(`   ${web} item(s) web-enriched.`);
  process.exit(0);
}

run().catch((e) => {
  console.error("insights:build failed:", e);
  process.exit(1);
});
