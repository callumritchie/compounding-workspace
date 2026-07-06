/* Guided kickoff interview.

   GET  /api/kickoff/intake?project=          → { questions }  (3 short intake Qs)
   POST /api/kickoff/intake { project, user, answers:[{question,answer}] }
        → distils each answer into a durable fact and writes it to this project's
          memory as PROVISIONAL (born low, no approval step). Provisional facts are
          injected immediately but self-curate: they graduate through use or retract
          if contradicted — so kickoff captures knowledge without an approval inbox.
        → { facts } (the captured facts, for the UI to confirm) */

import { intakeQuestions, distillFacts } from "@/lib/agent";
import { writeMemory } from "@/lib/memory";
import { DEFAULT_PROJECT } from "@/lib/corpus";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const project = searchParams.get("project") || DEFAULT_PROJECT;
  try {
    return Response.json({ questions: await intakeQuestions(project) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "intake failed";
    return Response.json({ questions: [], error: detail }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const project: string = typeof body?.project === "string" ? body.project : DEFAULT_PROJECT;
  const user: string = typeof body?.user === "string" ? body.user : "callum";
  const answers = Array.isArray(body?.answers)
    ? body.answers
        .map((a: unknown) => ({
          question: String((a as { question?: unknown })?.question ?? ""),
          answer: String((a as { answer?: unknown })?.answer ?? ""),
        }))
        .filter((a: { answer: string }) => a.answer.trim())
    : [];
  if (answers.length === 0) return Response.json({ facts: [] });

  const facts = await distillFacts(project, answers);
  const created = new Date().toISOString().slice(0, 10);
  await Promise.all(
    facts.map((fact) =>
      writeMemory({
        scope: `project/${project}`,
        type: "learned",
        body: fact,
        importance: 0.2,
        status: "provisional",
        provenance: { origin: "kickoff-intake", origin_user: user, origin_project: project, created },
      })
    )
  );
  return Response.json({ facts });
}
