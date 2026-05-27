import {
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Code2,
  Github,
  History,
  KeyRound,
  Layers3,
  MessageSquareText,
  Network,
  Radio,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wand2,
} from "lucide-react";

const repoUrl = "https://github.com/mertz1999/luma-assistant";
const readmeUrl = `${repoUrl}#readme`;

const featureRows = [
  {
    icon: Bot,
    title: "Agent library",
    text: "Repo-owned prompts load from AGENT.md files and run with the latest body every time.",
  },
  {
    icon: CalendarClock,
    title: "Tehran schedules",
    text: "Daily Asia/Tehran runs snapshot workspace, model, sandbox, approval policy, and selected skills.",
  },
  {
    icon: Wand2,
    title: "Managed skills",
    text: "Sync SKILL.md folders into Codex home while leaving unmanaged global skills untouched.",
  },
  {
    icon: Network,
    title: "MCP visibility",
    text: "See MCP calls, shell commands, web searches, file changes, diffs, and approvals in one timeline.",
  },
  {
    icon: MessageSquareText,
    title: "Telegram automation",
    text: "Send clean Markdown summaries and generated files to Telegram topics through the local MCP server.",
  },
  {
    icon: ShieldCheck,
    title: "Self-hosted controls",
    text: "Password auth, PM2 process files, Nginx examples, runtime data, and deploy-friendly docs stay in the repo.",
  },
];

const scheduleItems = [
  ["09:00", "TickTick Today", "Ready", "Tehran"],
  ["13:30", "Repo Sweep", "Queued", "Workspace"],
  ["20:15", "Telegram Digest", "Scheduled", "luma-tel"],
];

const sessionItems = [
  ["codex", "Fix build drift", "running"],
  ["agent", "Daily work digest", "completed"],
  ["terminal", "deploy-status", "idle"],
];

function App() {
  return (
    <main className="min-h-screen bg-paper text-ink">
      <section className="relative overflow-hidden border-b border-ink/10 bg-[radial-gradient(circle_at_15%_15%,rgba(224,165,38,0.16),transparent_28%),linear-gradient(135deg,#f6f4ef_0%,#eef3ed_46%,#f5eee8_100%)]">
        <div className="mx-auto flex min-h-[88vh] w-full max-w-7xl flex-col px-5 py-5 sm:px-8 lg:px-10">
          <nav className="flex items-center justify-between gap-4">
            <a href="#" className="flex items-center gap-3 text-sm font-semibold">
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-ink text-paper">
                <Sparkles className="h-5 w-5" aria-hidden="true" />
              </span>
              Luma Assistant
            </a>
            <div className="flex items-center gap-2">
              <a
                className="hidden rounded-md border border-ink/15 px-3 py-2 text-sm font-medium transition hover:border-ink/35 sm:inline-flex"
                href={readmeUrl}
              >
                README
              </a>
              <a
                className="inline-flex items-center gap-2 rounded-md bg-ink px-3 py-2 text-sm font-semibold text-paper transition hover:bg-fern"
                href={repoUrl}
              >
                <Github className="h-4 w-4" aria-hidden="true" />
                GitHub
              </a>
            </div>
          </nav>

          <div className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[0.88fr_1.12fr] lg:py-16">
            <div className="max-w-2xl">
              <p className="mb-4 inline-flex items-center gap-2 rounded-md border border-ink/15 bg-white/55 px-3 py-2 text-sm font-medium text-fern">
                <Radio className="h-4 w-4" aria-hidden="true" />
                Self-hosted Codex control room
              </p>
              <h1 className="text-5xl font-semibold leading-none tracking-normal text-ink sm:text-6xl lg:text-7xl">
                Luma Assistant
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-8 text-ink/72">
                Run Codex from a persistent web workspace with scheduled agents, managed skills, MCP visibility,
                Telegram automation, terminals, auth, and session history.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-fern px-5 py-3 text-sm font-semibold text-white transition hover:bg-ink"
                  href={repoUrl}
                >
                  View repository
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </a>
                <a
                  className="inline-flex items-center justify-center rounded-md border border-ink/18 bg-white/65 px-5 py-3 text-sm font-semibold text-ink transition hover:border-ink/35"
                  href={readmeUrl}
                >
                  Read setup guide
                </a>
              </div>
            </div>

            <DashboardPreview />
          </div>
        </div>
      </section>

      <section className="border-b border-ink/10 bg-white">
        <div className="mx-auto grid max-w-7xl gap-5 px-5 py-14 sm:px-8 md:grid-cols-2 lg:grid-cols-3 lg:px-10">
          {featureRows.map((feature) => (
            <article key={feature.title} className="rounded-lg border border-ink/10 bg-paper/60 p-5">
              <feature.icon className="mb-4 h-6 w-6 text-copper" aria-hidden="true" />
              <h2 className="text-lg font-semibold">{feature.title}</h2>
              <p className="mt-2 text-sm leading-6 text-ink/68">{feature.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="bg-paper">
        <div className="mx-auto grid max-w-7xl gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:px-10">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-fern">Operator workflow</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-normal sm:text-4xl">
              One window for sessions, schedules, tools, and delivery.
            </h2>
            <p className="mt-4 text-base leading-7 text-ink/70">
              Luma Assistant keeps human-driven Codex sessions and scheduled agent runs in the same history. Completed
              scheduled executions open directly in the normal chat viewer, so automation stays inspectable.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <InfoBlock icon={Code2} title="Codex workspace" text="Continue sessions, watch streamed output, inspect diffs, and queue follow-up prompts." />
            <InfoBlock icon={TerminalSquare} title="Session terminals" text="Run commands manually with per-session state and retained command history." />
            <InfoBlock icon={History} title="Durable history" text="Persist local sessions, message history, schedules, and latest executions under data/." />
            <InfoBlock icon={KeyRound} title="Private by default" text="Use password auth, HTTPS reverse proxying, and your own host for a personal automation surface." />
          </div>
        </div>
      </section>

      <section className="border-t border-ink/10 bg-ink text-paper">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-14 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-10">
          <div>
            <h2 className="text-3xl font-semibold tracking-normal">Build your own Codex operating desk.</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-paper/72">
              Clone the repo, add agents and skills, configure Telegram MCP, and deploy the landing page with GitHub
              Pages.
            </p>
          </div>
          <a
            className="inline-flex items-center justify-center gap-2 rounded-md bg-signal px-5 py-3 text-sm font-semibold text-ink transition hover:bg-white"
            href={repoUrl}
          >
            Open on GitHub
            <Github className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>
      </section>
    </main>
  );
}

function DashboardPreview() {
  return (
    <div className="relative">
      <div className="overflow-hidden rounded-lg border border-ink/12 bg-white shadow-panel">
        <div className="flex items-center justify-between border-b border-ink/10 bg-ink px-4 py-3 text-paper">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full bg-berry" />
            <span className="h-3 w-3 rounded-full bg-signal" />
            <span className="h-3 w-3 rounded-full bg-fern" />
          </div>
          <span className="text-xs font-medium text-paper/70">workspace / archive</span>
        </div>
        <div className="grid gap-0 lg:grid-cols-[0.72fr_1fr]">
          <aside className="border-b border-ink/10 bg-paper/65 p-4 lg:border-b-0 lg:border-r">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-ink/56">Sessions</span>
              <Cloud className="h-4 w-4 text-fern" aria-hidden="true" />
            </div>
            <div className="space-y-3">
              {sessionItems.map(([kind, title, status]) => (
                <div key={title} className="rounded-md border border-ink/10 bg-white p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase text-copper">{kind}</span>
                    <span className="rounded-md bg-fern/10 px-2 py-1 text-[11px] font-semibold text-fern">{status}</span>
                  </div>
                  <p className="mt-2 text-sm font-semibold">{title}</p>
                </div>
              ))}
            </div>
          </aside>
          <div className="p-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-ink/10 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Bot className="h-5 w-5 text-fern" aria-hidden="true" />
                  <h3 className="text-sm font-semibold">Scheduled agents</h3>
                </div>
                <div className="space-y-2">
                  {scheduleItems.map(([time, title, status, tag]) => (
                    <div key={title} className="grid grid-cols-[3.5rem_1fr] gap-3 rounded-md bg-paper px-3 py-2">
                      <span className="text-sm font-bold text-ink">{time}</span>
                      <div>
                        <p className="text-sm font-semibold">{title}</p>
                        <p className="text-xs text-ink/56">
                          {status} · {tag}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-ink/10 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Layers3 className="h-5 w-5 text-copper" aria-hidden="true" />
                  <h3 className="text-sm font-semibold">MCP and skills</h3>
                </div>
                <ul className="space-y-3 text-sm">
                  {["ticktick", "luma-tel", "repo skills", "web search"].map((item) => (
                    <li key={item} className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-fern" aria-hidden="true" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-ink/10 bg-ink p-4 text-paper">
              <div className="mb-3 flex items-center gap-2">
                <MessageSquareText className="h-5 w-5 text-signal" aria-hidden="true" />
                <h3 className="text-sm font-semibold">Telegram digest preview</h3>
              </div>
              <p className="text-sm leading-6 text-paper/78">
                <strong>Today</strong>: 6 tasks found, 2 overdue, 1 waiting on review. Markdown is sent cleanly to the
                selected topic for Telegram rendering.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoBlock({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Code2;
  title: string;
  text: string;
}) {
  return (
    <article className="rounded-lg border border-ink/10 bg-white p-5">
      <Icon className="mb-4 h-6 w-6 text-fern" aria-hidden="true" />
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-ink/68">{text}</p>
    </article>
  );
}

export default App;
