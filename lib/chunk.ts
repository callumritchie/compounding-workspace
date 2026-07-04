/* ---------------------------------------------------------------------------
   chunk.ts — split a document into retrieval-sized pieces.

   Why chunk at all? Vector search returns whole chunks, so we want each chunk
   big enough to be meaningful but small enough to be specific. We pack whole
   paragraphs together up to a size limit (headings stay attached to the text
   that follows them), and carry a little OVERLAP between chunks so a point
   split across a boundary isn't lost.

   Deliberately hand-written (~30 lines) so you can read exactly how it works —
   this is the 2026 best-practice "recursive/paragraph" approach, kept legible.
--------------------------------------------------------------------------- */

const MAX_CHARS = 900; // ~a few hundred tokens per chunk
const OVERLAP = 150; // characters of the previous chunk repeated for continuity

export function chunkText(text: string, maxChars = MAX_CHARS, overlap = OVERLAP): string[] {
  // Split into paragraphs on blank lines (headings stay with their paragraph).
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > maxChars) {
      chunks.push(current);
      current = current.slice(-overlap) + "\n\n" + para; // start next with an overlap tail
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current) chunks.push(current);

  // Hard-split any single oversize chunk (e.g. one giant paragraph).
  return chunks.flatMap((c) => (c.length <= maxChars * 1.5 ? [c] : hardSplit(c, maxChars, overlap)));
}

function hardSplit(text: string, maxChars: number, overlap: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars - overlap) out.push(text.slice(i, i + maxChars));
  return out;
}
