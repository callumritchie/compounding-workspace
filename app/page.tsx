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
import { SCENARIOS, type Scenario, type ScenarioStep } from "@/lib/scenarios";

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
type User = "callum" | "bob";
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
// tools + retrieved passages, memory used (with retract), the context-window
// composition bar, and tokens (all folded in from the old glass box).
function Xray({
  meta,
  onRetract,
}: {
  meta: MessageMeta;
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
              {/* semantic_search passages get their own RAG panel below — don't repeat them here */}
              {t.result && t.tool !== "semantic_search" && (
                <div className="xray-tool-res">
                  {t.result}
                  {t.result.length >= 300 ? "…" : ""}
                </div>
              )}
            </div>
          ))}
        </>
      )}
      {/* RAG panel: make the vector-retrieval arm legible — the query, the passages
          it pulled by meaning, and how close each was in embedding space. */}
      {(() => {
        const rag = (meta.trace ?? []).filter((t) => t.tool === "semantic_search");
        if (rag.length === 0) return null;
        return (
          <>
            <div className="xray-h">📚 RAG · retrieved by meaning ({rag.length})</div>
            <div className="ctx-cap">
              Vector search embeds your question and pulls the closest passages from the corpus, then a reranker keeps the
              best — the RAG arm feeding this answer. “sim” = closeness in embedding space.
            </div>
            {rag.map((t, i) => {
              const query = String((t.input as { query?: string })?.query ?? "");
              const hits = (t.result ?? "").split("\n---\n").filter(Boolean);
              return (
                <div key={i} className="xray-rag">
                  <div className="rag-q">🔍 “{query}”</div>
                  {hits.map((h, j) => {
                    const nl = h.indexOf("\n");
                    const head = nl >= 0 ? h.slice(0, nl) : h;
                    const body = nl >= 0 ? h.slice(nl + 1) : "";
                    return (
                      <div key={j} className="rag-hit">
                        <div className="rag-hit-head">{head}</div>
                        {body && <div className="rag-hit-body">{body.slice(0, 200)}{body.length > 200 ? "…" : ""}</div>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </>
        );
      })()}
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
                      title="archive this memory — the agent stops using it (reversible in the Memory manager)"
                      onClick={async () => {
                        setNote(await onRetract(m.scope, m.id));
                        setGone((g) => ({ ...g, [key]: true }));
                      }}
                    >
                      Archive
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
        const pct = (total / CONTEXT_WINDOW) * 100;
        return (
          <>
            <div className="xray-h">📦 context window — everything the model sees this turn (~{total.toLocaleString()}t)</div>
            <div className="ctx-cap">
              Assembled fresh every turn from these parts. 🔒 parts are cached and reused cheaply; the rest is
              rebuilt each time.
            </div>
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
            <div className="ctx-item muted">
              Using ~{total.toLocaleString()} of {CONTEXT_WINDOW.toLocaleString()} tokens
              {pct < 1 ? " (well under 1%" : ` (~${pct.toFixed(pct < 10 ? 1 : 0)}%`} of the window) — lots of room to grow.
            </div>
          </>
        );
      })()}
      {meta.usage && (
        <>
          <div className="xray-h">tokens (actual, from the API)</div>
          <div className="ctx-item">
            input {meta.usage.input} · cache-read {meta.usage.cacheRead} · output {meta.usage.output}
          </div>
        </>
      )}
      {note && <div className="ctx-item muted">{note}</div>}
    </div>
  );
}

// Fixed palette so each context-window segment keeps the same colour between the
// bar and its legend.
const COMP_COLORS = ["#6366f1", "#8b5cf6", "#0ea5e9", "#f59e0b", "#10b981", "#ef4444", "#ec4899"];
// Claude Opus 4.8's context window — used to show how much of it this turn fills,
// so "context window" is a concrete size, not an abstraction.
const CONTEXT_WINDOW = 200_000;

// One chat tab's metadata (mirrors lib/workspace ChatMeta).
type ChatMeta = { chatId: string; title: string; updated: string; lastUserMessage?: string; openFile?: string | null; agentId?: string; projectId?: string };

// A project's config (mirrors lib/project ProjectConfig) — a client can have several.
type ProjectMeta = { id: string; name: string; client: string; sector: string; type: string; status: string; team?: string[]; memoryCount?: number };

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
  pinned?: boolean;
  useCount?: number;
  lastUsed?: string;
  created?: string;
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
// The "Compass": inferred engagement stage + diverse next-step suggestions + one
// optional proactive offer (mirrors NextActions in lib/agent).
type NextAction = { title: string; prompt: string; why: string };
type NextActions = { stage: { label: string; rationale: string }; actions: NextAction[]; offer: NextAction | null };
// An agent from the roster (the harness config).
type AgentItem = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  tools: string[];
};
// Library housekeeping suggestions (auto-lifecycle).
type StaleItem = { scope: string; id: string; body: string; importance: number; lastActivity: string; days: number };
type DupRef = { scope: string; id: string; body: string };
type DupPair = { a: DupRef; b: DupRef; score: number };

// Client mirror of lib/team.ts — used only to gate the UI (the API is the real
// gate). Delivery roles (lead/analyst) work inside projects; intelligence roles
// (sales/marketing) work across projects and land on the lenses.
type ClientRole = "lead" | "analyst" | "sales" | "marketing";
const CLIENT_ROLES: Record<string, ClientRole> = { callum: "lead", bob: "analyst", dana: "sales", mo: "marketing" };
const ROLE_LABELS: Record<ClientRole, string> = { lead: "Lead", analyst: "Analyst", sales: "Sales / BD", marketing: "Marketing" };
const USER_NAMES: Record<string, string> = { callum: "Callum", bob: "Bob", dana: "Dana", mo: "Mo" };
function roleLabelOf(u: string): string {
  return ROLE_LABELS[CLIENT_ROLES[u] ?? "analyst"];
}
function isDeliveryRoleClient(u: string): boolean {
  return CLIENT_ROLES[u] === "lead" || CLIENT_ROLES[u] === "analyst";
}
function canAccessFirmClient(u: string): boolean {
  return ["lead", "sales", "marketing"].includes(CLIENT_ROLES[u] ?? "analyst");
}
function canApproveScope(u: string, scope: string): boolean {
  const level = scope.split("/")[0];
  if (level === "project") return true;
  if (["stakeholder", "client", "sector", "company"].includes(level)) return CLIENT_ROLES[u] === "lead";
  return CLIENT_ROLES[u] === "lead";
}
type Leak = { flagged: boolean; hits: string[]; reasons?: string[] };

type SpaceAnswer = {
  answer: string;
  projectsUsed: { project: string; title: string; client: string; sector: string }[];
  abstracted?: boolean;
  spanned?: number;
};
type Opportunity = { title: string; kind: string; rationale: string; suggestedAction: string; projects: string[] };
type EmergentTheme = {
  insight: string;
  route: string;
  action: string;
  support: { projects: string[]; clients: string[]; sectors: string[]; count: number };
  evidence: string[];
};
type SectorDensity = { sector: string; projects: number; clients: number; cards: number; lessons: number; ready: boolean };
type ImpactStats = {
  totalReuses: number;
  distinctInsights: number;
  targetProjects: number;
  topInsights: { memoryId: string; scope: string; reuses: number; targets: number; body: string }[];
  byMonth: { month: string; reuses: number }[];
};

// Mirror of lib/engagement.ts EngagementSummary (kept local so the client bundle
// doesn't pull server-only deps). Fed by GET /api/engagement.
type EngSummary = {
  phase?: string;
  budgetPct?: number;
  budgetLabel?: string;
  endsInDays?: number | null;
  nextMilestone?: { name: string; due?: string; atRisk: boolean };
  topRisk?: { text: string; severity?: string };
};
type Signal = {
  pattern: string;
  count: number;
  lastObservation: string;
  targetScope: string;
  nominated: boolean;
};

export default function Home() {
  const [user, setUser] = useState<User>("callum");
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
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [abstracts, setAbstracts] = useState<Record<string, { text: string; leak?: Leak }>>({});

  const [uploading, setUploading] = useState(false);

  // ---- Proactive guidance ----
  // Compass: stage + next-best-actions strip above the composer. Loaded fire-and-
  // forget so it never blocks a turn; refreshed as the engagement moves.
  const [nextActions, setNextActions] = useState<NextActions | null>(null);
  const [compassDismissed, setCompassDismissed] = useState(false);
  // Engagement strip: the standing constraints (phase · budget · next milestone ·
  // top risk) shown at the top of the chat column. Loaded from /api/engagement.
  const [engagement, setEngagement] = useState<EngSummary | null>(null);
  // Navigation altitude: "home" is the hub (your engagements + the cross-project
  // lenses); "project" is inside one engagement (files · chat · history).
  const [view, setView] = useState<"home" | "project" | "space">("home");
  const [showAllProjects, setShowAllProjects] = useState(false); // leads: mine vs all
  // Lens: the active cross-project Space id (account/sector/firm), used on Home.
  const [spaces, setSpaces] = useState<{ id: string; name: string; type: string; projects: number }[]>([]);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [spaceQuery, setSpaceQuery] = useState("");
  const [spaceAudience, setSpaceAudience] = useState("consultant");
  const [spaceLoading, setSpaceLoading] = useState(false);
  const [spaceAnswer, setSpaceAnswer] = useState<SpaceAnswer | null>(null);
  const [opps, setOpps] = useState<Opportunity[] | null>(null);
  const [oppLoading, setOppLoading] = useState(false);
  const [themes, setThemes] = useState<EmergentTheme[] | null>(null);
  const [themesLoading, setThemesLoading] = useState(false);
  // Proactive Home briefing (firm-authorised roles): emergent signals to route +
  // which sectors are dense enough to pitch. Loaded once per user on landing.
  const [homeThemes, setHomeThemes] = useState<EmergentTheme[] | null>(null);
  const [homeThemesLoading, setHomeThemesLoading] = useState(false);
  const [readySectors, setReadySectors] = useState<SectorDensity[] | null>(null);
  const briefingUserRef = useRef<string | null>(null);
  // Drafted artifacts, keyed by the signal's insight text (stable across re-sorts).
  const [signalDrafts, setSignalDrafts] = useState<Record<string, { loading?: boolean; error?: string; title?: string; kind?: string; body?: string; saved?: string }>>({});
  // Bottom-right proactive popup: which items the user has dismissed this session
  // (keyed by a stable id), and whether the whole popup is collapsed.
  const [popupDismissed, setPopupDismissed] = useState<Record<string, boolean>>({});
  const [popupCollapsed, setPopupCollapsed] = useState(false);

  // ---- Warm start (cold-start activation) ----
  // On a "cold" project (no memory of its own yet) we proactively show what the
  // firm already knows + starter questions, offer a 3-question kickoff interview,
  // and surface questions a freshly-uploaded file unlocks — so the system feels
  // smart on day one instead of waiting for the user to know what to ask.
  const [kickoff, setKickoff] = useState<{ brief: string; questions: string[] } | null>(null);
  const [kickoffBusy, setKickoffBusy] = useState(false);
  const [kickoffDismissed, setKickoffDismissed] = useState(false);
  const [intakeQs, setIntakeQs] = useState<string[]>([]);
  const [showIntake, setShowIntake] = useState(false);
  const [intakeAnswers, setIntakeAnswers] = useState<Record<number, string>>({});
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [intakeDone, setIntakeDone] = useState<string[] | null>(null);
  const [uploadSuggestions, setUploadSuggestions] = useState<{ questions: string[]; gaps: string[] } | null>(null);

  const [showMemory, setShowMemory] = useState(false);
  const [memView, setMemView] = useState<"library" | "pending">("library");
  const [allMemories, setAllMemories] = useState<MemItem[]>([]);
  const [memDraft, setMemDraft] = useState<Record<string, { body: string; importance: number }>>({});
  const [memNote, setMemNote] = useState<string | null>(null);
  const [memHistory, setMemHistory] = useState<Record<string, { ts: string; actor: string | null; action: string }[]>>({});
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  // Library browse controls (find / filter / sort) — for when there are lots of memories.
  const [memSearch, setMemSearch] = useState("");
  const [memLevel, setMemLevel] = useState("all");
  const [memStatusFilter, setMemStatusFilter] = useState("all");
  const [memTypeFilter, setMemTypeFilter] = useState("all");
  const [memSort, setMemSort] = useState<"priority" | "used" | "newest">("priority");
  // At scale the library collapses each lattice level to its header; open one to
  // browse it. `showAllInLevel` lifts the per-level render cap for a given level.
  const [openLevels, setOpenLevels] = useState<Record<string, boolean>>({});
  const [showAllInLevel, setShowAllInLevel] = useState<Record<string, boolean>>({});
  const [lifecycle, setLifecycle] = useState<{ stale: StaleItem[]; duplicates: DupPair[] }>({ stale: [], duplicates: [] });
  // Guided scenario demo mode.
  const [showScenarios, setShowScenarios] = useState(false);
  const [showImpact, setShowImpact] = useState(false);
  const [impact, setImpact] = useState<ImpactStats | null>(null);
  function loadImpact() {
    fetch("/api/impact").then((r) => r.json()).then(setImpact).catch(() => setImpact(null));
  }
  const [activeScenario, setActiveScenario] = useState<Scenario | null>(null);
  const [scenarioStep, setScenarioStep] = useState(0);

  // Agent roster (the harness): the list, the tool catalogue, and the modal state.
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [allTools, setAllTools] = useState<{ name: string; description: string }[]>([]);
  const [defaultAgentId, setDefaultAgentId] = useState("consulting-teammate");
  const [showAgents, setShowAgents] = useState(false);
  const [agentDraft, setAgentDraft] = useState<AgentItem | null>(null);

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

  // Load the list of projects (for the switcher + the cold/warm signal). Called at
  // mount and again after kickoff seeds memory, so memoryCount stays current.
  function loadProjects() {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => setProjects([]));
  }
  useEffect(loadProjects, []);

  // Fetch the day-one kickoff (brief + starter questions) and intake questions for
  // the current project. `refresh` forces the brief to rebuild (after intake).
  function loadColdStart(refresh = false) {
    setKickoffBusy(true);
    fetch(`/api/kickoff?project=${project}&user=${user}${refresh ? "&refresh=1" : ""}`)
      .then((r) => r.json())
      .then((d) => setKickoff({ brief: d.brief ?? "", questions: d.questions ?? [] }))
      .catch(() => setKickoff(null))
      .finally(() => setKickoffBusy(false));
    fetch(`/api/kickoff/intake?project=${project}`)
      .then((r) => r.json())
      .then((d) => setIntakeQs(d.questions ?? []))
      .catch(() => setIntakeQs([]));
  }

  // Reset the warm-start experience whenever the project (or actor) changes.
  useEffect(() => {
    setKickoff(null);
    setKickoffDismissed(false);
    setIntakeQs([]);
    setShowIntake(false);
    setIntakeAnswers({});
    setIntakeDone(null);
    setUploadSuggestions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, user]);

  // A project is "cold" until it has memory of its own. When we land on a cold one
  // with an empty chat, proactively load its kickoff — the empty project isn't empty.
  const currentProject = projects.find((p) => p.id === project);
  const isColdProject = currentProject ? (currentProject.memoryCount ?? 0) === 0 : false;
  // Load the kickoff whenever we're on a cold project with an empty chat and haven't
  // loaded one yet. Watching messages.length + kickoff (not just project) means the
  // card reliably (re)appears when you open a fresh chat, with no re-render race.
  useEffect(() => {
    if (isColdProject && !kickoff && !kickoffBusy && messages.length === 0) loadColdStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isColdProject, project, user, messages.length, kickoff, kickoffBusy]);

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

  // Load the Compass (stage + next-best-actions + one proactive offer) for the
  // active chat. Fire-and-forget: the strip keeps showing the last set until this
  // resolves, so it never blocks. Refreshed on chat/project change, after a turn,
  // and after an upload — i.e. whenever the engagement state has moved.
  function loadNextActions() {
    if (!activeChat) return;
    fetch(`/api/next-actions?project=${project}&user=${user}&chatId=${activeChat}`)
      .then((r) => r.json())
      .then((d) => setNextActions(d?.error ? null : { stage: d.stage ?? { label: "", rationale: "" }, actions: d.actions ?? [], offer: d.offer ?? null }))
      .catch(() => {});
  }

  // Refresh the Compass whenever the engagement state has actually moved: a chat
  // is opened with content, or a turn just finished (messages.length grows). Gated
  // on !loading so it never fires mid-turn. Grounding it in messages.length is what
  // makes the strip evolve as the project progresses.
  useEffect(() => {
    if (activeChat && messages.length > 0 && !loading) loadNextActions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat, project, user, messages.length, loading]);

  // Load the engagement constraints strip for the active project. Refetch when the
  // engagement.md editor closes (openFile → null) so edits show immediately.
  useEffect(() => {
    fetch(`/api/engagement?project=${project}`)
      .then((r) => r.json())
      .then((d) => setEngagement(d.summary ?? null))
      .catch(() => setEngagement(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, openFile]);

  // Load the available lenses (spaces) once.
  useEffect(() => {
    fetch("/api/spaces").then((r) => r.json()).then((d) => setSpaces(d.spaces ?? [])).catch(() => {});
  }, []);

  // Navigation: open a project (delivery) / open a lens (intelligence) / go home.
  function openProject(id: string) {
    setProject(id);
    setSpaceId(null);
    setOpenFile(null);
    setView("project");
  }
  function openSpace(id: string) {
    setSpaceId(id);
    setSpaceAnswer(null);
    setOpps(null);
    setThemes(null);
    setView("space");
  }
  function goHome() {
    setView("home");
  }
  // Intelligence roles (sales/marketing) don't own delivery — keep them on the hub.
  useEffect(() => {
    if (!isDeliveryRoleClient(user)) setView("home");
  }, [user]);

  // The route a user personally owns — used to flag "for you" signals on Home.
  const myRoute = CLIENT_ROLES[user] === "sales" ? "sales" : CLIENT_ROLES[user] === "marketing" ? "marketing" : CLIENT_ROLES[user] === "lead" ? "leadership" : "";

  // Proactive Home briefing: for firm-authorised roles, prefetch the emergent
  // signals (slow, LLM) + sector readiness (fast) once when they land on Home.
  useEffect(() => {
    if (view !== "home" || !canAccessFirmClient(user)) return;
    if (briefingUserRef.current === user) return; // already loaded for this persona
    briefingUserRef.current = user;
    setReadySectors(null);
    setHomeThemes(null);
    setHomeThemesLoading(true);
    fetch(`/api/home/briefing?user=${user}`).then((r) => r.json()).then((d) => setReadySectors(d.sectors ?? [])).catch(() => setReadySectors([]));
    fetch(`/api/signals/emergent?user=${user}`)
      .then((r) => r.json())
      .then((d) => setHomeThemes(d.themes ?? []))
      .catch(() => setHomeThemes([]))
      .finally(() => setHomeThemesLoading(false));
  }, [view, user]);

  // Open the lens for a given sector from the briefing (fall back to firm-wide).
  function openSectorLens(sector: string) {
    const s =
      spaces.find((sp) => sp.type === "sector" && (sp.name.toLowerCase().includes(sector.toLowerCase()) || sp.id.includes(sector))) ??
      spaces.find((sp) => sp.type === "firm");
    if (s) openSpace(s.id);
  }

  // Clear the space results when switching lens.
  useEffect(() => { setSpaceAnswer(null); setOpps(null); setThemes(null); }, [spaceId]);

  // Triangulation (G): compute emergent themes — patterns weak in any one engagement
  // but strong across many. Firm-wide scan; Lead-only.
  async function runTriangulate() {
    if (themesLoading) return;
    setThemesLoading(true);
    setThemes(null);
    try {
      const d = await fetch(`/api/signals/emergent?user=${user}`).then((r) => r.json());
      if (d?.error) { setSpaceAnswer({ answer: `🔒 ${d.error}`, projectsUsed: [] }); setThemes([]); }
      else setThemes(d.themes ?? []);
    } catch {
      setThemes([]);
    } finally {
      setThemesLoading(false);
    }
  }
  async function nominateTheme(t: EmergentTheme) {
    const d = await fetch("/api/signals/nominate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ insight: t.insight, sectors: t.support.sectors, user }),
    }).then((r) => r.json());
    setMemNote(d?.ok ? `nominated to ${d.targetScope} — review in the Memory manager` : d?.error ?? "nomination failed");
  }

  // Turn a signal into its artifact in place (POV / pitch / brief / practice note).
  function draftLabel(route: string): string {
    if (route === "marketing") return "✍️ Draft POV";
    if (route === "sales") return "✍️ Draft pitch outline";
    if (route === "leadership") return "✍️ Draft brief";
    return "✍️ Draft practice note";
  }
  async function draftSignal(t: EmergentTheme) {
    const key = t.insight;
    if (signalDrafts[key]?.loading) return;
    setSignalDrafts((d) => ({ ...d, [key]: { loading: true } }));
    try {
      const r = await fetch("/api/signals/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ insight: t.insight, route: t.route, action: t.action, sectors: t.support.sectors, count: t.support.count, evidence: t.evidence, user }),
      }).then((r) => r.json());
      if (r?.error) setSignalDrafts((d) => ({ ...d, [key]: { error: r.error } }));
      else setSignalDrafts((d) => ({ ...d, [key]: { ...r.draft } }));
    } catch {
      setSignalDrafts((d) => ({ ...d, [key]: { error: "draft failed" } }));
    }
  }
  async function saveAsset(t: EmergentTheme) {
    const key = t.insight;
    const draft = signalDrafts[key];
    if (!draft?.body) return;
    const r = await fetch("/api/signals/save-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: draft.title, kind: draft.kind, body: draft.body, user }),
    }).then((r) => r.json());
    if (r?.ok) setSignalDrafts((d) => ({ ...d, [key]: { ...d[key], saved: r.path } }));
  }

  // If a user without firm access ends up on the firm-wide lens (e.g. after
  // switching to an analyst), drop them back to Home.
  useEffect(() => {
    if (spaceId && !canAccessFirmClient(user) && spaces.find((s) => s.id === spaceId)?.type === "firm") {
      setSpaceId(null);
      setView("home");
    }
  }, [user, spaceId, spaces]);

  // Proactively spot opportunities across the space's engagements (follow-on for
  // accounts; offerings / POVs / BD plays for sector & firm). Structured, not prose.
  async function spotSpaceOpportunities() {
    if (!spaceId || oppLoading) return;
    setOppLoading(true);
    setOpps(null);
    try {
      const d = await fetch("/api/space/opportunities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spaceId, user }),
      }).then((r) => r.json());
      if (d?.error) { setSpaceAnswer({ answer: `🔒 ${d.error}`, projectsUsed: [] }); setOpps([]); }
      else setOpps(d.opportunities ?? []);
    } catch {
      setOpps([]);
    } finally {
      setOppLoading(false);
    }
  }

  // Ask a cross-project question of the active space (coarse→fine→map→reduce on the
  // server). Non-streaming: it's a synthesis over many engagements, not a chat turn.
  async function runSpaceQuery() {
    if (!spaceId || !spaceQuery.trim() || spaceLoading) return;
    setSpaceLoading(true);
    setSpaceAnswer(null);
    try {
      const d = await fetch("/api/space/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spaceId, query: spaceQuery, audience: spaceAudience, user }),
      }).then((r) => r.json());
      setSpaceAnswer(d?.error ? { answer: `🔒 ${d.error}`, projectsUsed: [] } : d);
    } catch {
      setSpaceAnswer({ answer: "Something went wrong.", projectsUsed: [] });
    } finally {
      setSpaceLoading(false);
    }
  }

  // Reset the guidance surfaces when switching chat or project so stale
  // suggestions never linger and a re-dismissed strip can reappear.
  useEffect(() => {
    setNextActions(null);
    setCompassDismissed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat, project]);

  // Open the Memory manager on its Pending tab — the full workbench for the richer
  // promote / generalise flow the popup links out to.
  function openPending() {
    loadMemories();
    loadProposals();
    loadPromotions();
    loadSignals();
    loadLifecycle();
    setMemView("pending");
    setShowMemory(true);
  }

  // Load the agent roster + the tool catalogue (for the harness modal).
  function loadAgents() {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((d) => {
        setAgents(d.agents ?? []);
        setAllTools(d.allTools ?? []);
        if (d.defaultId) setDefaultAgentId(d.defaultId);
      })
      .catch(() => setAgents([]));
  }
  useEffect(loadAgents, []);

  // Point the active chat at a different agent (persists on the chat).
  async function setChatAgent(agentId: string) {
    if (!activeChat) return;
    await fetch("/api/chats/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, chatId: activeChat, agentId }),
    });
    refreshChats();
  }

  // Create or update an agent from the modal, then refresh the roster.
  async function saveAgentDraft() {
    if (!agentDraft || !agentDraft.name.trim()) return;
    const d = await fetch("/api/agents/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agentDraft }),
    }).then((r) => r.json());
    loadAgents();
    if (d.agent) setAgentDraft(d.agent);
  }
  async function deleteAgentDraft() {
    if (!agentDraft || agentDraft.id === defaultAgentId) return;
    if (!confirm(`Delete agent "${agentDraft.name}"? Chats using it fall back to the default.`)) return;
    await fetch("/api/agents/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentDraft.id }),
    });
    setAgentDraft(null);
    loadAgents();
  }

  async function approveProp(id: string) {
    const d = await fetch("/api/memory/proposals/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, user }),
    }).then((r) => r.json());
    if (d.error) { setMemNote(d.error); return; }
    loadProposals();
    loadMemories(); // the approved memory now exists in the library
  }
  async function dismissProp(id: string) {
    await fetch("/api/memory/proposals/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, user }),
    });
    loadProposals();
  }

  // Housekeeping suggestions (stale + near-duplicate memories). Embedding-based,
  // so computed lazily when the Memory manager opens.
  function loadLifecycle() {
    fetch("/api/memory/lifecycle")
      .then((r) => r.json())
      .then((d) => setLifecycle({ stale: d.stale ?? [], duplicates: d.duplicates ?? [] }))
      .catch(() => setLifecycle({ stale: [], duplicates: [] }));
  }
  async function archiveByRef(scope: string, id: string) {
    await fetch("/api/memory/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, id, status: "retracted" }),
    });
    loadMemories();
    loadLifecycle();
  }
  async function keepByRef(scope: string, id: string) {
    await fetch("/api/memory/touch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, id }),
    });
    loadLifecycle();
  }

  // ---- Guided scenarios ----
  // Apply a step's context switches (actor / project / open file / open Pending).
  function applyStepContext(step: ScenarioStep) {
    if (step.asUser && step.asUser !== user) setUser(step.asUser);
    if (step.goProject && step.goProject !== project) setProject(step.goProject);
    // Open a clean chat AFTER the project switch settles, so the proactive kickoff
    // card isn't suppressed by a previous chat's messages. Uses the target project
    // explicitly (the `project` state var is still stale this render).
    if (step.freshChat) setTimeout(() => newChatIn(step.goProject ?? project), 600);
    if (step.open) setTimeout(() => openFileFn(step.open!), 500); // after the project's files load
    if (step.openPending) {
      loadMemories();
      loadProposals();
      loadPromotions();
      loadSignals();
      loadLifecycle();
      setMemView("pending");
      setShowMemory(true);
    }
  }
  function goToScenarioStep(s: Scenario, i: number) {
    const idx = Math.max(0, Math.min(s.steps.length - 1, i));
    setScenarioStep(idx);
    applyStepContext(s.steps[idx]);
  }
  function launchScenario(s: Scenario) {
    setShowScenarios(false);
    setShowMemory(false);
    setActiveScenario(s);
    setScenarioStep(0);
    if (s.setup.asUser) setUser(s.setup.asUser);
    if (s.setup.goProject) setProject(s.setup.goProject);
    if (s.setup.open) setTimeout(() => openFileFn(s.setup.open!), 600);
    applyStepContext(s.steps[0]);
  }
  async function resetDemo() {
    await fetch("/api/demo/reset", { method: "POST" });
    loadPromotions();
    loadProposals();
    loadMemories();
    setMemNote("Demo baseline restored.");
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
      body: JSON.stringify({ scope: m.scope, id: m.id, status, user }),
    });
    setMemNote(`${status === "retracted" ? "retracted" : "restored"} ${m.scope}/${m.id}`);
    loadMemories();
  }
  // Pin / unpin: a pinned learned memory rides the always-on cached tier (it's
  // deliberately kept, and — unlike ordinary importance — never decays).
  async function setMemPinned(m: MemItem, pinned: boolean) {
    await fetch("/api/memory/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: m.scope, id: m.id, pinned, user }),
    });
    setMemNote(`${pinned ? "pinned" : "unpinned"} ${m.scope}/${m.id}`);
    loadMemories();
  }
  // Show (or hide) a memory's audit trail — who changed it, when.
  async function toggleHistory(m: MemItem) {
    const key = `${m.scope}/${m.id}`;
    if (openHistory === key) { setOpenHistory(null); return; }
    setOpenHistory(key);
    if (!memHistory[key]) {
      const d = await fetch(`/api/memory/history?scope=${encodeURIComponent(m.scope)}&id=${encodeURIComponent(m.id)}`)
        .then((r) => r.json())
        .catch(() => ({ history: [] }));
      setMemHistory((h) => ({ ...h, [key]: d.history ?? [] }));
    }
  }
  // Outcome loop (C3): mark whether a memory's guidance actually worked. Importance
  // moves on correctness, not usage.
  async function setMemOutcome(m: MemItem, worked: boolean) {
    await fetch("/api/memory/outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: m.scope, id: m.id, worked, user }),
    });
    setMemNote(`${worked ? "reinforced (worked)" : "downweighted (didn't work)"} ${m.scope}/${m.id}`);
    loadMemories();
  }
  // Run memory maintenance (decay untouched learned memory) when the manager opens.
  function runMaintain() {
    fetch("/api/memory/maintain", { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        if ((d?.decayed ?? 0) + (d?.archived ?? 0) > 0) setMemNote(`maintenance: decayed ${d.decayed}, archived ${d.archived}`);
        loadMemories();
        loadLifecycle();
      })
      .catch(() => {});
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

  async function doPromote(id: string, acknowledgedLeak = false) {
    const text = abstracts[id]?.text ?? nominations.find((n) => n.id === id)?.fact ?? "";
    const d = await fetch("/api/promotions/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, text, user, acknowledgedLeak }),
    }).then((r) => r.json());
    // Confidentiality gate: the server blocked this because the final text still
    // looks like it could identify the client. Make the reviewer confirm explicitly.
    if (d.needsAck && !acknowledgedLeak) {
      const detail = [...(d.hits ?? []), ...(d.reasons ?? [])].filter(Boolean).join("; ");
      if (confirm(`This still looks like it could identify the client${detail ? `:\n\n${detail}` : ""}.\n\nPromote to the shared scope anyway?`)) {
        return doPromote(id, true);
      }
      setMemNote("promotion blocked — client detail present");
      return;
    }
    if (d.error) { setMemNote(d.error); return; }
    if (d.ok) { setNominations((ns) => ns.filter((n) => n.id !== id)); loadMemories(); }
  }

  async function doReject(id: string) {
    const d = await fetch("/api/promotions/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, user }),
    }).then((r) => r.json());
    if (d.error) { setMemNote(d.error); return; }
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
    const list: ChatMeta[] = await fetch(`/api/chats?user=${user}&project=${project}`)
      .then((r) => r.json())
      .then((d) => d.chats ?? [])
      .catch(() => []);
    setChats(list);
    return list;
  }

  async function newChat() {
    return newChatIn(project);
  }

  // Create + open a fresh (empty) chat in a specific project. Taking the project
  // explicitly matters for the guided scenario, which switches project and opens a
  // clean chat in the same step — the `project` state var would still be stale then.
  async function newChatIn(projectId: string) {
    const created = await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, project: projectId }),
    }).then((r) => r.json());
    if (created.chat) {
      const list: ChatMeta[] = await fetch(`/api/chats?user=${user}&project=${projectId}`)
        .then((r) => r.json())
        .then((d) => d.chats ?? [])
        .catch(() => []);
      setChats(list);
      openChatMeta(created.chat); // empty history → messages=[] → the kickoff card can show
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
        body: JSON.stringify({ user, project }),
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

  // On user OR project switch: load that user's tabs IN this project (create one
  // if none), and open the most recent. This is what makes chat history feel
  // project-specific — each engagement has its own conversation list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let list: ChatMeta[] = await fetch(`/api/chats?user=${user}&project=${project}`)
        .then((r) => r.json())
        .then((d) => d.chats ?? [])
        .catch(() => []);
      if (cancelled) return; // a superseded run (e.g. StrictMode double-mount) must not create a tab
      if (list.length === 0) {
        const created = await fetch("/api/chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user, project }),
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
  }, [user, project]);

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
      // Turn the upload into momentum: show what this file now lets you ask.
      const sug = d.suggestions as { questions?: string[]; gaps?: string[] } | undefined;
      if (sug && ((sug.questions?.length ?? 0) > 0 || (sug.gaps?.length ?? 0) > 0)) {
        setUploadSuggestions({ questions: sug.questions ?? [], gaps: sug.gaps ?? [] });
      }
      loadNextActions(); // a new file moves the engagement — refresh the guidance
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  // Submit the guided kickoff interview: the answers are distilled into provisional
  // project memory (no approval step), then the brief is refreshed so it visibly
  // reflects what you just told it — the "it got smarter" beat.
  async function submitIntake() {
    const answers = intakeQs.map((question, i) => ({ question, answer: intakeAnswers[i] ?? "" }));
    if (!answers.some((a) => a.answer.trim())) return;
    setIntakeBusy(true);
    try {
      const d = await fetch("/api/kickoff/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, user, answers }),
      }).then((r) => r.json());
      setIntakeDone((d.facts as string[]) ?? []);
      setShowIntake(false);
      loadProjects(); // memoryCount changes → project is no longer cold
      loadColdStart(true); // rebuild the brief so it now includes the captured facts
    } finally {
      setIntakeBusy(false);
    }
  }

  // Click-to-send a suggested/starter question.
  function askSuggested(q: string) {
    setUploadSuggestions(null);
    sendText(q);
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

  function send() {
    return sendText(input);
  }

  async function sendText(raw: string) {
    const text = raw.trim();
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

  // Archive a memory (contest it) so the agent stops using it.
  async function retractInXray(scope: string, id: string): Promise<string> {
    await fetch("/api/memory/retract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, id }),
    });
    return `archived ${scope} — the agent won't use it next turn (restore it in the Memory manager).`;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // The cross-project lens screen (an "intelligence" altitude, not inside a project).
  const activeSpace = spaces.find((s) => s.id === spaceId);
  function renderSpaceView() {
    return (
      <div className="space-screen">
        <div className="space-view">
          <div className="space-head">
            <span className="space-title">🔭 {activeSpace?.name}</span>
            <span className="space-sub">
              querying across {activeSpace?.projects ?? 0} engagements
              {(spaceAnswer?.abstracted ?? activeSpace?.type !== "account") && (
                <span className="space-abstract" title="spans multiple clients — answers are de-identified">🛡 de-identified</span>
              )}
            </span>
          </div>
          <div className="space-ask">
            <textarea
              value={spaceQuery}
              onChange={(e) => setSpaceQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runSpaceQuery(); } }}
              placeholder="Ask across these engagements… e.g. 'Where does convenience-driven pricing let us down, and what should we pitch instead?'"
            />
            <div className="space-ask-row">
              <label className="space-audience">
                for
                <select value={spaceAudience} onChange={(e) => setSpaceAudience(e.target.value)}>
                  <option value="consultant">delivery</option>
                  <option value="sales">sales / BD</option>
                  <option value="marketing">marketing</option>
                  <option value="leadership">leadership</option>
                </select>
              </label>
              <div className="space-ask-btns">
                {activeSpace?.type === "firm" && (
                  <button className="mini" onClick={runTriangulate} disabled={themesLoading} title="find emergent themes — weak in one engagement, strong across many">
                    {themesLoading ? "Triangulating…" : "🔺 Triangulate"}
                  </button>
                )}
                <button className="mini" onClick={spotSpaceOpportunities} disabled={oppLoading} title="proactively surface follow-on / offering / BD opportunities">
                  {oppLoading ? "Spotting…" : "✨ Spot opportunities"}
                </button>
                <button onClick={runSpaceQuery} disabled={spaceLoading || !spaceQuery.trim()}>
                  {spaceLoading ? "Synthesising…" : "Ask across projects"}
                </button>
              </div>
            </div>
          </div>
          {opps && (
            <div className="space-opps">
              {opps.length === 0 ? (
                <div className="hint">No clear opportunities surfaced.</div>
              ) : (
                opps.map((o, i) => (
                  <div key={i} className="opp-card">
                    <div className="opp-head">
                      <span className={`opp-kind opp-${o.kind}`}>{o.kind}</span>
                      <span className="opp-title">{o.title}</span>
                    </div>
                    <div className="opp-why">{o.rationale}</div>
                    <div className="opp-action">→ {o.suggestedAction}</div>
                    {o.projects.length > 0 && (
                      <div className="opp-prov">{o.projects.map((p, j) => <span key={j} className="space-prov-chip">{p}</span>)}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
          {themes && (
            <div className="space-themes">
              <div className="themes-head">🔺 Emergent signals — patterns weak in one engagement, strong across many</div>
              {themes.length === 0 ? (
                <div className="hint">No theme yet spans enough engagements to be emergent.</div>
              ) : (
                themes.map((t, i) => (
                  <div key={i} className="theme-card">
                    <div className="theme-top">
                      <span className={`opp-kind route-${t.route}`}>{t.route}</span>
                      <span className="theme-count">{t.support.count} engagements · {t.support.sectors.length} sector{t.support.sectors.length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="theme-insight">{t.insight}</div>
                    <div className="opp-action">→ {t.action}</div>
                    <div className="theme-foot">
                      <span className="theme-sectors">{t.support.sectors.join(" · ")}</span>
                      <button className="mini" onClick={() => nominateTheme(t)} title="propose as firm knowledge (enters the review pipeline)">
                        Nominate to firm memory
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
          {spaceLoading && <div className="hint">coarse → fine → extract per engagement → synthesise…</div>}
          {spaceAnswer && (
            <div className="space-answer">
              <div className="markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{spaceAnswer.answer}</ReactMarkdown>
              </div>
              {spaceAnswer.projectsUsed.length > 0 && (
                <div className="space-provenance">
                  <span className="space-prov-label">Drawn from {spaceAnswer.projectsUsed.length} engagements:</span>
                  {spaceAnswer.projectsUsed.map((p) => (
                    <span key={p.project} className="space-prov-chip" title={`${p.client} · ${p.sector}`}>
                      {p.title}{p.client !== "(withheld)" ? ` · ${p.client}` : ""}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Home: which engagements are "yours" (team membership), split by status.
  const myProjects = projects.filter((p) => showAllProjects || (p.team ?? []).includes(user));
  const activeProjects = myProjects.filter((p) => p.status !== "complete");
  const completedProjects = myProjects.filter((p) => p.status === "complete");
  const visibleLenses = spaces.filter((s) => s.type !== "firm" || canAccessFirmClient(user));

  return (
    <div className="app">
      {/* ---- Top bar ---- */}
      <div className="topbar">
        <h1 className="home-link" onClick={goHome} title="back to Home">
          Compounding Workspace
          <span className="subtitle">context engineering, made visible</span>
        </h1>
        {view !== "home" && (
          <span className="crumb">
            <button className="crumb-home" onClick={goHome}>‹ Home</button>
            <span className="crumb-sep">/</span>
            <span className="crumb-proj">
              {view === "project"
                ? projects.find((p) => p.id === project)?.name ?? project
                : `🔭 ${activeSpace?.name ?? "Lens"}`}
            </span>
          </span>
        )}
        <div className="topbar-right">
          {view === "project" && (
            <>
              <button className="queue-btn scenarios-btn" onClick={() => setShowScenarios(true)}>✨ Scenarios</button>
              <button className="queue-btn" onClick={() => { loadAgents(); setShowAgents(true); }}>🤖 Agents</button>
            </>
          )}
          <button
            className="queue-btn"
            onClick={() => { loadMemories(); loadProposals(); loadPromotions(); loadSignals(); loadLifecycle(); runMaintain(); setShowMemory(true); }}
          >
            🧠 Memory{proposals.length + nominations.length ? ` (${proposals.length + nominations.length})` : ""}
          </button>
          <button className="queue-btn" onClick={() => { loadImpact(); setShowImpact(true); }} title="how much firm knowledge is being reused across engagements">
            📈 Impact
          </button>
          <div className="user-switch">
            <span className="subtitle">You are:</span>
            <select className="user-select" value={user} onChange={(e) => setUser(e.target.value as User)} title="switch persona">
              {(["callum", "bob", "dana", "mo"] as const).map((u) => (
                <option key={u} value={u}>{USER_NAMES[u]} · {roleLabelOf(u)}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ---- Home hub: your engagements + the cross-project lenses ---- */}
      {view === "home" && (
        <div className="home">
          <div className="home-hero">
            <div>
              <h2>Home</h2>
              <span className="home-role">{USER_NAMES[user]} · {roleLabelOf(user)}</span>
            </div>
          </div>

          {isDeliveryRoleClient(user) && (
            <section className="home-section">
              <div className="home-section-head">
                <h3>Your engagements</h3>
                {CLIENT_ROLES[user] === "lead" && (
                  <label className="home-toggle">
                    <input type="checkbox" checked={showAllProjects} onChange={(e) => setShowAllProjects(e.target.checked)} /> show all firm engagements
                  </label>
                )}
              </div>
              {myProjects.length === 0 ? (
                <div className="empty">No engagements assigned to you yet.</div>
              ) : (
                <>
                  {activeProjects.length > 0 && <div className="home-group-label">Active</div>}
                  <div className="proj-grid">
                    {activeProjects.map((p) => (
                      <button key={p.id} className="proj-card" onClick={() => openProject(p.id)}>
                        <div className="proj-card-top">
                          <span className="proj-card-name">{p.name}</span>
                          <span className="proj-card-status active">● active</span>
                        </div>
                        <div className="proj-card-meta">{p.client} · {p.sector} · {p.type}</div>
                      </button>
                    ))}
                  </div>
                  {completedProjects.length > 0 && <div className="home-group-label">Completed</div>}
                  <div className="proj-grid">
                    {completedProjects.map((p) => (
                      <button key={p.id} className="proj-card done" onClick={() => openProject(p.id)}>
                        <div className="proj-card-top">
                          <span className="proj-card-name">{p.name}</span>
                          <span className="proj-card-status done">✓ complete</span>
                        </div>
                        <div className="proj-card-meta">{p.client} · {p.sector} · {p.type}</div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {canAccessFirmClient(user) && (
            <section className="home-section home-briefing">
              <div className="home-section-head">
                <h3>🔔 Your briefing</h3>
                <span className="home-role">signals surfaced across the firm — no query needed</span>
              </div>
              {readySectors && readySectors.some((s) => s.ready) && (
                <div className="ready-row">
                  {readySectors.filter((s) => s.ready).map((s) => (
                    <button key={s.sector} className="ready-card" onClick={() => openSectorLens(s.sector)} title="open this sector lens">
                      <span className="ready-sector">🟢 {s.sector.replace(/-/g, " ")}</span>
                      <span className="ready-meta">{s.clients} clients · {s.cards} engagements · ready to pitch</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="briefing-signals">
                {homeThemesLoading && <div className="hint">scanning the firm&apos;s work for emergent signals…</div>}
                {!homeThemesLoading && homeThemes && homeThemes.length === 0 && (
                  <div className="hint">No emergent signal yet spans enough engagements.</div>
                )}
                {memNote && <div className="hint briefing-note">{memNote}</div>}
                {(homeThemes ?? [])
                  .slice()
                  .sort((a, b) => (b.route === myRoute ? 1 : 0) - (a.route === myRoute ? 1 : 0))
                  .map((t, i) => (
                    <div key={i} className={`theme-card ${t.route === myRoute ? "mine" : ""}`}>
                      <div className="theme-top">
                        <span className={`opp-kind route-${t.route}`}>{t.route}</span>
                        {t.route === myRoute && <span className="for-you">for you</span>}
                        <span className="theme-count">{t.support.count} engagements · {t.support.sectors.length} sector{t.support.sectors.length === 1 ? "" : "s"}</span>
                      </div>
                      <div className="theme-insight">{t.insight}</div>
                      <div className="opp-action">→ {t.action}</div>
                      <div className="theme-foot">
                        <span className="theme-sectors">{t.support.sectors.join(" · ")}</span>
                        <div className="theme-actions">
                          <button className="mini primary" onClick={() => draftSignal(t)} disabled={signalDrafts[t.insight]?.loading} title="draft the artifact from this signal, in place">
                            {signalDrafts[t.insight]?.loading ? "Drafting…" : draftLabel(t.route)}
                          </button>
                          <button className="mini" onClick={() => nominateTheme(t)} title="propose as firm knowledge (enters the review pipeline)">
                            Nominate
                          </button>
                        </div>
                      </div>
                      {signalDrafts[t.insight] && !signalDrafts[t.insight].loading && (
                        <div className="signal-draft">
                          {signalDrafts[t.insight].error ? (
                            <div className="hint">⚠️ {signalDrafts[t.insight].error}</div>
                          ) : (
                            <>
                              <div className="signal-draft-head">
                                <span className="signal-draft-kind">{signalDrafts[t.insight].kind}</span>
                                <span className="signal-draft-title">{signalDrafts[t.insight].title}</span>
                                <div className="signal-draft-btns">
                                  <button className="mini" onClick={() => navigator.clipboard?.writeText(signalDrafts[t.insight].body ?? "")}>Copy</button>
                                  <button className="mini" onClick={() => saveAsset(t)} disabled={!!signalDrafts[t.insight].saved}>
                                    {signalDrafts[t.insight].saved ? "Saved ✓" : "Save to library"}
                                  </button>
                                </div>
                              </div>
                              <div className="markdown signal-draft-body">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{signalDrafts[t.insight].body ?? ""}</ReactMarkdown>
                              </div>
                              {signalDrafts[t.insight].saved && <div className="hint">saved to workspace/{signalDrafts[t.insight].saved}</div>}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </section>
          )}

          <section className="home-section">
            <div className="home-section-head">
              <h3>{isDeliveryRoleClient(user) ? "Across your work" : "Your workspace — across engagements"}</h3>
            </div>
            <p className="home-hint">
              Query, spot opportunities, and triangulate signals across many engagements. Answers are de-identified where client data is combined.
            </p>
            <div className="lens-grid">
              {visibleLenses.map((s) => (
                <button key={s.id} className={`lens-card lens-${s.type}`} onClick={() => openSpace(s.id)}>
                  <span className="lens-icon">{s.type === "account" ? "🏢" : s.type === "sector" ? "🌐" : "🏛"}</span>
                  <span className="lens-name">{s.name}</span>
                  <span className="lens-meta">{s.type} · {s.projects} engagements</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* ---- Cross-project lens screen (intelligence altitude) ---- */}
      {view === "space" && renderSpaceView()}

      {/* ---- Project workspace: three panels ---- */}
      {view === "project" && (
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
            {activeChat && agents.length > 0 && (
              <span className="agent-pick" title="which agent answers in this chat">
                🤖
                <select
                  value={chats.find((c) => c.chatId === activeChat)?.agentId ?? defaultAgentId}
                  onChange={(e) => setChatAgent(e.target.value)}
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </span>
            )}
          </div>
          <div className="chat">
            {/* Engagement strip: the standing constraints frame, always visible.
                Click to open engagement.md and edit the underlying constraints. */}
            {engagement && (
              <button
                className="engagement-strip"
                title="Open the engagement brief (SOW, budget, timeline, scope, risks)"
                onClick={() => openFileFn("engagement.md")}
              >
                <span className="eng-tag">📋 Engagement</span>
                {engagement.phase && <span className="eng-item">{engagement.phase}</span>}
                {engagement.budgetLabel && (
                  <span className={`eng-item${(engagement.budgetPct ?? 0) >= 80 ? " eng-warn" : ""}`}>{engagement.budgetLabel}</span>
                )}
                {engagement.nextMilestone && (
                  <span className={`eng-item${engagement.nextMilestone.atRisk ? " eng-risk" : ""}`}>
                    {engagement.nextMilestone.atRisk ? "⚠ " : "→ "}
                    {engagement.nextMilestone.name}
                    {engagement.nextMilestone.due ? ` (${engagement.nextMilestone.due})` : ""}
                  </span>
                )}
                {engagement.topRisk && (
                  <span className="eng-item eng-risk" title={engagement.topRisk.text}>
                    ⚠ {engagement.topRisk.text.length > 46 ? engagement.topRisk.text.slice(0, 46) + "…" : engagement.topRisk.text}
                  </span>
                )}
              </button>
            )}
            <div className="messages">
              {/* Warm start: on a cold project, proactively show what we already know
                  + starter questions + an optional 3-question kickoff interview. */}
              {kickoff && !kickoffDismissed && messages.length === 0 && (
                <div className="kickoff">
                  <div className="kickoff-head">
                    <span>👋 Starting on {currentProject?.name || project} — here’s what we already know</span>
                    <button className="ic-x" title="dismiss" onClick={() => setKickoffDismissed(true)}>×</button>
                  </div>
                  {kickoffBusy && !kickoff.brief ? (
                    <div className="hint">Gathering what the firm already knows…</div>
                  ) : (
                    <div className="kickoff-brief markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{kickoff.brief || "_No inherited knowledge yet — the interview below is a great place to start._"}</ReactMarkdown>
                    </div>
                  )}
                  {kickoff.questions.length > 0 && (
                    <div className="kickoff-qs">
                      <div className="kickoff-label">Ask to get going:</div>
                      {kickoff.questions.map((q, i) => (
                        <button key={i} className="guide-send" disabled={loading || !activeChat} onClick={() => askSuggested(q)}>
                          ▸ {q}
                        </button>
                      ))}
                    </div>
                  )}
                  {intakeDone ? (
                    <div className="kickoff-done">
                      ✓ Captured {intakeDone.length} {intakeDone.length === 1 ? "fact" : "facts"} — I’ll remember these (they’ll firm up as we use them).
                    </div>
                  ) : intakeQs.length > 0 && (
                    showIntake ? (
                      <div className="intake">
                        <div className="kickoff-label">A few quick questions make every answer sharper:</div>
                        {intakeQs.map((q, i) => (
                          <label key={i} className="intake-q">
                            <span>{q}</span>
                            <textarea
                              rows={2}
                              value={intakeAnswers[i] ?? ""}
                              onChange={(e) => setIntakeAnswers((a) => ({ ...a, [i]: e.target.value }))}
                              placeholder="Optional — skip any you’re unsure about"
                            />
                          </label>
                        ))}
                        <div className="intake-actions">
                          <button className="guide-send" disabled={intakeBusy} onClick={submitIntake}>
                            {intakeBusy ? "Saving…" : "Save these"}
                          </button>
                          <button className="ghost" disabled={intakeBusy} onClick={() => setShowIntake(false)}>Skip</button>
                        </div>
                      </div>
                    ) : (
                      <button className="intake-open ghost" onClick={() => setShowIntake(true)}>
                        ＋ Answer 3 quick questions to make this sharper
                      </button>
                    )
                  )}
                </div>
              )}
              {/* A just-uploaded file unlocks new questions. */}
              {uploadSuggestions && (
                <div className="kickoff upload-sug">
                  <div className="kickoff-head">
                    <span>📎 From the file you just added</span>
                    <button className="ic-x" title="dismiss" onClick={() => setUploadSuggestions(null)}>×</button>
                  </div>
                  {uploadSuggestions.questions.length > 0 && (
                    <div className="kickoff-qs">
                      <div className="kickoff-label">You can now ask:</div>
                      {uploadSuggestions.questions.map((q, i) => (
                        <button key={i} className="guide-send" disabled={loading || !activeChat} onClick={() => askSuggested(q)}>
                          ▸ {q}
                        </button>
                      ))}
                    </div>
                  )}
                  {uploadSuggestions.gaps.length > 0 && (
                    <div className="kickoff-gaps hint">Notably not covered: {uploadSuggestions.gaps.join("; ")}.</div>
                  )}
                </div>
              )}
              {messages.length === 0 && !(kickoff && !kickoffDismissed) && (
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
                            <Xray meta={m.meta} onRetract={retractInXray} />
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
                        {!personal && (() => {
                          const prop = proposals.find((p) => p.fact === fact);
                          if (!prop) return <span className="chip-done">reviewed ✓</span>;
                          return (
                            <span className="chip-actions">
                              {canApproveScope(user, prop.scope) ? (
                                <button onClick={() => approveProp(prop.id)}>Accept</button>
                              ) : (
                                <span className="chip-done">🔒 needs a Lead</span>
                              )}
                              <button className="ghost" onClick={() => dismissProp(prop.id)}>Decline</button>
                            </span>
                          );
                        })()}
                      </div>
                    );
                  })}
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
            {/* Compass: always-on, stage-aware next-best-actions. Shown once a chat
                is underway (the empty state keeps the kickoff card). Plural + diverse
                + each grounded in a "why" — guidance without funnelling. Collapsing
                it leaves a slim pill so it can always be brought back. */}
            {nextActions && messages.length > 0 && nextActions.actions.length > 0 && (
              compassDismissed ? (
                <button className="compass-reopen" onClick={() => setCompassDismissed(false)}>
                  💡 Suggested next steps{nextActions.stage.label ? ` · ${nextActions.stage.label}` : ""} ▸
                </button>
              ) : (
                <div className="compass">
                  <div className="compass-head">
                    {nextActions.stage.label && (
                      <span className="compass-stage" title={nextActions.stage.rationale}>
                        📍 {nextActions.stage.label}
                      </span>
                    )}
                    <span className="compass-label">Suggested next steps</span>
                    <button className="ic-x" title="collapse (click the pill to bring it back)" onClick={() => setCompassDismissed(true)}>×</button>
                  </div>
                  <div className="compass-chips">
                    {nextActions.actions.map((a, i) => (
                      <button
                        key={i}
                        className="guide-send compass-chip"
                        disabled={loading || !activeChat}
                        title={a.why ? `Why: ${a.why}` : undefined}
                        onClick={() => sendText(a.prompt)}
                      >
                        ▸ {a.title}
                      </button>
                    ))}
                  </div>
                </div>
              )
            )}
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

        {/* Right: Chats — the user's conversation history (click an answer's ▸ x-ray for what informed it) */}
        <div className="panel">
          <div className="panel-header">
            Chats · {user} · <span className="hdr-project">{projects.find((p) => p.id === project)?.name ?? project}</span>
          </div>
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
      )}

      {/* ---- Proactive popup (bottom-right): the agent initiates ----
          Surfaces things that need the user — pending approvals (today buried in
          the Memory manager) + at most ONE proactive offer. A corner toast: it
          never interrupts typing, and every item is dismissible. */}
      {(() => {
        const offer = nextActions?.offer ?? null;
        const offerId = offer ? `offer:${offer.title}` : "";
        const showOffer = !!offer && !popupDismissed[offerId];
        const props = proposals.filter((p) => !popupDismissed[p.id]);
        const noms = nominations.filter((n) => !popupDismissed[n.id]);
        const count = (showOffer ? 1 : 0) + props.length + noms.length;
        // Hide during a guided scenario — the scenario guide owns the bottom-right —
        // and off the Home/lens screens (the popup is delivery, project-scoped).
        if (count === 0 || activeScenario || view !== "project") return null;
        return (
          <div className="nudge">
            <div className="nudge-head">
              <span>🔔 The agent has {count} {count === 1 ? "thing" : "things"} for you</span>
              <button className="ic-x" title={popupCollapsed ? "expand" : "collapse"} onClick={() => setPopupCollapsed((c) => !c)}>
                {popupCollapsed ? "▸" : "▾"}
              </button>
            </div>
            {!popupCollapsed && (
              <div className="nudge-body">
                {showOffer && offer && (
                  <div className="nudge-item offer">
                    <div className="nudge-kind">💡 I can do this now</div>
                    <div className="nudge-title">{offer.title}</div>
                    {offer.why && <div className="nudge-why">{offer.why}</div>}
                    <div className="nudge-actions">
                      <button
                        className="promote"
                        disabled={loading || !activeChat}
                        onClick={() => { setPopupDismissed((s) => ({ ...s, [offerId]: true })); sendText(offer.prompt); }}
                      >
                        Do it
                      </button>
                      <button className="ghost" onClick={() => setPopupDismissed((s) => ({ ...s, [offerId]: true }))}>Not now</button>
                    </div>
                  </div>
                )}
                {props.map((p) => (
                  <div key={p.id} className="nudge-item">
                    <div className="nudge-kind">💡 Save to the team’s memory?</div>
                    <div className="nudge-title">“{p.fact}”</div>
                    <div className="nudge-why">{p.scope} · suggested by {p.proposedBy}</div>
                    <div className="nudge-actions">
                      {canApproveScope(user, p.scope) ? (
                        <button className="promote" onClick={() => { approveProp(p.id); setPopupDismissed((s) => ({ ...s, [p.id]: true })); }}>Approve</button>
                      ) : (
                        <span className="lock-note">🔒 needs a Lead</span>
                      )}
                      <button className="ghost" onClick={() => { dismissProp(p.id); setPopupDismissed((s) => ({ ...s, [p.id]: true })); }}>Dismiss</button>
                    </div>
                  </div>
                ))}
                {noms.map((n) => (
                  <div key={n.id} className="nudge-item">
                    <div className="nudge-kind">⬆ Promote a lesson?</div>
                    <div className="nudge-title">“{n.fact}”</div>
                    <div className="nudge-why">to {n.targetScope} · needs generalising first</div>
                    <div className="nudge-actions">
                      <button className="promote" onClick={openPending}>Review</button>
                      <button className="ghost" onClick={() => setPopupDismissed((s) => ({ ...s, [n.id]: true }))}>Later</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}


      {/* ---- Guided scenarios: launcher + running guide panel ---- */}
      {showScenarios && (
        <div className="modal-overlay" onClick={() => setShowScenarios(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>✨ Scenarios · see it in action</h2>
              <button onClick={() => setShowScenarios(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="empty">
                Pick a short, guided walk-through. Each one sets the scene (who you are, which project) and
                narrates what to watch. Run <b>Reset demo</b> anytime to restore the starting point.
              </div>
              {SCENARIOS.map((s) => (
                <div key={s.id} className="scenario-row" onClick={() => launchScenario(s)}>
                  <div className="scenario-row-title">{s.title}</div>
                  <div className="scenario-row-blurb">{s.blurb}</div>
                </div>
              ))}
              <button className="clear-chat" onClick={resetDemo}>↺ Reset demo baseline</button>
            </div>
          </div>
        </div>
      )}

      {activeScenario && (() => {
        const step = activeScenario.steps[scenarioStep];
        const last = scenarioStep === activeScenario.steps.length - 1;
        return (
          <div className="guide">
            <div className="guide-head">
              <span className="guide-title">✨ {activeScenario.title}</span>
              <button className="guide-x" title="end walk-through" onClick={() => setActiveScenario(null)}>×</button>
            </div>
            <div className="guide-step">Step {scenarioStep + 1} of {activeScenario.steps.length}</div>
            <div className="guide-say">{step.say}</div>
            {step.prompt && (
              <button className="guide-send" disabled={loading || !activeChat} onClick={() => sendText(step.prompt!)}>
                ▸ Send: “{step.prompt.length > 60 ? step.prompt.slice(0, 60) + "…" : step.prompt}”
              </button>
            )}
            {step.watch && <div className="guide-watch">👀 {step.watch}</div>}
            <div className="guide-nav">
              <button disabled={scenarioStep === 0} onClick={() => goToScenarioStep(activeScenario, scenarioStep - 1)}>← Back</button>
              {last ? (
                <button className="primary" onClick={() => setActiveScenario(null)}>Done</button>
              ) : (
                <button className="primary" onClick={() => goToScenarioStep(activeScenario, scenarioStep + 1)}>Next →</button>
              )}
            </div>
          </div>
        );
      })()}

      {/* ---- Memory manager (modal) ---- */}
      {showAgents && (
        <div className="modal-overlay" onClick={() => setShowAgents(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>🤖 Agents · the harness</h2>
              <button onClick={() => setShowAgents(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="empty">
                An agent is a <b>system prompt + model + tools</b>. Memory (the scope lattice) and your working
                context are wired into every agent the same way; the loop is always think → call tools → answer.
                Pick a chat’s agent from the 🤖 menu in the chat header.
              </div>
              <div className="agents-layout">
                <div className="agents-list">
                  {agents.map((a) => (
                    <div
                      key={a.id}
                      className={`agent-row ${agentDraft?.id === a.id ? "active" : ""}`}
                      onClick={() => setAgentDraft({ ...a })}
                    >
                      <div className="agent-row-name">
                        {a.name}
                        {a.id === defaultAgentId && <span className="tag">default</span>}
                      </div>
                      <div className="agent-row-desc">{a.description}</div>
                    </div>
                  ))}
                  <button
                    className="new-chat"
                    onClick={() =>
                      setAgentDraft({
                        id: "",
                        name: "",
                        description: "",
                        systemPrompt: "",
                        model: "claude-opus-4-8",
                        tools: allTools.map((t) => t.name),
                      })
                    }
                  >
                    ＋ New agent
                  </button>
                </div>
                <div className="agent-editor">
                  {!agentDraft ? (
                    <div className="empty">Select an agent to view or edit its harness.</div>
                  ) : (
                    <>
                      <label className="fld">
                        Name
                        <input value={agentDraft.name} onChange={(e) => setAgentDraft({ ...agentDraft, name: e.target.value })} />
                      </label>
                      <label className="fld">
                        Description
                        <input value={agentDraft.description} onChange={(e) => setAgentDraft({ ...agentDraft, description: e.target.value })} />
                      </label>
                      <label className="fld">
                        Model
                        <select value={agentDraft.model} onChange={(e) => setAgentDraft({ ...agentDraft, model: e.target.value })}>
                          <option value="claude-opus-4-8">claude-opus-4-8</option>
                          <option value="claude-sonnet-5">claude-sonnet-5</option>
                          <option value="claude-haiku-4-5">claude-haiku-4-5</option>
                        </select>
                      </label>
                      <label className="fld">
                        System prompt
                        <textarea
                          className="agent-prompt"
                          value={agentDraft.systemPrompt}
                          onChange={(e) => setAgentDraft({ ...agentDraft, systemPrompt: e.target.value })}
                        />
                      </label>
                      <div className="fld">
                        Tools this agent may call
                        <div className="tool-checks">
                          {allTools.map((t) => (
                            <label key={t.name} className="tool-check" title={t.description}>
                              <input
                                type="checkbox"
                                checked={agentDraft.tools.includes(t.name)}
                                onChange={(e) =>
                                  setAgentDraft({
                                    ...agentDraft,
                                    tools: e.target.checked
                                      ? [...agentDraft.tools, t.name]
                                      : agentDraft.tools.filter((x) => x !== t.name),
                                  })
                                }
                              />
                              {t.name}
                            </label>
                          ))}
                        </div>
                      </div>
                      <div className="ctx-cap">
                        Always wired in (not editable): scope-lattice memory · working context · the
                        think→tools→answer loop.
                      </div>
                      <div className="mem-actions">
                        <button className="mini" onClick={saveAgentDraft}>Save</button>
                        {agentDraft.id && agentDraft.id !== defaultAgentId && (
                          <button className="reject" onClick={deleteAgentDraft}>Delete</button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showImpact && (
        <div className="modal-overlay" onClick={() => setShowImpact(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>📈 Impact — the compounding</h2>
              <button onClick={() => setShowImpact(false)}>×</button>
            </div>
            <p className="modal-intro">
              The reuse the old way of working can&apos;t measure: firm knowledge learned on one engagement, applied on another.
            </p>
            {!impact ? (
              <div className="hint">loading…</div>
            ) : (
              <div className="impact">
                <div className="impact-stats">
                  <div className="impact-stat"><b>{impact.totalReuses}</b><span>insight reuses</span></div>
                  <div className="impact-stat"><b>{impact.distinctInsights}</b><span>distinct insights reused</span></div>
                  <div className="impact-stat"><b>{impact.targetProjects}</b><span>engagements benefited</span></div>
                </div>
                <div className="impact-headline">
                  {impact.totalReuses === 0
                    ? "No cross-engagement reuse recorded yet — it accrues as shared knowledge is applied on new projects."
                    : `${impact.distinctInsights} insight${impact.distinctInsights === 1 ? "" : "s"} reused across ${impact.targetProjects} engagement${impact.targetProjects === 1 ? "" : "s"}.`}
                </div>
                {impact.topInsights.length > 0 && (
                  <div className="impact-top">
                    <div className="impact-top-head">Most-reused insights</div>
                    {impact.topInsights.map((t) => (
                      <div key={`${t.scope}/${t.memoryId}`} className="impact-row">
                        <span className="pill ranked">{t.scope}</span>
                        <span className="impact-body">{t.body ? (t.body.length > 90 ? t.body.slice(0, 90) + "…" : t.body) : t.memoryId}</span>
                        <span className="impact-count" title="reuses · engagements">{t.reuses}× · {t.targets} proj</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {showMemory && (
        <div className="modal-overlay" onClick={() => setShowMemory(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>🧠 Memory manager</h2>
              <button onClick={() => setShowMemory(false)}>×</button>
            </div>
            <div className="modal-tabs">
              <button className={memView === "library" ? "active" : ""} onClick={() => setMemView("library")}>Library</button>
              <button className={memView === "pending" ? "active" : ""} onClick={() => setMemView("pending")}>
                Pending{proposals.length + nominations.length ? ` (${proposals.length + nominations.length})` : ""}
              </button>
            </div>
            <div className="modal-body">
              {memView === "library" && (
              <>
              <div className="empty">
                Every memory, grouped by where it lives on the scope lattice — broad (whole firm) at the top,
                specific (one person) at the bottom. Levels start collapsed — click one to browse it, or search
                to jump straight to matches. A message&apos;s ▸ x-ray shows the subset injected that turn; this is
                where you curate the whole library. Editing here changes the file on disk.
                <br />
                <b>Priority</b> sets how strongly the agent leans on a memory when space is tight. <b>Archive</b>{" "}
                pauses one (reversible); <b>Delete</b> removes it for good.
              </div>
              {memNote && <div className="ctx-item">{memNote}</div>}
              {allMemories.length === 0 && <div className="empty">No memories yet.</div>}
              {allMemories.length > 0 && (
                <div className="mem-toolbar">
                  <input
                    className="mem-search"
                    placeholder="Search memories…"
                    value={memSearch}
                    onChange={(e) => setMemSearch(e.target.value)}
                  />
                  <select value={memLevel} onChange={(e) => setMemLevel(e.target.value)} title="scope level">
                    <option value="all">All levels</option>
                    <option value="company">Company</option>
                    <option value="sector">Sector</option>
                    <option value="client">Client</option>
                    <option value="stakeholder">Stakeholder</option>
                    <option value="project">Project</option>
                    <option value="personal">Personal</option>
                  </select>
                  <select value={memStatusFilter} onChange={(e) => setMemStatusFilter(e.target.value)} title="status">
                    <option value="all">Active + archived</option>
                    <option value="active">Active only</option>
                    <option value="archived">Archived only</option>
                  </select>
                  <select value={memTypeFilter} onChange={(e) => setMemTypeFilter(e.target.value)} title="type">
                    <option value="all">All types</option>
                    <option value="constitution">Constitution</option>
                    <option value="learned">Learned</option>
                  </select>
                  <select value={memSort} onChange={(e) => setMemSort(e.target.value as typeof memSort)} title="sort">
                    <option value="priority">Sort: priority</option>
                    <option value="used">Sort: most-used</option>
                    <option value="newest">Sort: newest</option>
                  </select>
                </div>
              )}
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
                // Apply the browse controls, then group + sort within each level.
                const q = memSearch.trim().toLowerCase();
                const filtered = allMemories.filter((m) => {
                  if (memLevel !== "all" && m.scope.split("/")[0] !== memLevel) return false;
                  if (memStatusFilter === "active" && m.status === "retracted") return false;
                  if (memStatusFilter === "archived" && m.status !== "retracted") return false;
                  if (memTypeFilter !== "all" && m.type !== memTypeFilter) return false;
                  if (q && !(m.body.toLowerCase().includes(q) || m.scope.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)))
                    return false;
                  return true;
                });
                const rank = (m: MemItem) =>
                  memSort === "used" ? (m.useCount ?? 0) : memSort === "newest" ? (m.created ?? m.lastUsed ?? "") : m.importance;
                const byLevel = filtered.reduce<Record<string, MemItem[]>>((acc, m) => {
                  (acc[m.scope.split("/")[0]] ||= []).push(m);
                  return acc;
                }, {});
                for (const k of Object.keys(byLevel)) {
                  byLevel[k].sort((a, b) => (rank(a) > rank(b) ? -1 : rank(a) < rank(b) ? 1 : 0));
                }
                const known = LEVELS.map((l) => l.key);
                const extras = Object.keys(byLevel)
                  .filter((k) => !known.includes(k))
                  .map((k) => ({ key: k, label: k, gloss: "" }));
                if (filtered.length === 0) return <div className="empty">No memories match.</div>;
                // Any active search/filter auto-expands every matching level; otherwise
                // levels start collapsed (just header + count) so the library scans
                // cleanly with lots of memories. Cap cards per open level, with a
                // "show more" to reveal the rest — so no level mounts hundreds of editors.
                const searching =
                  q !== "" || memLevel !== "all" || memStatusFilter !== "all" || memTypeFilter !== "all";
                const CAP = 25;
                return [...LEVELS, ...extras]
                  .filter((lvl) => byLevel[lvl.key]?.length)
                  .map((lvl) => {
                  const items = byLevel[lvl.key];
                  const open = searching || !!openLevels[lvl.key];
                  const shown = open ? (showAllInLevel[lvl.key] ? items : items.slice(0, CAP)) : [];
                  return (
                  <div key={lvl.key} className="mem-level">
                    <div
                      className="mem-level-head"
                      style={{ cursor: "pointer" }}
                      onClick={() => setOpenLevels((s) => ({ ...s, [lvl.key]: !open }))}
                      title={open ? "collapse" : "expand"}
                    >
                      <span className="mem-level-name">{open ? "▾" : "▸"} {lvl.label}</span>
                      <span className="mem-level-gloss">{lvl.gloss}</span>
                      <span className="mem-level-count">{items.length}</span>
                    </div>
                    {shown.map((m) => {
                      const key = `${m.scope}:${m.id}`;
                      const d = memDraft[key] ?? { body: m.body, importance: m.importance };
                      const retracted = m.status === "retracted";
                      const isConstitution = m.type === "constitution";
                      return (
                        <div key={key} className={`mem-card ${retracted ? "retracted" : ""}`}>
                          <div className="mem-meta">
                            <span className="mem-scope">{m.scope}</span>
                            <span className={`pill ${isConstitution ? "stable" : "ranked"}`}>{m.type}</span>
                            {m.pinned && <span className="pill stable" title="pinned into the always-on cached tier; never decays">📌 pinned</span>}
                            {m.confidential && <span className="pill conf">confidential</span>}
                            {retracted && <span className="pill ret">archived</span>}
                            {m.useCount ? <span className="mem-uses" title="turns it's been injected into">used {m.useCount}×</span> : null}
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
                              <span className="imp muted" title="constitution memories are authoritative and never decay">
                                authoritative · no decay
                              </span>
                            ) : (
                              <div
                                className="priority"
                                title="Priority: how strongly the agent leans on this memory when prompt space is tight"
                              >
                                <span className="priority-label">Priority</span>
                                {(() => {
                                  const bucket = d.importance < 0.4 ? "Low" : d.importance < 0.75 ? "Med" : "High";
                                  return ([["Low", 0.3], ["Med", 0.55], ["High", 0.8]] as const).map(([lbl, val]) => (
                                    <button
                                      key={lbl}
                                      className={`prio ${bucket === lbl ? "active" : ""}`}
                                      onClick={() => setMemDraft((s) => ({ ...s, [key]: { ...d, importance: val } }))}
                                    >
                                      {lbl}
                                    </button>
                                  ));
                                })()}
                              </div>
                            )}
                            <div className="mem-actions">
                              <button className="mini" onClick={() => saveMem(m)}>Save</button>
                              {!isConstitution && !retracted && (
                                <button
                                  className="mini"
                                  title={m.pinned ? "unpin — let it rank and decay normally" : "pin into the always-on cached tier; it won't decay"}
                                  onClick={() => setMemPinned(m, !m.pinned)}
                                >
                                  {m.pinned ? "📌 Unpin" : "📌 Pin"}
                                </button>
                              )}
                              {retracted ? (
                                <button className="mini" title="use this memory again" onClick={() => setMemStatus(m, "active")}>
                                  Restore
                                </button>
                              ) : (
                                <button
                                  className="mini"
                                  title="stop the agent using it — the record is kept, and it's reversible"
                                  onClick={() => setMemStatus(m, "retracted")}
                                >
                                  Archive
                                </button>
                              )}
                              {!isConstitution && !retracted && (
                                <>
                                  <button className="mini" title="this memory's guidance worked → reinforce it (importance up)" onClick={() => setMemOutcome(m, true)}>
                                    👍 Worked
                                  </button>
                                  <button className="mini" title="its guidance didn't hold → downweight it (importance down)" onClick={() => setMemOutcome(m, false)}>
                                    👎 Didn&apos;t
                                  </button>
                                </>
                              )}
                              <button className="mini" title="who changed this memory, and when" onClick={() => toggleHistory(m)}>
                                History
                              </button>
                              <button
                                className="reject"
                                title="delete the file permanently — cannot be undone"
                                onClick={() => {
                                  if (confirm(`Delete "${m.id}"? This removes the file permanently.`)) deleteMem(m);
                                }}
                              >
                                Delete
                              </button>
                            </div>
                            {openHistory === `${m.scope}/${m.id}` && (
                              <div className="mem-history">
                                {(memHistory[`${m.scope}/${m.id}`] ?? []).length === 0 ? (
                                  <div className="mem-history-empty">no recorded changes yet</div>
                                ) : (
                                  (memHistory[`${m.scope}/${m.id}`] ?? []).map((h, i) => (
                                    <div key={i} className="mem-history-row">
                                      <span className={`pill ${h.action === "delete" || h.action === "decay" ? "ret" : "ranked"}`}>{h.action}</span>
                                      <span className="mem-history-actor">{h.actor ?? "—"}</span>
                                      <span className="mem-history-ts">{h.ts.replace("T", " ").slice(0, 16)}</span>
                                    </div>
                                  ))
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {open && items.length > shown.length && (
                      <button
                        className="mini"
                        onClick={() => setShowAllInLevel((s) => ({ ...s, [lvl.key]: true }))}
                      >
                        show {items.length - shown.length} more
                      </button>
                    )}
                  </div>
                  );
                });
              })()}
              </>
              )}

              {memView === "pending" && (
              <>
                <div className="empty">
                  Awaiting your decision: memories the agent suggested, lessons nominated to promote to a broader
                  scope, and implicit signals building toward a nomination. Approving a suggestion here is the
                  same as the Accept button on a chat suggestion.
                </div>
                {proposals.length + nominations.length + signals.length + lifecycle.stale.length + lifecycle.duplicates.length === 0 && (
                  <div className="empty">Nothing pending right now.</div>
                )}

                {proposals.length > 0 && <div className="ctx-h">💡 Suggested memories ({proposals.length})</div>}
                {proposals.map((p) => (
                  <div key={p.id} className="nom">
                    <div className="nom-target">save to <b>{p.scope}</b></div>
                    <div className="nom-fact">“{p.fact}”</div>
                    <div className="nom-meta">suggested by {p.proposedBy} · from {p.sourceProject}</div>
                    <div className="nom-actions">
                      {canApproveScope(user, p.scope) ? (
                        <button className="promote" onClick={() => approveProp(p.id)}>Approve &amp; save</button>
                      ) : (
                        <span className="lock-note">🔒 Only a Lead can approve {p.scope.split("/")[0]}-level memory</span>
                      )}
                      {(canApproveScope(user, p.scope) || user === p.proposedBy) && (
                        <button className="reject" onClick={() => dismissProp(p.id)}>Dismiss</button>
                      )}
                    </div>
                  </div>
                ))}

                {nominations.length > 0 && (
                  <>
                    <div className="ctx-h">⬆ Promotions ({nominations.length})</div>
                    <div className="ctx-cap">
                      Lessons nominated to move up to a broader scope so future projects inherit them.{" "}
                      <b>Generalise for the firm</b> rewrites the lesson to remove this client&apos;s specifics so
                      it&apos;s safe to reuse, and flags anything identifying that remains — review it, then promote.
                    </div>
                  </>
                )}
                {nominations.map((n) => (
                  <div key={n.id} className="nom">
                    <div className="nom-target">promote to <b>{n.targetScope}</b></div>
                    <div className="nom-fact">“{n.fact}”</div>
                    <div className="nom-meta">nominated by {n.nominatedBy} · from {n.sourceProject} · {n.reason}</div>
                    <button className="mini" onClick={() => doAbstract(n.id)}>Generalise for the firm</button>
                    {abstracts[n.id] && (
                      <>
                        {abstracts[n.id].leak?.flagged && (
                          <div className="leak">
                            ⚠ possible client detail still present
                            {[...(abstracts[n.id].leak!.hits ?? []), ...(abstracts[n.id].leak!.reasons ?? [])].filter(Boolean).length > 0
                              ? `: ${[...(abstracts[n.id].leak!.hits ?? []), ...(abstracts[n.id].leak!.reasons ?? [])].filter(Boolean).join(", ")}`
                              : ""}{" "}
                            — edit before promoting
                          </div>
                        )}
                        <textarea
                          className="nom-edit"
                          value={abstracts[n.id].text}
                          onChange={(e) => setAbstracts((a) => ({ ...a, [n.id]: { ...a[n.id], text: e.target.value } }))}
                        />
                      </>
                    )}
                    <div className="nom-actions">
                      {canApproveScope(user, n.targetScope) ? (
                        <button className="promote" onClick={() => doPromote(n.id)}>
                          Promote{abstracts[n.id] ? " (abstracted)" : " as-is"}
                        </button>
                      ) : (
                        <span className="lock-note">🔒 Only a Lead can promote to {n.targetScope.split("/")[0]} scope</span>
                      )}
                      {(canApproveScope(user, n.targetScope) || user === n.nominatedBy) && (
                        <button className="reject" onClick={() => doReject(n.id)}>Reject</button>
                      )}
                    </div>
                  </div>
                ))}

                {signals.length > 0 && (
                  <div className="signals">
                    <div className="ctx-h">Signals accumulating (implicit)</div>
                    {signals.map((s) => (
                      <div key={s.pattern} className="sig">
                        <div className="sig-top">
                          <b>{s.pattern}</b>
                          <span className="sig-count">
                            {s.count}/{signalThreshold}{s.nominated ? " · nominated ✓" : ""}
                          </span>
                        </div>
                        <div className="sig-bar">
                          <div className="sig-fill" style={{ width: `${Math.min(100, (s.count / signalThreshold) * 100)}%` }} />
                        </div>
                        <div className="sig-obs">{s.lastObservation}</div>
                      </div>
                    ))}
                  </div>
                )}

                {lifecycle.stale.length > 0 && (
                  <>
                    <div className="ctx-h">🧹 Stale — suggest archiving ({lifecycle.stale.length})</div>
                    <div className="ctx-cap">
                      Low-priority learned memories not used or reinforced in over a month. Archiving keeps the
                      record but stops the agent using it; Keep snoozes the reminder.
                    </div>
                    {lifecycle.stale.map((s) => (
                      <div key={`stale-${s.scope}:${s.id}`} className="nom">
                        <div className="nom-target"><b>{s.scope}</b> · last active {s.lastActivity} ({s.days}d ago)</div>
                        <div className="nom-fact">“{s.body}”</div>
                        <div className="nom-actions">
                          <button className="reject" onClick={() => archiveByRef(s.scope, s.id)}>Archive</button>
                          <button className="mini" onClick={() => keepByRef(s.scope, s.id)}>Keep</button>
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {lifecycle.duplicates.length > 0 && (
                  <>
                    <div className="ctx-h">👯 Possible duplicates ({lifecycle.duplicates.length})</div>
                    <div className="ctx-cap">Near-identical learned memories — archive one to consolidate.</div>
                    {lifecycle.duplicates.map((p, i) => (
                      <div key={`dup-${i}`} className="nom">
                        <div className="nom-target">similarity {Math.round(p.score * 100)}%</div>
                        <div className="dup-pair">
                          {[p.a, p.b].map((side) => (
                            <div key={`${side.scope}:${side.id}`} className="dup-side">
                              <div className="nom-fact">“{side.body}”</div>
                              <div className="nom-meta">{side.scope}</div>
                              <button className="reject" onClick={() => archiveByRef(side.scope, side.id)}>Archive this</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
