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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Message = { role: "user" | "assistant"; content: string };
type User = "alice" | "bob";
type TraceEntry = { tool: string; input: Record<string, unknown>; summary: string };
type Injected = { id: string; scope: string; type: string; tier: string; tokens: number; text: string };
type Dropped = { id: string; scope: string; reason: string };
type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };
type CompPart = { label: string; tokens: number; tier: string };
type ContextReport = {
  injected: Injected[];
  dropped: Dropped[];
  stableTokens: number;
  volatileTokens: number;
  budgets: { stable: number; ranked: number };
  usage: Usage;
  composition?: CompPart[];
};

// Fixed palette so each input-composition segment keeps the same colour
// between the bar and its legend.
const COMP_COLORS = ["#6366f1", "#8b5cf6", "#0ea5e9", "#f59e0b", "#10b981", "#ef4444", "#ec4899"];

// One chat tab's metadata (mirrors lib/workspace ChatMeta).
type ChatMeta = { chatId: string; title: string; updated: string; lastUserMessage?: string; openFile?: string | null };

// A project's config (mirrors lib/project ProjectConfig) — a client can have several.
type ProjectMeta = { id: string; name: string; client: string; sector: string; type: string; status: string };

// A suggested (not-yet-saved) shared memory awaiting approval.
type Proposal = { id: string; fact: string; scope: string; proposedBy: string; sourceProject: string; created: string };

// A memory as shown in the manager (the whole library, incl. retracted).
type MemItem = {
  id: string;
  scope: string;
  type: string;
  importance: number;
  status: string;
  confidential?: boolean;
  body: string;
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
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [activeChat, setActiveChat] = useState<string | null>(null);
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
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [nominations, setNominations] = useState<Nomination[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [signalThreshold, setSignalThreshold] = useState(3);
  const [showQueue, setShowQueue] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [showProposals, setShowProposals] = useState(false);
  const [abstracts, setAbstracts] = useState<Record<string, { text: string; leak?: Leak }>>({});

  const [showCompare, setShowCompare] = useState(false);
  const [compareQ, setCompareQ] = useState("");
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [allMemories, setAllMemories] = useState<MemItem[]>([]);
  const [memDraft, setMemDraft] = useState<Record<string, { body: string; importance: number }>>({});
  const [memNote, setMemNote] = useState<string | null>(null);

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

  // Load suggested (unsaved) shared memories awaiting approval.
  function loadProposals() {
    fetch("/api/memory/proposals")
      .then((r) => r.json())
      .then((d) => setProposals(d.proposals ?? []))
      .catch(() => setProposals([]));
  }
  useEffect(loadProposals, []);
  async function approveProp(id: string) {
    await fetch("/api/memory/proposals/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    loadProposals();
  }
  async function dismissProp(id: string) {
    await fetch("/api/memory/proposals/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    loadProposals();
  }

  // ---- Memory manager: load + edit the whole library ----
  function loadMemories() {
    fetch("/api/memory/list")
      .then((r) => r.json())
      .then((d) => {
        const mems: MemItem[] = d.memories ?? [];
        setAllMemories(mems);
        const draft: Record<string, { body: string; importance: number }> = {};
        for (const m of mems) draft[`${m.scope}:${m.id}`] = { body: m.body, importance: m.importance };
        setMemDraft(draft);
      })
      .catch(() => setAllMemories([]));
  }
  async function saveMem(m: MemItem) {
    const d = memDraft[`${m.scope}:${m.id}`];
    await fetch("/api/memory/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: m.scope, id: m.id, body: d.body, importance: d.importance }),
    });
    setMemNote(`saved ${m.scope}/${m.id}`);
    loadMemories();
  }
  async function setMemStatus(m: MemItem, status: string) {
    await fetch("/api/memory/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: m.scope, id: m.id, status }),
    });
    setMemNote(`${status === "retracted" ? "retracted" : "restored"} ${m.scope}/${m.id}`);
    loadMemories();
  }
  async function deleteMem(m: MemItem) {
    await fetch("/api/memory/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: m.scope, id: m.id }),
    });
    setMemNote(`deleted ${m.scope}/${m.id}`);
    loadMemories();
  }

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

  // ---- Chat tabs (concurrent tasks; memory + files stay shared) ----
  // Open a tab: load its messages, reset the per-tab session view.
  async function openChatMeta(meta: ChatMeta) {
    setActiveChat(meta.chatId);
    setTrace([]);
    setContext(null);
    setFeedbackNote(null);
    setRecentActions([]);
    setOpenFile(null);
    setOpenContent("");
    const d = await fetch(`/api/history?user=${user}&chat=${meta.chatId}`).then((r) => r.json()).catch(() => ({}));
    setMessages(d.history ?? []);
  }

  async function refreshChats(): Promise<ChatMeta[]> {
    const list: ChatMeta[] = await fetch(`/api/chats?user=${user}`)
      .then((r) => r.json())
      .then((d) => d.chats ?? [])
      .catch(() => []);
    setChats(list);
    return list;
  }

  async function newChat() {
    const created = await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user }),
    }).then((r) => r.json());
    if (created.chat) {
      await refreshChats();
      openChatMeta(created.chat);
    }
  }

  async function closeChat(meta: ChatMeta) {
    await fetch("/api/chats/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, chatId: meta.chatId }),
    });
    let list = await refreshChats();
    if (list.length === 0) {
      const created = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user }),
      }).then((r) => r.json());
      list = await refreshChats();
      if (created.chat) openChatMeta(created.chat);
      return;
    }
    if (activeChat === meta.chatId) openChatMeta(list[0]);
  }

  async function clearActiveChat() {
    if (!activeChat) return;
    await fetch("/api/chats/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, chatId: activeChat }),
    });
    setMessages([]);
    setTrace([]);
    setContext(null);
    setFeedbackNote(null);
    refreshChats();
  }

  // On user switch: load their tabs (create one if none), open the first.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let list: ChatMeta[] = await fetch(`/api/chats?user=${user}`)
        .then((r) => r.json())
        .then((d) => d.chats ?? [])
        .catch(() => []);
      if (cancelled) return; // a superseded run (e.g. StrictMode double-mount) must not create a tab
      if (list.length === 0) {
        const created = await fetch("/api/chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user }),
        }).then((r) => r.json());
        if (cancelled) return;
        list = created.chat ? [created.chat] : [];
      }
      setChats(list);
      if (list[0]) openChatMeta(list[0]);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (!text || loading || !activeChat) return;

    setMessages((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setLoading(true);
    setFeedbackNote(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, message: text, project, openFile, recentActions, chatId: activeChat }),
      });
      const data = await res.json();
      if (data.history) {
        setMessages(data.history);
        setTrace(data.trace ?? []);
        setContext(data.context ?? null);
        if (data.files) setFiles(data.files);
        loadPromotions(); // the agent may have nominated a lesson this turn
        loadSignals(); // ...or logged a recurring signal
        loadProposals(); // ...or suggested a shared memory to approve
        refreshChats(); // the tab's title + last-activity may have changed
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
          <select className="project-select" value={project} onChange={(e) => setProject(e.target.value)} title="project (grouped by client · ✓ complete, ● in-progress)">
            {Object.entries(
              projects.reduce<Record<string, ProjectMeta[]>>((acc, p) => {
                (acc[p.client] ||= []).push(p);
                return acc;
              }, {})
            ).map(([client, ps]) => (
              <optgroup key={client} label={client}>
                {ps.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.status === "complete" ? "✓" : "●"} {p.name} · {p.type}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button className="queue-btn" onClick={() => setShowCompare(true)}>
            ⚖ Compare retrieval
          </button>
          <button className="queue-btn" onClick={() => { loadPromotions(); loadSignals(); setShowQueue(true); }}>
            ⬆ Promotions{nominations.length ? ` (${nominations.length})` : ""}
          </button>
          <button className="queue-btn" onClick={() => { loadProposals(); setShowProposals(true); }}>
            💡 Suggested{proposals.length ? ` (${proposals.length})` : ""}
          </button>
          <button className="queue-btn" onClick={() => { loadMemories(); setShowMemory(true); }}>
            🧠 Memory
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
          <div className="tabbar">
            <div className="tabs">
              {chats.map((c) => (
                <div
                  key={c.chatId}
                  className={`tab ${c.chatId === activeChat ? "active" : ""}`}
                  onClick={() => openChatMeta(c)}
                  title={c.title}
                >
                  <span className="tab-title">{c.title || "New chat"}</span>
                  {chats.length > 1 && (
                    <button
                      className="tab-x"
                      title="close tab"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeChat(c);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button className="tab-new" title="start a new chat" onClick={newChat}>＋ New</button>
            <button className="tab-clear" title="clear this chat" onClick={clearActiveChat}>Clear</button>
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
                  {m.role === "assistant" ? (
                    <div className="markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </div>
                  ) : (
                    m.content
                  )}
                </div>
              ))}
              {/* Memory-awareness chips for the latest turn (from its tool trace) */}
              {!loading &&
                trace
                  .filter((t) => t.tool === "save_memory")
                  .map((t, i) => {
                    const personal = String(t.summary).includes("remembered");
                    const fact = String((t.input as { fact?: string })?.fact ?? "");
                    return (
                      <div key={`chip-${i}`} className={`mem-chip ${personal ? "saved" : "suggested"}`}>
                        <span>
                          {personal ? "🧠 Remembered" : "💡 Suggested for the team"}: “{fact}”
                        </span>
                        {!personal && (
                          <button onClick={() => { loadProposals(); setShowProposals(true); }}>Review</button>
                        )}
                      </div>
                    );
                  })}
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
                <div className="ctx-cap">
                  Small facts the agent already knows, pushed into every prompt (not the files). 🔒 always-on =
                  cached &amp; reused free · ↻ per-turn = re-ranked each turn.
                </div>
                {context.injected.length === 0 && <div className="ctx-item muted">none in scope</div>}
                {context.injected.map((m) => (
                  <div key={m.id} className="mem-inj">
                    <div className="mem-inj-top">
                      <span className={`pill ${m.tier}`}>
                        {m.tier === "stable" ? "🔒 always-on" : "↻ per-turn"}
                      </span>
                      <span className="mem-inj-scope">{m.scope}</span>
                      <span className="mem-inj-tok" title="estimated size in tokens">~{m.tokens} tok</span>
                      <button
                        className="retract"
                        title="stop injecting this memory (from next turn)"
                        onClick={() => retract(m.scope, m.id)}
                      >
                        Retract
                      </button>
                    </div>
                    <div className="mem-inj-text">“{m.text}”</div>
                  </div>
                ))}

                {context.dropped.length > 0 && (
                  <>
                    <div className="ctx-h">Dropped ({context.dropped.length})</div>
                    {context.dropped.map((d, i) => (
                      <div key={i} className="ctx-item muted">
                        {d.scope} — {d.reason.replace("stable", "always-on").replace("ranked", "per-turn")}
                      </div>
                    ))}
                  </>
                )}

                {context.composition && context.composition.length > 0 && (() => {
                  const parts = context.composition;
                  const total = parts.reduce((s, p) => s + p.tokens, 0) || 1;
                  return (
                    <>
                      <div className="ctx-h">Input composition (~{total}t, estimate)</div>
                      <div className="tokbar">
                        {parts.map((p, i) => (
                          <div
                            key={p.label}
                            className="seg"
                            style={{ width: `${(p.tokens / total) * 100}%`, background: COMP_COLORS[i % COMP_COLORS.length] }}
                            title={`${p.label}: ~${p.tokens}t (${p.tier})`}
                          />
                        ))}
                      </div>
                      <div className="toklegend">
                        {parts.map((p, i) => (
                          <span key={p.label} className="legitem">
                            <span className="swatch" style={{ background: COMP_COLORS[i % COMP_COLORS.length] }} />
                            {p.tier === "cached" ? "🔒 " : ""}{p.label} ~{p.tokens}t
                          </span>
                        ))}
                      </div>
                      <div className="tokcap">🔒 cached prefix is reused for free next turn; the rest is re-sent every turn.</div>
                    </>
                  );
                })()}

                <div className="ctx-h">Token budget (estimate)</div>
                <div className="ctx-item">
                  always-on memory ~{context.stableTokens}/{context.budgets.stable} · per-turn ~
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

      {/* ---- Suggested memories (approval inbox) ---- */}
      {showProposals && (
        <div className="modal-overlay" onClick={() => setShowProposals(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Suggested memories</h2>
              <button onClick={() => setShowProposals(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="empty">
                Shared memories the agent proposed. Nothing is saved to the team’s memory until you approve it —
                your personal memories save straight away.
              </div>
              {proposals.length === 0 && <div className="empty">Nothing pending.</div>}
              {proposals.map((p) => (
                <div key={p.id} className="nom">
                  <div className="nom-target">
                    save to <b>{p.scope}</b>
                  </div>
                  <div className="nom-fact">“{p.fact}”</div>
                  <div className="nom-meta">
                    suggested by {p.proposedBy} · from {p.sourceProject}
                  </div>
                  <div className="nom-actions">
                    <button className="promote" onClick={() => approveProp(p.id)}>Approve &amp; save</button>
                    <button className="reject" onClick={() => dismissProp(p.id)}>Dismiss</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ---- Memory manager (modal) ---- */}
      {showMemory && (
        <div className="modal-overlay" onClick={() => setShowMemory(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Memory library</h2>
              <button onClick={() => setShowMemory(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="empty">
                Every memory across all scopes. The glass box shows the subset injected each turn — this is
                where you curate the whole library. Editing here changes the file on disk.
              </div>
              {memNote && <div className="ctx-item">{memNote}</div>}
              {allMemories.length === 0 && <div className="empty">No memories yet.</div>}
              {(() => {
                const grouped = allMemories.reduce<Record<string, MemItem[]>>((acc, m) => {
                  (acc[m.scope] ||= []).push(m);
                  return acc;
                }, {});
                return Object.keys(grouped).sort().map((scope) => (
                  <div key={scope} className="mem-group">
                    <div className="ctx-h">{scope}</div>
                    {grouped[scope].map((m) => {
                      const key = `${m.scope}:${m.id}`;
                      const d = memDraft[key] ?? { body: m.body, importance: m.importance };
                      const retracted = m.status === "retracted";
                      const isConstitution = m.type === "constitution";
                      return (
                        <div key={key} className={`mem-card ${retracted ? "retracted" : ""}`}>
                          <div className="mem-meta">
                            <span className={`pill ${isConstitution ? "stable" : "ranked"}`}>{m.type}</span>
                            {m.confidential && <span className="pill conf">confidential</span>}
                            {retracted && <span className="pill ret">retracted</span>}
                            <span className="mem-id">{m.id}</span>
                          </div>
                          <textarea
                            className="mem-body"
                            value={d.body}
                            onChange={(e) =>
                              setMemDraft((s) => ({ ...s, [key]: { ...d, body: e.target.value } }))
                            }
                          />
                          <div className="mem-controls">
                            {isConstitution ? (
                              <span className="imp muted">authoritative · no decay</span>
                            ) : (
                              <label className="imp">
                                importance {d.importance.toFixed(2)}
                                <input
                                  type="range"
                                  min={0}
                                  max={1}
                                  step={0.05}
                                  value={d.importance}
                                  onChange={(e) =>
                                    setMemDraft((s) => ({ ...s, [key]: { ...d, importance: Number(e.target.value) } }))
                                  }
                                />
                              </label>
                            )}
                            <div className="mem-actions">
                              <button className="mini" onClick={() => saveMem(m)}>Save</button>
                              {retracted ? (
                                <button className="mini" onClick={() => setMemStatus(m, "active")}>Restore</button>
                              ) : (
                                <button className="mini" onClick={() => setMemStatus(m, "retracted")}>Retract</button>
                              )}
                              <button
                                className="reject"
                                onClick={() => {
                                  if (confirm(`Delete "${m.id}"? This removes the file permanently.`)) deleteMem(m);
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
