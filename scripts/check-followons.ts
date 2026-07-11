import { buildFollowOns, buildPropositions } from "../lib/followons";
(async () => {
  const fos = await buildFollowOns();
  console.log(`\n=== FOLLOW-ONS (${fos.length}) — near-term, named ===`);
  for (const f of fos) {
    console.log(`\n■ ${f.client} (${f.sector})  conf ${f.confidence}`);
    console.log(`  contact: ${f.contact ? `${f.contact.name}, ${f.contact.role}` : "— none on record"}`);
    console.log(`  said:    "${f.headline.slice(0,80)}"`);
    console.log(`  move:    ${f.move}${f.offering ? " [catalogue]" : " [bespoke]"}`);
    console.log(`  stress:  ${f.stressTest.length ? f.stressTest.map(s=>`\n           - ${s}`).join("") : "(none)"}`);
  }
  const props = await buildPropositions();
  console.log(`\n\n=== PROPOSITIONS (${props.length}) — broad, de-identified ===`);
  for (const p of props) {
    console.log(`\n■ ${p.label.slice(0,70)}`);
    console.log(`  ${p.clients} clients · ${p.sectors.join(", ")} · conf ${p.confidence}`);
    console.log(`  evidence: ${p.evidence.length} quote(s)`);
    console.log(`  stress:  ${p.stressTest.map(s=>`\n           - ${s}`).join("")}`);
  }
  process.exit(0);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
