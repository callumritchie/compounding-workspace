import { buildOffers } from "../lib/offers";
(async () => {
  const offers = await buildOffers();
  console.log(`\n${offers.length} offer(s) computed from live whitespace:\n`);
  for (const o of offers) {
    console.log(`■ ${o.need}`);
    console.log(`  DEMAND   ${o.demand.count} clients · ${o.demand.sectors.join(", ")}${o.demand.oldestDays != null ? ` · oldest ask ${o.demand.oldestDays}d` : ""}`);
    console.log(`  PRICE    ${o.price ? `£${Math.round(o.price.low/1000)}k–£${Math.round(o.price.high/1000)}k · ${Math.round(o.price.margin*100)}% margin vs ${Math.round(o.price.bookMargin*100)}% book · ${o.price.comparables} comps` : "none (no comparable)"}`);
    console.log(`  STAFFING ${o.staffing.band}${o.staffing.available.length ? ` — ${o.staffing.available.map(a=>`${a.name}/${a.grade}(${a.rollsOffInDays}d)`).join(", ")}` : o.staffing.gapNote ? ` — ${o.staffing.gapNote}` : ""}`);
    console.log(`  FIT      ${o.fit.kind} · nearest "${o.fit.nearest}" (${o.fit.coverage})`);
    console.log(`  CONF     ${o.confidence}  [demand ${o.legs.demand} · price ${o.legs.price} · staffing ${o.legs.staffing}]`);
    console.log(`  STRESS   ${o.stressTest.length ? o.stressTest.map(s=>`\n           - ${s}`).join("") : "(none)"}`);
    console.log("");
  }
  process.exit(0);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
