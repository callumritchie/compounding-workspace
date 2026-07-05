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

type TraceEntry = { tool: string; input: Record<string, unknown>; summary: string; result?: string };
type InjectedLite = { id: string; scope: string; type: string; tier: string; text: string };
type MessageMeta = {
  trace?: TraceEntry[];
  reasoning?: string;
  injected?: InjectedLite[];
  usage?: Usage;
  composition?: CompPart[];
};
type Message = { role: "user" | "assistant"; content: string; meta?: MessageMeta };
type User = "alice" | "bob";
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

// The per-message "X-ray": everything that informed a given answer — reasoning,
// tools + retrieved passages, memory used (with retract), the input-composition
// bar, tokens, and 👍/👎 feedback (all folded in from the old glass box).
function Xray({
  meta,
  onFeedback,
  onRetract,
}: {
  meta: MessageMeta;
  onFeedback: (v: "good" | "bad") => Promise<string>;
  onRetract: (scope: string, id: string) => Promise<string>;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [gone, setGone] = useState<Record<string, boolean>>({});
  return (
    <div className="xray">
      {meta.reasoning ? (
        <>
          <div className="xray-h">💡 reasoning</div>
          <div className="xray-reason">{meta.reasoning}</div>
        </>
      ) : null}
      {meta.trace && meta.trace.length > 0 && (
        <>
          <div className="xray-h">🔧 tools used ({meta.trace.length})</div>
          {meta.trace.map((t, i) => (
            <div key={i} className="xray-tool">
              <div className="xray-tool-sum">{t.summary}</div>
              {t.result && (
                <div className="xray-tool-res">
                  {t.result}
                  {t.result.length >= 300 ? "…" : ""}
                </div>
              )}
            </div>
          ))}
        </>
      )}
      {meta.injected && meta.injected.length > 0 && (
        <>
          <div className="xray-h">🧠 memory used ({meta.injected.length})</div>
          {meta.injected.map((m, i) => {
            const key = `${m.scope}:${m.id}`;
            if (gone[key]) return null;
            return (
              <div key={i} className="xray-mem">
                <div className="mem-inj-top">
                  <span className={`pill ${m.tier}`}>{m.tier === "stable" ? "🔒 always-on" : "↻ per-turn"}</span>
                  <span className="mem-inj-scope">{m.scope}</span>
                  {m.type === "learned" && (
                    <button
                      className="retract"
                      title="stop injecting this memory (from next turn)"
                      onClick={async () => {
                        setNote(await onRetract(m.scope, m.id));
                        setGone((g) => ({ ...g, [key]: true }));
                      }}
                    >
                      Retract
                    </button>
                  )}
                </div>
                <div className="mem-inj-text">“{m.text}”</div>
              </div>
            );
          })}
        </>
      )}
      {meta.composition && meta.composition.length > 0 && (() => {
        const parts = meta.composition!;
        const total = parts.reduce((s, p) => s + p.tokens, 0) || 1;
        return (
          <>
            <div className="xray-h">input composition (~{total}t)</div>
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
          </>
        );
      })()}
      {meta.usage && (
        <>
          <div className="xray-h">tokens</div>
          <div className="ctx-item">
            input {meta.usage.input} · cache-read {meta.usage.cacheRead} · output {meta.usage.output}
          </div>
        </>
      )}
      <div className="xray-h">was this answer right?</div>
      <div className="feedback">
        <button onClick={async () => setNote(await onFeedback("good"))}>👍 good</button>
        <button onClick={async () => setNote(await onFeedback("bad"))}>👎 off</button>
      </div>
      {note && <div className="ctx-item muted">{note}</div>}
    </div>
  );
}

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
  const [liveSteps, setLiveSteps] = useState<string[]>([]); // tool steps as they happen
  const [liveReasoning, setLiveReasoning] = useState(""); // streamed thinking
  const [liveText, setLiveText] = useState(""); // streamed answer so far
  const [xray, setXray] = useState<Record<number, boolean>>({}); // which messages are expanded

  const [files, setFiles] = useState<string[]>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [openContent, setOpenContent] = useState<string>("");
  const [recentActions, setRecentActions] = useState<string[]>([]);
  const [trace, setTrace] = useState<TraceEntry[]>([]);

  const [project, setProject] = useState("acme-health");
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [nominations, setNominations] = useState<Nomination[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [signalThreshold, setSignalThreshold] = useState(3);
  const [showQueue, setShowQueue] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [showProposals, setShowProposals] = useState(false);
  const [abstracts, setAbstracts] = useState<Record<string, { text: string; leak?: Leak }>>({});

  const [comparing, setComparing] = useState(false);
  // Ephemeral "compare retrieval" card shown inline in the thread (not persisted).
  const [inlineCompare, setInlineCompare] = useState<{ question: string; result: CompareResult } | null>(null);
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

  // Run the retrieval comparison for whatever's in the composer, inline in the thread.
  async function runCompare() {
    const q = input.trim();
    if (!q || comparing) return;
    setComparing(true);
    setInlineCompare(null);
    try {
      const d = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, project }),
      }).then((r) => r.json());
      if (!d.error) setInlineCompare({ question: q, result: d });
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
    refreshChats();
  }

  async function renameChat(meta: ChatMeta) {
    const title = window.prompt("Rename chat:", meta.title || "New chat");
    if (title == null || !title.trim()) return;
    await fetch("/api/chats/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, chatId: meta.chatId, title: title.trim() }),
    });
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

  // Turn a tool event into a friendly step line for the live view.
  function toolStepLabel(name: string, summary: string): string {
    const icon =
      name === "read_file" ? "📄" :
      name === "search_files" || name === "semantic_search" ? "🔍" :
      name === "list_files" ? "🗂️" :
      name === "write_file" ? "✍️" :
      name === "save_memory" ? "🧠" :
      name === "nominate_for_promotion" || name === "note_signal" ? "⬆️" : "🔧";
    return `${icon} ${summary}`;
  }

  async function send() {
    const text = input.trim();
    if (!text || loading || !activeChat) return;

    setMessages((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setLoading(true);
    setLiveSteps([]);
    setLiveReasoning("");
    setLiveText("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, message: text, project, openFile, recentActions, chatId: activeChat }),
      });
      if (!res.body) throw new Error("no response stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      let done = false;

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? ""; // keep the trailing partial frame
        for (const frame of frames) {
          const line = frame.replace(/^data: /, "").trim();
          if (!line) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === "thinking") {
            setLiveReasoning((r) => (r + String(ev.text)).slice(-600));
          } else if (ev.type === "tool") {
            setLiveSteps((s) => [...s, toolStepLabel(String(ev.name), String(ev.summary))]);
          } else if (ev.type === "text") {
            answer += String(ev.text);
            setLiveText(answer);
          } else if (ev.type === "done") {
            setMessages((ev.history as Message[]) ?? []);
            setTrace((ev.trace as TraceEntry[]) ?? []);
            if (ev.files) setFiles(ev.files as string[]);
            loadPromotions(); // the agent may have nominated a lesson this turn
            loadSignals(); // ...or logged a recurring signal
            loadProposals(); // ...or suggested a shared memory to approve
            refreshChats(); // the tab's title + last-activity may have changed
            noteAction(`asked "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"`);
            done = true;
          } else if (ev.type === "error") {
            setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${String(ev.error)}` }]);
            done = true;
          }
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "network error";
      setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${detail}` }]);
    } finally {
      setLoading(false);
      setLiveSteps([]);
      setLiveReasoning("");
      setLiveText("");
    }
  }

  // Correctness feedback → reinforce the learned memories behind this answer.
  // 👍/👎 on a specific answer → reinforce the LEARNED memories that informed it
  // (reinforcement keys off correctness, not usage; constitution is never nudged).
  async function feedbackForMessage(meta: MessageMeta, verdict: "good" | "bad"): Promise<string> {
    const items = (meta.injected ?? [])
      .filter((m) => m.type === "learned")
      .map((m) => ({ scope: m.scope, id: m.id, type: m.type }));
    if (items.length === 0) return "no learned memories to nudge (constitution is fixed).";
    const r = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict, items }),
    }).then((res) => res.json());
    const dir = verdict === "good" ? "↑" : "↓";
    return `${r.changed ?? 0} learned ${r.changed === 1 ? "memory" : "memories"} nudged ${dir} (constitution untouched).`;
  }

  // Contest / retract a memory so it stops being injected.
  async function retractInXray(scope: string, id: string): Promise<string> {
    await fetch("/api/memory/retract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, id }),
    });
    return `retracted ${scope} — it won't be injected next turn.`;
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
          <button className="queue-btn" onClick={() => { loadPromotions(); loadSignals(); setShowQueue(true); }}>
            ⬆ Promotions{nominations.length ? ` (${nominations.length})` : ""}
          </button>
          <button className="queue-btn" onClick={() => { loadProposals(); setShowProposals(true); }}>
            💡 Suggested{proposals.length ? ` (${proposals.length})` : ""}
          </button>
          <button className="queue-btn" onClick={() => { loadMemories(); setShowMemory(true); }}>
            🧠 Memory manager
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
            {activeChat ? (chats.find((c) => c.chatId === activeChat)?.title || "New chat") : "Chat"}
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
                  {m.role === "assistant" ? (
                    <>
                      <div className="markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </div>
                      {m.meta && (
                        <div className="xray-wrap">
                          <button className="xray-toggle" onClick={() => setXray((x) => ({ ...x, [i]: !x[i] }))}>
                            {xray[i] ? "▾ hide x-ray" : "▸ x-ray — what informed this answer"}
                          </button>
                          {xray[i] && (
                            <Xray
                              meta={m.meta}
                              onFeedback={(v) => feedbackForMessage(m.meta!, v)}
                              onRetract={retractInXray}
                            />
                          )}
                        </div>
                      )}
                    </>
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
              {inlineCompare && (
                <div className="msg assistant">
                  <div className="role">retrieval comparison</div>
                  <div className="inline-compare">
                    <div className="ic-head">
                      <span>Same question, three ways to fetch context · <b>{project}</b></span>
                      <button className="ic-x" title="dismiss" onClick={() => setInlineCompare(null)}>×</button>
                    </div>
                    <div className="ic-q">“{inlineCompare.question}”</div>
                    <div className="compare-grid">
                      {(["naive", "reranked", "agentic"] as const).map((mode) => (
                        <div key={mode} className="compare-col">
                          <div className="compare-h">
                            {mode === "naive" ? "Naïve vector" : mode === "reranked" ? "Reranked vector" : "Agentic"}
                          </div>
                          {mode !== "agentic" &&
                            inlineCompare.result[mode].chunks.map((c, i) => (
                              <div key={i} className="compare-chunk">
                                <span className="chunk-score">{c.score.toFixed(2)}</span> {c.file}
                                <div className="chunk-text">{c.text.slice(0, 130)}…</div>
                              </div>
                            ))}
                          {mode === "agentic" &&
                            inlineCompare.result.agentic.trace.map((t, i) => (
                              <div key={i} className="compare-chunk">
                                <code>{t.tool}</code> {t.summary}
                              </div>
                            ))}
                          <div className="compare-answer">{inlineCompare.result[mode].answer}</div>
                        </div>
                      ))}
                    </div>
                    <div className="hint">Agentic runs without memory, to isolate the retrieval strategy.</div>
                  </div>
                </div>
              )}
              {loading && (
                <div className="msg assistant">
                  <div className="role">agent</div>
                  <div className="live">
                    {liveReasoning && <div className="live-think">💭 {liveReasoning}</div>}
                    {liveSteps.map((s, i) => (
                      <div key={i} className="live-step">{s}</div>
                    ))}
                    {liveText ? (
                      <div className="markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{liveText}</ReactMarkdown>
                      </div>
                    ) : (
                      !liveReasoning && liveSteps.length === 0 && <span className="hint">thinking…</span>
                    )}
                  </div>
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
              <button
                className="compare-btn"
                onClick={runCompare}
                disabled={comparing || loading || !input.trim()}
                title="See how three retrieval strategies would answer this — inline, without sending it"
              >
                {comparing ? "…" : "⚖ Compare"}
              </button>
              <button onClick={send} disabled={loading || !input.trim()}>Send</button>
            </div>
          </div>
        </div>

        {/* Right: Chats — the user's conversation history (click an answer's ▸ x-ray for what informed it) */}
        <div className="panel">
          <div className="panel-header">Chats · private to {user}</div>
          <div className="panel-body">
            <button className="new-chat" onClick={newChat}>＋ New chat</button>
            {chats.length === 0 && <div className="empty">No chats yet.</div>}
            {[...chats].reverse().map((c) => (
              <div
                key={c.chatId}
                className={`chat-row ${c.chatId === activeChat ? "active" : ""}`}
                onClick={() => openChatMeta(c)}
              >
                <div className="chat-row-main">
                  <div className="chat-row-title">{c.title || "New chat"}</div>
                  {c.lastUserMessage && <div className="chat-row-sub">{c.lastUserMessage}</div>}
                </div>
                <div className="chat-row-actions">
                  <button title="rename" onClick={(e) => { e.stopPropagation(); renameChat(c); }}>✎</button>
                  {chats.length > 1 && (
                    <button title="delete" onClick={(e) => { e.stopPropagation(); closeChat(c); }}>🗑</button>
                  )}
                </div>
              </div>
            ))}
            {activeChat && (
              <button className="clear-chat" onClick={clearActiveChat}>Clear current chat</button>
            )}
          </div>
        </div>
      </div>


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
              <h2>🧠 Memory manager</h2>
              <button onClick={() => setShowMemory(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="empty">
                Every memory, grouped by where it lives on the scope lattice — broad (whole firm) at the top,
                specific (one person) at the bottom. A message&apos;s ▸ x-ray shows the subset injected that turn;
                this is where you curate the whole library. Editing here changes the file on disk.
              </div>
              {memNote && <div className="ctx-item">{memNote}</div>}
              {allMemories.length === 0 && <div className="empty">No memories yet.</div>}
              {(() => {
                // Group by lattice LEVEL (the scope's first segment), then render
                // the levels broad → specific with a labelled, divided section each.
                const LEVELS: { key: string; label: string; gloss: string }[] = [
                  { key: "company", label: "Company", gloss: "firm-wide — applies to everyone" },
                  { key: "sector", label: "Sector", gloss: "everyone working in this industry" },
                  { key: "client", label: "Client", gloss: "all of this client's projects" },
                  { key: "stakeholder", label: "Stakeholder", gloss: "one person — follows them across projects" },
                  { key: "project", label: "Project", gloss: "this engagement only" },
                  { key: "personal", label: "Personal", gloss: "just this user" },
                ];
                const byLevel = allMemories.reduce<Record<string, MemItem[]>>((acc, m) => {
                  (acc[m.scope.split("/")[0]] ||= []).push(m);
                  return acc;
                }, {});
                const known = LEVELS.map((l) => l.key);
                const extras = Object.keys(byLevel)
                  .filter((k) => !known.includes(k))
                  .map((k) => ({ key: k, label: k, gloss: "" }));
                return [...LEVELS, ...extras]
                  .filter((lvl) => byLevel[lvl.key]?.length)
                  .map((lvl) => (
                  <div key={lvl.key} className="mem-level">
                    <div className="mem-level-head">
                      <span className="mem-level-name">{lvl.label}</span>
                      <span className="mem-level-gloss">{lvl.gloss}</span>
                      <span className="mem-level-count">{byLevel[lvl.key].length}</span>
                    </div>
                    {byLevel[lvl.key].map((m) => {
                      const key = `${m.scope}:${m.id}`;
                      const d = memDraft[key] ?? { body: m.body, importance: m.importance };
                      const retracted = m.status === "retracted";
                      const isConstitution = m.type === "constitution";
                      return (
                        <div key={key} className={`mem-card ${retracted ? "retracted" : ""}`}>
                          <div className="mem-meta">
                            <span className="mem-scope">{m.scope}</span>
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
