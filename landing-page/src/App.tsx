import { useMemo, useState } from "react";
import {
  Bot,
  CalendarCheck,
  ChevronRight,
  ClipboardCheck,
  Github,
  Layers3,
  ListChecks,
  MessageSquareText,
  Mic,
  Moon,
  Network,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Sun,
  TerminalSquare,
  UserCog,
} from "lucide-react";

type Mode = "light" | "dark";

const repoUrl = "https://github.com/mertz1999/luma-assistant";
const readmeUrl = `${repoUrl}#readme`;
const baseUrl = import.meta.env.BASE_URL;

const remoteFeatureScreenshots = [
  {
    src: `${baseUrl}screenshots/remote-chat-mobile.png`,
    alt: "Luma Assistant mobile chat session view",
  },
  {
    src: `${baseUrl}screenshots/remote-agents-mobile.png`,
    alt: "Luma Assistant mobile agents schedule view",
  },
  {
    src: `${baseUrl}screenshots/remote-chats-blurred.png`,
    alt: "Luma Assistant mobile session history list",
  },
];

const featureRows = [
  {
    icon: Bot,
    title: "Choose Codex or Claude Code",
    text: "Start each session with the runner, model, and thinking effort you need. Existing sessions keep their original runner.",
  },
  {
    icon: MessageSquareText,
    title: "Claude-like coding workspace",
    text: "A compact dark shell with collapsible sidebars, centered messages, clean user bubbles, and inline tool activity rows.",
  },
  {
    icon: Layers3,
    title: "Native-feeling plan mode",
    text: "Protected planning turns stay read-only, with approval flow support for implementation once the plan is accepted.",
  },
  {
    icon: ClipboardCheck,
    title: "Luma Tasks built in",
    text: "Run a separate task-manager PWA with projects, priorities, deadlines, timezone-aware Today views, admin users, and Telegram-ready reports.",
  },
  {
    icon: Network,
    title: "MCP and tools inline",
    text: "Command, MCP, web search, and file activity appears as concise transcript rows like Ran 5 commands, expandable in place.",
  },
  {
    icon: TerminalSquare,
    title: "Best-effort browser terminal",
    text: "Open a per-session terminal dock, type directly in the terminal surface, interrupt commands, and close the dock when not needed.",
  },
  {
    icon: Mic,
    title: "Attachments and voice",
    text: "Attach files, select repo skills and agents, dictate prompts, and queue follow-up messages while a session is busy.",
  },
  {
    icon: ShieldCheck,
    title: "Skills for both runners",
    text: "Repo-managed skills sync into both ~/.codex/skills and ~/.claude/skills, with conflict protection and manual reload.",
  },
];

function App() {
  const [mode, setMode] = useState<Mode>("dark");
  const isDark = mode === "dark";

  const shell = useMemo(
    () =>
      isDark
        ? "bg-[#101412] text-[#f3f0e7]"
        : "bg-[#f5f4ef] text-[#14251f]",
    [isDark],
  );

  return (
    <main className={`min-h-screen overflow-hidden ${shell}`}>
      <Hero mode={mode} setMode={setMode} />
      <FeatureGrid />
      <TaskManagerShowcase mode={mode} />
      <WorkflowShowcase mode={mode} />
      <FinalCta />
    </main>
  );
}

function Hero({
  mode,
  setMode,
}: {
  mode: Mode;
  setMode: (mode: Mode) => void;
}) {
  const isDark = mode === "dark";

  return (
    <section className="relative min-h-screen overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(47,111,94,0.26),transparent_34%),linear-gradient(300deg,rgba(224,165,38,0.22),transparent_38%)]" />
      <div className="absolute inset-x-0 top-0 h-28 bg-[linear-gradient(180deg,rgba(255,255,255,0.16),transparent)]" />

      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-5 py-5 sm:px-8 lg:px-10">
        <nav className="flex items-center justify-between gap-4">
          <a href="#" className="flex items-center gap-3 text-sm font-semibold">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-[#2f8f7e] text-white">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="max-[360px]:hidden">Luma Assistant</span>
          </a>
          <div className="flex items-center gap-2">
            <ThemeSwitch mode={mode} setMode={setMode} />
            <a
              className={`inline-flex h-10 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold transition ${
                isDark ? "bg-white text-[#14251f] hover:bg-[#e0a526]" : "bg-[#14251f] text-white hover:bg-[#2f8f7e]"
              }`}
              href={repoUrl}
              aria-label="Open GitHub repository"
            >
              <Github className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">GitHub</span>
            </a>
          </div>
        </nav>

        <div className="grid flex-1 items-center gap-9 py-10 lg:grid-cols-[0.86fr_1.14fr] lg:py-14">
          <div className="max-w-2xl">
            <p
              className={`mb-5 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold ${
                isDark ? "border-white/15 bg-white/10 text-[#a8e8d7]" : "border-[#14251f]/10 bg-white/70 text-[#2f6f5e]"
              }`}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Codex and Claude Code, reachable by URL
            </p>
            <h1 className="max-w-xl text-5xl font-semibold leading-none sm:text-6xl lg:text-7xl">
              Luma Assistant
            </h1>
            <p className={`mt-6 max-w-xl text-lg leading-8 ${isDark ? "text-white/70" : "text-[#14251f]/70"}`}>
              A self-hosted coding-agent workspace with a Claude-like UI, Codex and Claude Code runners,
              model and thinking controls, plan mode, inline MCP activity, skills, agents, voice, and a
              browser terminal.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                className="inline-flex items-center justify-center gap-2 rounded-md bg-[#2f8f7e] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#226f62]"
                href={repoUrl}
              >
                View repository
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </a>
              <a
                className={`inline-flex items-center justify-center rounded-md border px-5 py-3 text-sm font-semibold transition ${
                  isDark
                    ? "border-white/15 bg-white/10 text-white hover:bg-white/15"
                    : "border-[#14251f]/15 bg-white/70 text-[#14251f] hover:bg-white"
                }`}
                href={readmeUrl}
              >
                Read setup guide
              </a>
            </div>
          </div>

          <ProductStage mode={mode} />
        </div>
      </div>
    </section>
  );
}

function ThemeSwitch({ mode, setMode }: { mode: Mode; setMode: (mode: Mode) => void }) {
  return (
    <div className="flex rounded-md border border-current/10 bg-current/5 p-1" aria-label="Preview mode">
      <button
        className={`inline-flex h-8 w-9 items-center justify-center rounded-md transition ${
          mode === "light" ? "bg-white text-[#14251f] shadow-sm" : "text-current/60 hover:text-current"
        }`}
        type="button"
        onClick={() => setMode("light")}
        aria-label="Show light mode"
      >
        <Sun className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        className={`inline-flex h-8 w-9 items-center justify-center rounded-md transition ${
          mode === "dark" ? "bg-[#14251f] text-white shadow-sm" : "text-current/60 hover:text-current"
        }`}
        type="button"
        onClick={() => setMode("dark")}
        aria-label="Show dark mode"
      >
        <Moon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function ProductStage({ mode }: { mode: Mode }) {
  const isDark = mode === "dark";
  const shell = isDark ? "border-white/10 bg-[#181b18] text-[#f3f0e7]" : "border-[#14251f]/10 bg-white text-[#14251f]";
  const sidebar = isDark ? "border-white/10 bg-[#232521]" : "border-[#14251f]/10 bg-[#efeee9]";
  const panel = isDark ? "border-white/10 bg-[#292b27]" : "border-[#14251f]/10 bg-[#f7f6f1]";
  const muted = isDark ? "text-white/58" : "text-[#14251f]/58";
  const bubble = isDark ? "bg-[#343632] text-[#f3f0e7]" : "bg-[#e7e5dd] text-[#14251f]";
  const active = isDark ? "bg-[#5b5d58] text-white" : "bg-white text-[#14251f]";

  return (
    <div className="relative mx-auto w-full max-w-4xl">
      <div
        className={`absolute -inset-4 rounded-lg ${
          isDark ? "bg-[#2f8f7e]/10" : "bg-[#2f8f7e]/10"
        } blur-2xl`}
        aria-hidden="true"
      />
      <div className="relative">
        <div
          className={`overflow-hidden rounded-lg border shadow-[0_34px_90px_rgba(0,0,0,0.24)] ${shell}`}
        >
          <div className="grid min-h-[430px] grid-cols-1 text-[13px] sm:min-h-[500px] sm:grid-cols-[190px_minmax(0,1fr)]">
            <aside className={`relative hidden border-r p-3 sm:block ${sidebar}`}>
              <div className="mb-4 grid grid-cols-3 gap-1 rounded-md bg-black/10 p-1">
                {["Agents", "Cowork", "Code"].map((item) => (
                  <span className={`rounded-md px-2 py-1.5 text-center text-[11px] ${item === "Code" ? active : muted}`} key={item}>
                    {item}
                  </span>
                ))}
              </div>
              <div className="space-y-1.5">
                {["New session", "Routines", "Customize"].map((item) => (
                  <div className={`rounded-md px-2 py-1.5 ${muted}`} key={item}>
                    {item}
                  </div>
                ))}
              </div>
              <div className={`mt-8 text-[11px] font-medium ${muted}`}>Recents</div>
              <div className="mt-2 space-y-1">
                {["Questions", "Skill folder review", "Deploy assistant"].map((item, index) => (
                  <div className={`truncate rounded-md px-2 py-1.5 ${index === 0 ? active : muted}`} key={item}>
                    {item}
                  </div>
                ))}
              </div>
              <div className={`absolute bottom-3 left-3 right-3 rounded-md border p-2 ${panel}`}>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#34d399]" />
                  <span className="font-medium">Luma Assistant</span>
                </div>
                <div className={`mt-1 text-[11px] ${muted}`}>Local</div>
              </div>
            </aside>

            <section className="flex min-w-0 flex-col">
              <header className={`flex items-center justify-between gap-3 px-4 py-3 ${isDark ? "bg-[#1d201c]" : "bg-[#fbfaf6]"}`}>
                <div className="min-w-0">
                  <div className="truncate font-semibold">Questions</div>
                  <div className={`text-[11px] ${muted}`}>evidentia</div>
                </div>
                <div className="flex gap-1.5">
                  {["Terminal", "Approvals", "Context"].map((item) => (
                    <span className={`hidden rounded-md px-2 py-1 text-[11px] sm:inline-flex ${panel}`} key={item}>
                      {item}
                    </span>
                  ))}
                </div>
              </header>

              <div className="flex-1 space-y-6 overflow-hidden px-5 py-6">
                <div className="flex justify-end">
                  <div className={`max-w-[72%] rounded-md px-3 py-2 ${bubble}`}>
                    ok update the skill and commit and push
                  </div>
                </div>

                <div className="max-w-[82%] space-y-3 leading-6">
                  <p>Let me read the relevant files first.</p>
                  <div className={`inline-flex items-center gap-1 text-sm ${muted}`}>
                    Ran 2 commands <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </div>
                  <p>Now I have everything I need. Implementing all three changes:</p>
                  <div className={`inline-flex items-center gap-1 text-sm ${muted}`}>
                    Edited query_workflow.md <span className="text-[#22c55e]">+20</span><span className="text-[#f43f5e]">-0</span>
                  </div>
                  <p>Done. Three files changed and pushed:</p>
                  <div className={`grid grid-cols-[0.95fr_1.05fr] overflow-hidden rounded-md border text-sm ${panel}`}>
                    <div className="border-b border-current/10 px-3 py-2 font-medium">File</div>
                    <div className="border-b border-l border-current/10 px-3 py-2 font-medium">What it does</div>
                    <div className="px-3 py-2 text-[#0ea5e9]">references/hazard_label_symbols.md</div>
                    <div className="border-l border-current/10 px-3 py-2">Built-in reference for every label.</div>
                  </div>
                </div>
              </div>

              <footer className="px-5 pb-5">
                <div className={`mb-2 flex w-full max-w-[960px] items-center gap-2 rounded-md px-3 py-2 text-[12px] ${panel}`}>
                  <span>Codex</span>
                  <span>gpt-5.5</span>
                  <span>high</span>
                  <span className="ml-auto text-[#34d399]">connected</span>
                </div>
                <div className={`flex w-full max-w-[960px] items-center rounded-md border px-3 py-3 ${panel}`}>
                  <span className={muted}>Type / for commands</span>
                  <Send className={`ml-auto h-4 w-4 ${muted}`} aria-hidden="true" />
                </div>
              </footer>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeatureGrid() {
  return (
    <section className="bg-[#f5f4ef] text-[#14251f]">
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8 lg:px-10">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold text-[#2f6f5e]">Built for remote coding-agent work</p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
            Codex and Claude Code become one application you can use anywhere.
          </h2>
          <p className="mt-4 text-base leading-7 text-[#14251f]/70">
            Luma Assistant keeps the core coding-agent workflow intact while adding a compact web UI, server
            deployment, scheduled jobs, mobile-friendly terminal access, and persistent session history.
          </p>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {featureRows.map((feature) => (
            <article className="rounded-lg border border-[#14251f]/10 bg-white p-5 shadow-[0_14px_40px_rgba(20,37,31,0.06)]" key={feature.title}>
              <feature.icon className="mb-4 h-6 w-6 text-[#b96f3d]" aria-hidden="true" />
              <h3 className="text-lg font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm leading-6 text-[#14251f]/70">{feature.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function TaskManagerShowcase({
  mode,
}: {
  mode: Mode;
}) {
  const isDark = mode === "dark";
  const shell = isDark ? "bg-[#101412] text-[#f3f0e7]" : "bg-white text-[#14251f]";
  const panel = isDark ? "border-white/10 bg-white/[0.08]" : "border-[#14251f]/10 bg-[#f5f4ef]";
  const muted = isDark ? "text-white/68" : "text-[#14251f]/68";
  const tasks = [
    { title: "Review launch checklist", meta: "Today · Website", color: "bg-[#ef2f2f]" },
    { title: "Prepare Telegram digest", meta: "Tomorrow · Operations", color: "bg-[#f59e0b]" },
    { title: "Update project access", meta: "Deadline · Admin", color: "bg-[#4f6df5]" },
  ];

  return (
    <section className={`${shell}`}>
      <div className="mx-auto grid max-w-7xl gap-8 px-5 py-16 sm:px-8 lg:grid-cols-[0.92fr_1.08fr] lg:items-center lg:px-10">
        <div>
          <p className="inline-flex items-center gap-2 rounded-md bg-[#2f8f7e]/12 px-3 py-2 text-sm font-semibold text-[#2f8f7e]">
            <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
            New: Luma Tasks
          </p>
          <h2 className="mt-4 text-3xl font-semibold leading-tight sm:text-4xl">
            A separate task manager for the work your agents create.
          </h2>
          <p className={`mt-4 max-w-2xl text-base leading-7 ${muted}`}>
            Open `/taskmanager` as its own PWA, manage projects and users, sort project chips in the browser,
            track deadline-heavy work, and let MCP agents send clean Today reports to Telegram.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {[
              { icon: ListChecks, title: "Project columns", text: "Color-coded lists, mobile chips, and saved local ordering." },
              { icon: CalendarCheck, title: "Deadline views", text: "Timezone-aware Today, Upcoming, Completed, and report output." },
              { icon: UserCog, title: "Admin controls", text: "Manage users and project access from the task app." },
              { icon: Send, title: "Telegram reports", text: "Use `luma-tasks` and `luma-tel` to send daily digests." },
            ].map((item) => (
              <div className={`rounded-lg border p-4 ${panel}`} key={item.title}>
                <item.icon className="mb-3 h-5 w-5 text-[#b96f3d]" aria-hidden="true" />
                <h3 className="text-sm font-semibold">{item.title}</h3>
                <p className={`mt-1 text-sm leading-6 ${muted}`}>{item.text}</p>
              </div>
            ))}
          </div>
        </div>

        <div className={`rounded-lg border p-3 shadow-[0_24px_70px_rgba(20,37,31,0.14)] ${panel}`}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Luma Tasks</div>
              <div className={`text-xs ${muted}`}>Today · Asia/Tehran</div>
            </div>
            <div className="flex gap-2">
              {["All", "Inbox", "Website"].map((chip, index) => (
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    index === 1 ? "bg-[#2f8f7e] text-white" : isDark ? "bg-white/10 text-white/75" : "bg-white text-[#14251f]/75"
                  }`}
                  key={chip}
                >
                  {chip}
                </span>
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {["Inbox", "Website", "Operations"].map((column, columnIndex) => (
              <div className={`min-h-64 rounded-lg border p-3 ${isDark ? "border-white/10 bg-[#191d1a]" : "border-[#14251f]/10 bg-white"}`} key={column}>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#2f8f7e]" />
                    <span className="truncate text-sm font-semibold">{column}</span>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${isDark ? "bg-white/10" : "bg-[#f5f4ef]"}`}>{columnIndex + 1}</span>
                </div>
                <div className="space-y-2">
                  {tasks.slice(0, columnIndex + 1).map((task) => (
                    <div className={`rounded-md border p-3 ${isDark ? "border-white/10 bg-white/[0.07]" : "border-[#14251f]/10 bg-[#f8f7f2]"}`} key={`${column}-${task.title}`}>
                      <div className="flex items-start gap-2">
                        <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${task.color}`} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold">{task.title}</div>
                          <div className={`mt-1 text-xs ${muted}`}>{task.meta}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function WorkflowShowcase({
  mode,
}: {
  mode: Mode;
}) {
  const isDark = mode === "dark";

  return (
    <section className={`${isDark ? "bg-[#101412] text-[#f3f0e7]" : "bg-white text-[#14251f]"}`}>
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8 lg:px-10">
        <h2 className="text-center text-3xl font-semibold leading-tight sm:text-4xl">
          Use it in your phone as PWA
        </h2>
        <div className="mx-auto mt-10 grid max-w-4xl items-start gap-4 sm:grid-cols-3 lg:mt-12">
          {remoteFeatureScreenshots.map((screenshot, index) => (
            <figure
              className={`overflow-hidden rounded-lg border shadow-[0_24px_70px_rgba(20,37,31,0.14)] ${
                isDark ? "border-white/10 bg-[#191d1a]" : "border-[#14251f]/10 bg-white"
              } ${index === 0 ? "sm:translate-y-12 lg:translate-y-20" : index === 1 ? "sm:translate-y-0 lg:translate-y-4" : "sm:translate-y-12 lg:translate-y-20"}`}
              key={screenshot.src}
            >
              <img
                className="block aspect-[9/18] w-full object-cover object-top"
                src={screenshot.src}
                alt={screenshot.alt}
              />
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="border-t border-white/10 bg-[#14251f] text-white">
      <div className="mx-auto grid max-w-7xl gap-8 px-5 py-14 sm:px-8 lg:grid-cols-[1fr_auto] lg:items-center lg:px-10">
        <div>
          <p className="mb-3 inline-flex items-center gap-2 rounded-md bg-white/10 px-3 py-2 text-sm font-semibold text-[#bff1e4]">
            <Play className="h-4 w-4" aria-hidden="true" />
            Ready for self-hosted automation
          </p>
          <h2 className="text-3xl font-semibold leading-tight sm:text-4xl">
            Put your coding agents online for yourself.
          </h2>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-white/70">
            Clone Luma Assistant, connect Codex and Claude Code, deploy it on a server, and use plan mode,
            MCP, skills, agents, cron-style jobs, and terminal access from one application.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
          <a
            className="inline-flex items-center justify-center gap-2 rounded-md bg-[#e0a526] px-5 py-3 text-sm font-semibold text-[#14251f] transition hover:bg-white"
            href={repoUrl}
          >
            <Github className="h-4 w-4" aria-hidden="true" />
            Open GitHub
          </a>
          <a
            className="inline-flex items-center justify-center gap-2 rounded-md border border-white/15 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
            href={readmeUrl}
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            Setup guide
          </a>
        </div>
      </div>
    </section>
  );
}

export default App;
