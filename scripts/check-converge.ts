import { accountConvergence, gatherSignals } from "../lib/signals/converge";
(async () => {
  const all = await gatherSignals();
  const byMod: Record<string, number> = {};
  for (const s of all) byMod[s.modality] = (byMod[s.modality] ?? 0) + 1;
  console.log(`\nUnified signal surface: ${all.length} signals — ${Object.entries(byMod).map(([k,v])=>`${v} ${k}`).join(", ")}\n`);
  const ins = await accountConvergence();
  console.log(`=== CONVERGENCE INSIGHTS (${ins.length}) — only multi-source clusters ===`);
  for (const c of ins) {
    console.log(`\n■ [${c.client}] ${c.theme.slice(0,70)}`);
    console.log(`  ${c.modalities.length} modalities: ${c.modalities.join(", ")} · ${c.projects.length} engagement(s) · conf ${c.confidence} · ${c.kind}`);
    console.log(`  so what: ${c.soWhat}`);
    console.log(`  trail:`);
    for (const s of c.signals) console.log(`    - [${s.modality} · ${s.source.split("/").pop()} · ${s.project}] ${s.text.slice(0,64)}`);
  }
  process.exit(0);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
