/* ---------------------------------------------------------------------------
   chunk.ts — split a document into retrieval-sized pieces.

   Why chunk at all? Vector search returns whole chunks, so we want each chunk
   big enough to be meaningful but small enough to be specific. We pack whole
   paragraphs together up to a size limit and carry a little OVERLAP between
   chunks so a point split across a boundary isn't lost.

   Two upgrades over naive paragraph-packing, both aimed at real documents
   (60-min transcripts, a round of 10+ interviews):

     1. STRUCTURAL / heading-aware — we track the markdown heading hierarchy and
        (a) start a fresh chunk at each section boundary, and (b) stamp every
        chunk with its heading breadcrumb ("Report › Segmentation › Margins").
        A retrieved passage then carries the section it came from, so a chunk
        about "margins" isn't stranded without knowing what it's the margins OF.
     2. A hard TOKEN budget is enforced downstream at embed time (see
        vectors.ts) because the embedder (all-MiniLM, ~256-token window) silently
        truncates anything longer — char size alone can't guarantee that.

   Deliberately hand-written so you can read exactly how it works.
--------------------------------------------------------------------------- */

const MAX_CHARS = 900; // body chars per chunk (~200 tokens for prose — under the embedder window)
const OVERLAP = 150; // characters of the previous chunk repeated for continuity

// A chunk carries its heading breadcrumb separately from its body so the body
// can be re-split (token guard) while the breadcrumb is re-stamped on each piece.
export type Chunk = { crumb: string; text: string };

// Recognise an ATX markdown heading line ("## 3. Segmentation") → level + title.
function parseHeading(line: string): { level: number; title: string } | null {
  const m = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
  return m ? { level: m[1].length, title: m[2].trim() } : null;
}

// Split into heading-aware chunks. Each chunk knows the section path it belongs to.
export function chunkDocument(text: string, maxChars = MAX_CHARS, overlap = OVERLAP): Chunk[] {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const stack: { level: number; title: string }[] = [];
  const crumb = () => stack.map((h) => h.title).join(" › ");

  const out: Chunk[] = [];
  let current = "";
  let currentCrumb = "";
  const flush = () => {
    if (current.trim()) out.push({ crumb: currentCrumb, text: current.trim() });
    current = "";
  };

  for (let block of blocks) {
    // A block may lead with a heading (with or without a blank line before its body).
    const firstLine = block.split("\n", 1)[0];
    const h = parseHeading(firstLine);
    if (h) {
      flush(); // a heading always starts a new section → new chunk
      while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
      stack.push(h);
      currentCrumb = crumb();
      block = block.slice(firstLine.length).trim(); // keep any body that shared the block
      if (!block) continue;
    }

    const c = crumb();
    if (current && c !== currentCrumb) flush(); // section changed mid-stream → boundary
    if (!current) currentCrumb = c;

    if (current && current.length + block.length + 2 > maxChars) {
      out.push({ crumb: currentCrumb, text: current.trim() });
      current = current.slice(-overlap) + "\n\n" + block; // overlap tail, within the same section
    } else {
      current = current ? current + "\n\n" + block : block;
    }
  }
  flush();

  // Hard-split any single oversize body (e.g. one giant paragraph / a wide table),
  // keeping the breadcrumb on every piece. The token guard downstream is the real
  // ceiling; this just keeps the char path sane.
  return out.flatMap((ch) =>
    ch.text.length <= maxChars * 1.5 ? [ch] : hardSplit(ch, maxChars, overlap)
  );
}

function hardSplit(chunk: Chunk, maxChars: number, overlap: number): Chunk[] {
  const parts: Chunk[] = [];
  for (let i = 0; i < chunk.text.length; i += maxChars - overlap) {
    parts.push({ crumb: chunk.crumb, text: chunk.text.slice(i, i + maxChars) });
  }
  return parts;
}

// Compose a chunk into the single string that gets embedded + stored: the heading
// breadcrumb leads the body so retrieval matches on section context too.
export function composeChunk(c: Chunk): string {
  return c.crumb ? `[${c.crumb}]\n\n${c.text}` : c.text;
}

// Backward-compatible: plain string chunks with the section breadcrumb baked in.
export function chunkText(text: string, maxChars = MAX_CHARS, overlap = OVERLAP): string[] {
  return chunkDocument(text, maxChars, overlap).map(composeChunk);
}
