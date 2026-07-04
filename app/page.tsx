"use client";

/* ---------------------------------------------------------------------------
   page.tsx — the whole UI, on one screen.

   Three panels:
     • Files      (left)   — the SHARED corpus. Click a file to open it.
     • Chat       (centre) — talk to the AI teammate. It can read/search/write files.
     • Glass box  (right)  — the agent's tool calls from the last turn.

   "Working context" (which file you have open + your recent actions) travels
   with every message, so "summarise this" resolves to your open file.
--------------------------------------------------------------------------- */

import { useEffect, useRef, useState } from "react";

type Message = { role: "user" | "assistant"; content: string };
type User = "alice" | "bob";
type TraceEntry = { tool: string; input: Record<string, unknown>; summary: string };
type Injected = { id: string; scope: string; type: string; tier: string; tokens: number };
type Dropped = { id: string; scope: string; reason: string };
type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };
type ContextReport = {
  injected: Injected[];
  dropped: Dropped[];
  stableTokens: number;
  volatileTokens: number;
  budgets: { stable: number; ranked: number };
  usage: Usage;
};

type Nomination = {
  id: string;
  fact: string;
  targetScope: string;
  reason: string;
  nominatedBy: string;
  sourceProject: string;
  sourceClient: string;
  created: string;
};
type Chunk = { file: string; text: string; score: number };
type CompareResult = {
  naive: { chunks: Chunk[]; answer: string };
  reranked: { chunks: Chunk[]; answer: string };
  agentic: { answer: string; trace: TraceEntry[] };
};
type Leak = { flagged: boolean; hits: string[] };
type Signal = {
  pattern: string;
  count: number;
  lastObservation: string;
  targetScope: string;
  nominated: boolean;
};

export default function Home() {
  const [user, setUser] = useState<User>("alice");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [files, setFiles] = useState<string[]>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [openContent, setOpenContent] = useState<string>("");
  const [recentActions, setRecentActions] = useState<string[]>([]);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [context, setContext] = useState<ContextReport | null>(null);
  const [feedbackNote, setFeedbackNote] = useState<string | null>(null);

  const [project, setProject] = useState("acme-health");
  const [projects, setProjects] = useState<string[]>([]);
  const [nominations, setNominations] = useState<Nomination[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [signalThreshold, setSignalThreshold] = useState(3);
  const [showQueue, setShowQueue] = useState(false);
  const [abstracts, setAbstracts] = useState<Record<string, { text: string; leak?: Leak }>>({});

  const [showCompare, setShowCompare] = useState(false);
  const [compareQ, setCompareQ] = useState("");
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [uploading, setUploading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load the file list once (and refresh it after each turn, in case the agent wrote one).
  function loadFiles() {
    fetch(`/api/files?project=${project}`)
      .then((r) => r.json())
      .then((d) => setFiles(d.files ?? []))
      .catch(() => setFiles([]));
  }
  // Reload the corpus whenever the project changes; reset the open file.
  useEffect(() => {
    loadFiles();
    setOpenFile(null);
    setOpenContent("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // Load the list of projects once (for the switcher).
  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => setProjects([]));
  }, []);

  // Load the promotion review queue (pending nominations).
  function loadPromotions() {
    fetch("/api/promotions")
      .then((r) => r.json())
      .then((d) => setNominations(d.nominations ?? []))
      .catch(() => setNominations([]));
  }
  useEffect(loadPromotions, []);

  // Load the implicit-signal ledger.
  function loadSignals() {
    fetch("/api/signals")
      .then((r) => r.json())
      .then((d) => {
        setSignals(d.signals ?? []);
        if (d.threshold) setSignalThreshold(d.threshold);
      })
      .catch(() => setSignals([]));
  }
  useEffect(loadSignals, []);

  async function doAbstract(id: string) {
    const d = await fetch("/api/promotions/abstract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (typeof d.abstracted === "string") {
      setAbstracts((a) => ({ ...a, [id]: { text: d.abstracted, leak: d.leak } }));
    }
  }

  async function doPromote(id: string) {
    const text = abstracts[id]?.text ?? nominations.find((n) => n.id === id)?.fact ?? "";
    const d = await fetch("/api/promotions/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, text }),
    }).then((r) => r.json());
    if (d.ok) setNominations((ns) => ns.filter((n) => n.id !== id));
  }

  async function runCompare() {
    if (!compareQ.trim() || comparing) return;
    setComparing(true);
    setCompareResult(null);
    try {
      const d = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: compareQ, project }),
      }).then((r) => r.json());
      if (!d.error) setCompareResult(d);
    } finally {
      setComparing(false);
    }
  }

  async function doReject(id: string) {
    await fetch("/api/promotions/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setNominations((ns) => ns.filter((n) => n.id !== id));
  }

  // Load THIS user's private history when we switch user.
  useEffect(() => {
    fetch(`/api/history?user=${user}`)
      .then((r) => r.json())
      .then((d) => setMessages(d.history ?? []))
      .catch(() => setMessages([]));
    setTrace([]);
    setContext(null);
    setFeedbackNote(null);
  }, [user]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function noteAction(action: string) {
    setRecentActions((a) => [...a, action].slice(-8));
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    fd.append("project", project);
    setUploading(true);
    try {
      const d = await fetch("/api/upload", { method: "POST", body: fd }).then((r) => r.json());
      if (d.file) {
        loadFiles();
        openFileFn(d.file);
      }
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function openFileFn(path: string) {
    setOpenFile(path);
    noteAction(`opened ${path}`);
    try {
      const d = await fetch(`/api/files/read?project=${project}&path=${encodeURIComponent(path)}`).then((r) => r.json());
      setOpenContent(d.content ?? d.error ?? "");
    } catch {
      setOpenContent("(could not load file)");
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    setMessages((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setLoading(true);
    setFeedbackNote(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, message: text, project, openFile, recentActions }),
      });
      const data = await res.json();
      if (data.history) {
        setMessages(data.history);
        setTrace(data.trace ?? []);
        setContext(data.context ?? null);
        if (data.files) setFiles(data.files);
        loadPromotions(); // the agent may have nominated a lesson this turn
        loadSignals(); // ...or logged a recurring signal
        noteAction(`asked "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"`);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${data.error}` }]);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "network error";
      setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${detail}` }]);
    } finally {
      setLoading(false);
    }
  }

  // Correctness feedback → reinforce the learned memories behind this answer.
  async function sendFeedback(verdict: "good" | "bad") {
    if (!context) return;
    const items = context.injected
      .filter((m) => m.type === "learned")
      .map((m) => ({ scope: m.scope, id: m.id, type: m.type }));
    const r = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict, items }),
    }).then((res) => res.json());
    const dir = verdict === "good" ? "↑" : "↓";
    setFeedbackNote(`${r.changed ?? 0} learned ${r.changed === 1 ? "memory" : "memories"} nudged ${dir} (constitution untouched).`);
  }

  // Contest / retract a memory so it stops being injected.
  async function retract(scope: string, id: string) {
    await fetch("/api/memory/retract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, id }),
    });
    setContext((c) => (c ? { ...c, injected: c.injected.filter((m) => !(m.scope === scope && m.id === id)) } : c));
    setFeedbackNote(`retracted ${scope} — it won't be injected next turn.`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="app">
      {/* ---- Top bar ---- */}
      <div className="topbar">
        <h1>
          Compounding Workspace
          <span className="subtitle">context engineering, made visible</span>
        </h1>
        <div className="topbar-right">
          <select className="project-select" value={project} onChange={(e) => setProject(e.target.value)} title="project">
            {projects.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <button className="queue-btn" onClick={() => setShowCompare(true)}>
            ⚖ Compare retrieval
          </button>
          <button className="queue-btn" onClick={() => { loadPromotions(); loadSignals(); setShowQueue(true); }}>
            ⬆ Promotions{nominations.length ? ` (${nominations.length})` : ""}
          </button>
          <div className="user-switch">
            <span className="subtitle">You are:</span>
            <button className={`alice ${user === "alice" ? "active" : ""}`} onClick={() => setUser("alice")}>Alice</button>
            <button className={`bob ${user === "bob" ? "active" : ""}`} onClick={() => setUser("bob")}>Bob</button>
          </div>
        </div>
      </div>

      {/* ---- Three panels ---- */}
      <div className="panels">
        {/* Left: Files (shared) */}
        <div className="panel">
          <div className="panel-header">Files · shared corpus</div>
          <div className="panel-body">
            <label className="upload">
              {uploading ? "Uploading…" : "+ Upload PDF / text"}
              <input type="file" accept=".pdf,.txt,.md" onChange={handleUpload} hidden disabled={uploading} />
            </label>
            {files.length === 0 && <div className="empty">No files yet.</div>}
            {files.map((f) => (
              <div key={f} className={`file ${openFile === f ? "active" : ""}`} onClick={() => openFileFn(f)}>
                {f}
              </div>
            ))}

            {openFile && (
              <div className="viewer">
                <header>
                  <span>OPEN · {openFile}</span>
                  <button title="close" onClick={() => { setOpenFile(null); setOpenContent(""); }}>×</button>
                </header>
                <pre>{openContent}</pre>
              </div>
            )}
          </div>
        </div>

        {/* Centre: Chat */}
        <div className="panel">
          <div className="panel-header">
            Chat · private to {user}
            {openFile && <span className="badge">this → {openFile.split("/").pop()}</span>}
          </div>
          <div className="chat">
            <div className="messages">
              {messages.length === 0 && (
                <div className="empty">
                  Open a file and try “summarise this”, or ask “what are the main themes across the interviews?”.
                  This history is private to {user}.
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`msg ${m.role}`}>
                  <div className="role">{m.role === "user" ? user : "agent"}</div>
                  {m.content}
                </div>
              ))}
              {loading && (
                <div className="msg assistant">
                  <div className="role">agent</div>
                  <span className="hint">thinking &amp; reading files…</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
            <div className="composer">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask the agent… (Enter to send, Shift+Enter for a new line)"
              />
              <button onClick={send} disabled={loading || !input.trim()}>Send</button>
            </div>
          </div>
        </div>

        {/* Right: Glass box — what the agent saw (memory) and did (tools) */}
        <div className="panel">
          <div className="panel-header">Glass box · what the agent saw &amp; did</div>
          <div className="panel-body">
            {!context && trace.length === 0 && (
              <>
                <div className="empty">Nothing yet.</div>
                <div className="hint">
                  After each turn this shows the memory injected into the prompt (and what was dropped), the
                  token budget, real cache savings, and every tool the agent used.
                </div>
              </>
            )}

            {context && (
              <>
                <div className="ctx-h">Memory injected ({context.injected.length})</div>
                {context.injected.length === 0 && <div className="ctx-item muted">none in scope</div>}
                {context.injected.map((m) => (
                  <div key={m.id} className="ctx-item ctx-row">
                    <span>
                      <span className={`pill ${m.tier}`}>{m.tier}</span> {m.scope} · {m.type} · ~{m.tokens}t
                    </span>
                    <button className="retract" title="retract this memory" onClick={() => retract(m.scope, m.id)}>
                      ✕
                    </button>
                  </div>
                ))}

                {context.dropped.length > 0 && (
                  <>
                    <div className="ctx-h">Dropped ({context.dropped.length})</div>
                    {context.dropped.map((d, i) => (
                      <div key={i} className="ctx-item muted">{d.scope} — {d.reason}</div>
                    ))}
                  </>
                )}

                <div className="ctx-h">Token budget (estimate)</div>
                <div className="ctx-item">
                  stable ~{context.stableTokens}/{context.budgets.stable} · ranked+working ~
                  {context.volatileTokens}/{context.budgets.ranked}
                </div>

                <div className="ctx-h">This turn · real tokens</div>
                <div className="ctx-item">
                  input {context.usage.input} · <b>cache-read {context.usage.cacheRead}</b> · cache-write{" "}
                  {context.usage.cacheWrite} · output {context.usage.output}
                </div>

                <div className="ctx-h">Was this answer right?</div>
                <div className="feedback">
                  <button onClick={() => sendFeedback("good")}>👍 good</button>
                  <button onClick={() => sendFeedback("bad")}>👎 off</button>
                </div>
                {feedbackNote && <div className="ctx-item muted">{feedbackNote}</div>}
              </>
            )}

            {trace.length > 0 && (
              <>
                <div className="ctx-h">Tool calls ({trace.length})</div>
                {trace.map((t, i) => (
                  <div key={i} className="trace-item">
                    <span className="trace-step">{i + 1}.</span>
                    <code>{t.tool}</code> {t.summary}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ---- Retrieval comparison (modal) ---- */}
      {showCompare && (
        <div className="modal-overlay" onClick={() => setShowCompare(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Retrieval comparison · {project}</h2>
              <button onClick={() => setShowCompare(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="compare-input">
                <input
                  value={compareQ}
                  onChange={(e) => setCompareQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") runCompare(); }}
                  placeholder="Ask a question about this project's files…"
                />
                <button className="promote" onClick={runCompare} disabled={comparing || !compareQ.trim()}>
                  {comparing ? "Running…" : "Run"}
                </button>
              </div>
              <p className="hint">
                Same question, three ways to fetch context. Watch how the retrieved passages — and the
                answer — differ. (Agentic runs without memory, to isolate the retrieval strategy.)
              </p>

              {compareResult && (
                <div className="compare-grid">
                  {(["naive", "reranked", "agentic"] as const).map((mode) => (
                    <div key={mode} className="compare-col">
                      <div className="compare-h">
                        {mode === "naive" ? "Naïve vector" : mode === "reranked" ? "Reranked vector" : "Agentic"}
                      </div>
                      {mode !== "agentic" &&
                        compareResult[mode].chunks.map((c, i) => (
                          <div key={i} className="compare-chunk">
                            <span className="chunk-score">{c.score.toFixed(2)}</span> {c.file}
                            <div className="chunk-text">{c.text.slice(0, 130)}…</div>
                          </div>
                        ))}
                      {mode === "agentic" &&
                        compareResult.agentic.trace.map((t, i) => (
                          <div key={i} className="compare-chunk">
                            <code>{t.tool}</code> {t.summary}
                          </div>
                        ))}
                      <div className="compare-answer">{compareResult[mode].answer}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---- Promotion review queue (modal) ---- */}
      {showQueue && (
        <div className="modal-overlay" onClick={() => setShowQueue(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Promotion review queue</h2>
              <button onClick={() => setShowQueue(false)}>×</button>
            </div>
            <div className="modal-body">
              {signals.length > 0 && (
                <div className="signals">
                  <div className="ctx-h">Signals accumulating (implicit)</div>
                  {signals.map((s) => (
                    <div key={s.pattern} className="sig">
                      <div className="sig-top">
                        <b>{s.pattern}</b>
                        <span className="sig-count">
                          {s.count}/{signalThreshold}
                          {s.nominated ? " · nominated ✓" : ""}
                        </span>
                      </div>
                      <div className="sig-bar">
                        <div
                          className="sig-fill"
                          style={{ width: `${Math.min(100, (s.count / signalThreshold) * 100)}%` }}
                        />
                      </div>
                      <div className="sig-obs">{s.lastObservation}</div>
                    </div>
                  ))}
                </div>
              )}

              {nominations.length === 0 && (
                <div className="empty">
                  Nothing pending. When the agent nominates a project lesson to promote, it appears here — this
                  is your “latent signals” inbox.
                </div>
              )}
              {nominations.map((n) => (
                <div key={n.id} className="nom">
                  <div className="nom-target">
                    promote to <b>{n.targetScope}</b>
                  </div>
                  <div className="nom-fact">“{n.fact}”</div>
                  <div className="nom-meta">
                    nominated by {n.nominatedBy} · from {n.sourceProject} · {n.reason}
                  </div>
                  <button className="mini" onClick={() => doAbstract(n.id)}>
                    Abstract &amp; leak-check
                  </button>
                  {abstracts[n.id] && (
                    <>
                      {abstracts[n.id].leak?.flagged && (
                        <div className="leak">
                          ⚠ possible client detail: {abstracts[n.id].leak!.hits.join(", ")} — edit before promoting
                        </div>
                      )}
                      <textarea
                        className="nom-edit"
                        value={abstracts[n.id].text}
                        onChange={(e) =>
                          setAbstracts((a) => ({ ...a, [n.id]: { ...a[n.id], text: e.target.value } }))
                        }
                      />
                    </>
                  )}
                  <div className="nom-actions">
                    <button className="promote" onClick={() => doPromote(n.id)}>
                      Promote{abstracts[n.id] ? " (abstracted)" : " as-is"}
                    </button>
                    <button className="reject" onClick={() => doReject(n.id)}>
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
