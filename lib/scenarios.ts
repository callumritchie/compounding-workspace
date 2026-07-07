/* ---------------------------------------------------------------------------
   scenarios.ts — guided demo scripts.

   Each scenario sets the stage (who you are, which project, what's open) and
   walks through numbered steps. A step narrates what's happening, optionally
   switches actor/project, and can offer a suggested prompt to click-send. The
   goal is to make the system's value legible in a couple of clicks.
--------------------------------------------------------------------------- */

export type ScenarioStep = {
  say: string; // narration for this step
  watch?: string; // "what to notice"
  prompt?: string; // a suggested message to click-send
  asUser?: "callum" | "bob"; // switch actor entering this step
  goProject?: string; // switch project entering this step
  open?: string; // open a file entering this step
  openPending?: boolean; // open the Memory manager on its Pending tab
  freshChat?: boolean; // start a clean, empty chat (so the proactive kickoff card can show)
};

export type Scenario = {
  id: string;
  title: string;
  blurb: string;
  setup: { asUser?: "callum" | "bob"; goProject?: string; open?: string };
  steps: ScenarioStep[];
};

export const SCENARIOS: Scenario[] = [
  {
    id: "warm-start-cold-project",
    title: "Warm start — a cold project briefs itself",
    blurb: "Open a brand-new project and it briefs you first — no question typed, no blank page.",
    setup: { asUser: "callum", goProject: "acme-expansion" },
    steps: [
      {
        say: "You've just been staffed on a brand-new Acme project. Don't type anything — just watch.",
        watch:
          "A 👋 kickoff card appears on its own. On a project with no memory of its own, it assembles what the firm already knows — the healthcare playbook, firm policy, and the Acme CFO — into a plain-English brief.",
        goProject: "acme-expansion", // explicit so freshChat opens the empty chat in the RIGHT project
        freshChat: true,
      },
      {
        say: "You never face a blank box: click any ▸ starter question in the card to get going.",
        watch: "Open the answer's ▸ x-ray to see the inherited memories that fired — none of it learned on this project.",
      },
      {
        say: "Make it sharper: in the card, click “＋ Answer 3 quick questions”, answer one or two, and Save.",
        watch:
          "The brief refreshes to include what you told it. Open 🧠 Memory manager — the new facts show as PROVISIONAL, and nothing is waiting in the Pending inbox: captured with no approval step.",
      },
      {
        say: "Those provisional facts firm up on their own as the agent uses them (and retract if you 👎 an answer that leaned on one). That's warm start: a cold project briefs itself, says what to ask, and quietly keeps what you teach it — no setup, no approvals.",
      },
    ],
  },
  {
    id: "new-project-strong-start",
    title: "New project — strong start",
    blurb: "Day one on a brand-new project, and the agent already knows a lot.",
    setup: { asUser: "callum", goProject: "acme-expansion", open: "brief.md" },
    steps: [
      {
        say: "You've just been staffed on a brand-new Acme project — day one, no interviews, no analysis.",
        watch: "The Files panel holds only a kick-off brief. This project has no memory of its own yet.",
      },
      {
        say: "Ask what the agent already knows before you've done any work.",
        prompt: "We're just kicking off this Acme engagement. What do we already know going in?",
        watch: "Open the answer's ▸ x-ray: it's already using firm policy, the healthcare sector playbook, Acme account lessons, and the CFO's preferences — all inherited on an empty project.",
      },
      {
        say: "That's the compounding payoff: a new project starts from everything the firm has accumulated, not a blank page.",
      },
    ],
  },
  {
    id: "shared-memory-team",
    title: "Shared memory across the team",
    blurb: "What one person teaches the agent, the whole team's agent knows.",
    setup: { asUser: "callum", goProject: "acme-health" },
    steps: [
      {
        say: "As Callum, teach the team something durable about this engagement.",
        prompt: "Remember for the whole team: Acme's board reviews recommendations on Thursdays, so we need final numbers by Wednesday.",
        watch: "A '💡 Suggested for the team' chip appears — shared memory needs a human OK before it sticks.",
      },
      {
        say: "You're a Lead, so you can approve it. Click Accept on the chip.",
        watch: "It's saved to this project's shared memory.",
      },
      {
        say: "Now switch to Bob and ask about the deadline on the same project.",
        asUser: "bob",
        prompt: "When do we need Acme's numbers finalised, and why?",
        watch: "Bob's agent already knows the Wednesday deadline — shared project memory. Callum's personal preferences, though, never leaked to Bob.",
      },
    ],
  },
  {
    id: "compounding-across-projects",
    title: "A lesson compounds across projects",
    blurb: "A lesson learned on one engagement shows up automatically on another.",
    setup: { asUser: "callum", goProject: "acme-health" },
    steps: [
      {
        say: "Ask how to frame the business case on the Acme growth project.",
        prompt: "How should we frame the business case for the Acme board?",
        watch: "The ▸ x-ray shows a healthcare sector lesson in play ('lead with the downside').",
      },
      {
        say: "Now move to a DIFFERENT client in the same sector — Beacon — and ask the same thing.",
        goProject: "beacon-health",
        prompt: "How should we frame the business case for Beacon's board?",
        watch: "The same healthcare lesson applies, even though it wasn't learned on Beacon — because it lives at the sector level. That's compounding across projects.",
      },
    ],
  },
  {
    id: "governance-who-approves",
    title: "Governance: who approves what",
    blurb: "Broad, firm-wide memory can't be waved through by just anyone.",
    setup: { asUser: "bob" },
    steps: [
      {
        say: "There's a pending nomination to make a lesson firm-wide (company scope). You're Bob, an analyst.",
        openPending: true,
        watch: "In the Memory manager → Pending, the company-level promotion shows a 🔒 'Only a Lead can promote' lock. You can't approve it.",
      },
      {
        say: "Switch to Callum, a Lead, and look again.",
        asUser: "callum",
        openPending: true,
        watch: "Now Promote is available. Abstract & leak-check first (it strips the client name), then Promote — firm-wide knowledge is gated to a Lead.",
      },
    ],
  },
  {
    id: "memory-suggestions",
    title: "Memory suggestions",
    blurb: "The agent notices what's worth keeping and asks before saving.",
    setup: { asUser: "callum", goProject: "acme-health" },
    steps: [
      {
        say: "Tell the agent something worth keeping for the team.",
        prompt: "Going forward, remember for the team: Acme prefers recommendations capped to three options, never more.",
        watch: "The agent proposes a shared memory — a '💡 Suggested' chip with Accept / Decline, right in the chat.",
      },
      {
        say: "Accept it, then ask something that depends on it.",
        prompt: "How many options should our next Acme recommendation include?",
        watch: "The next answer honours the memory you just approved — check its ▸ x-ray to see it injected.",
      },
    ],
  },
];
