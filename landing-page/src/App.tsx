import { useMemo, useState } from "react";
import {
  Bot,
  ChevronRight,
  Github,
  Layers3,
  MessageSquareText,
  Moon,
  Network,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Sun,
  TerminalSquare,
} from "lucide-react";

type Mode = "light" | "dark";

const repoUrl = "https://github.com/mertz1999/luma-assistant";
const readmeUrl = `${repoUrl}#readme`;
const baseUrl = import.meta.env.BASE_URL;

const screenshots = {
  light: {
    desktop: `${baseUrl}screenshots/desktop-light.png`,
    mobile: `${baseUrl}screenshots/mobile-light.png`,
  },
  dark: {
    desktop: `${baseUrl}screenshots/desktop-dark.png`,
    mobile: `${baseUrl}screenshots/mobile-dark.png`,
  },
};

const highlights = [
  ["Daily agents", "Run Tehran-time jobs from repo prompts"],
  ["Skills sync", "Publish managed Codex skills safely"],
  ["MCP view", "See tools, Telegram, TickTick, and web calls"],
  ["Sessions", "Open any scheduled run like a normal chat"],
];

const featureRows = [
  {
    icon: Bot,
    title: "Agent routines that feel native",
    text: "Create repo-owned agents, schedule them for Tehran time, and let every execution land in the same chat history as manual Codex work.",
  },
  {
    icon: MessageSquareText,
    title: "Telegram-ready outcomes",
    text: "Ask agents to produce clean Markdown summaries and send them through the Telegram MCP server with formatting intact.",
  },
  {
    icon: Layers3,
    title: "Skill sync without surprises",
    text: "Copy managed repo skills into Codex home, update your own managed copies, and surface conflicts instead of overwriting local work.",
  },
  {
    icon: Network,
    title: "MCP tools in plain sight",
    text: "Watch TickTick, Telegram, web search, shell commands, diffs, approvals, and terminal work flow through one timeline.",
  },
  {
    icon: TerminalSquare,
    title: "Operator-grade workspace",
    text: "Use persistent sessions, per-session terminals, queued prompts, model defaults, sandbox controls, and visible run state.",
  },
  {
    icon: ShieldCheck,
    title: "Self-hosted by design",
    text: "Run on your own host with password auth, PM2 process names, Nginx examples, private data files, and GitHub Pages docs.",
  },
];

const workflow = [
  {
    title: "Write an agent once",
    text: "Store the prompt in AGENT.md with optional frontmatter for name and description.",
  },
  {
    title: "Schedule or trigger it",
    text: "Snapshot workspace, model, sandbox, approval policy, and selected skills at schedule creation.",
  },
  {
    title: "Inspect every run",
    text: "Failed, skipped, running, and completed executions stay visible with linked sessions.",
  },
  {
    title: "Ship the result",
    text: "Send a polished Telegram digest or keep working in the normal Codex chat viewer.",
  },
];

function App() {
  const [mode, setMode] = useState<Mode>("dark");
  const activeScreenshots = screenshots[mode];
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
      <Hero mode={mode} setMode={setMode} activeScreenshots={activeScreenshots} />
      <ProofStrip />
      <FeatureGrid />
      <WorkflowShowcase mode={mode} activeScreenshots={activeScreenshots} />
      <FinalCta />
    </main>
  );
}

function Hero({
  mode,
  setMode,
  activeScreenshots,
}: {
  mode: Mode;
  setMode: (mode: Mode) => void;
  activeScreenshots: { desktop: string; mobile: string };
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
              Your Codex workspace, on schedule
            </p>
            <h1 className="max-w-xl text-5xl font-semibold leading-none sm:text-6xl lg:text-7xl">
              Luma Assistant
            </h1>
            <p className={`mt-6 max-w-xl text-lg leading-8 ${isDark ? "text-white/70" : "text-[#14251f]/70"}`}>
              A self-hosted application for running Codex like an operating desk: agents, Tehran-time schedules, repo
              skills, MCP tools, terminals, history, and Telegram delivery in one focused UI.
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
            <div className="mt-8 grid max-w-xl grid-cols-2 gap-3">
              {highlights.map(([title, text]) => (
                <div
                  className={`rounded-lg border p-4 ${
                    isDark ? "border-white/10 bg-white/10" : "border-[#14251f]/10 bg-white/70"
                  }`}
                  key={title}
                >
                  <p className="text-sm font-semibold">{title}</p>
                  <p className={`mt-1 text-xs leading-5 ${isDark ? "text-white/60" : "text-[#14251f]/60"}`}>{text}</p>
                </div>
              ))}
            </div>
          </div>

          <ProductStage mode={mode} activeScreenshots={activeScreenshots} />
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

function ProductStage({
  mode,
  activeScreenshots,
}: {
  mode: Mode;
  activeScreenshots: { desktop: string; mobile: string };
}) {
  const isDark = mode === "dark";

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
          className={`overflow-hidden rounded-lg border shadow-[0_34px_90px_rgba(0,0,0,0.24)] ${
            isDark ? "border-white/10 bg-[#191d1a]" : "border-[#14251f]/10 bg-white"
          }`}
        >
          <img
            className="block aspect-[2876/1550] w-full object-cover object-top"
            src={activeScreenshots.desktop}
            alt={`Luma Assistant desktop ${mode} mode interface`}
          />
        </div>
        <div
          className={`absolute bottom-[-9%] right-[3%] hidden w-[24%] overflow-hidden rounded-lg border shadow-[0_28px_80px_rgba(0,0,0,0.28)] sm:block ${
            isDark ? "border-white/10 bg-[#191d1a]" : "border-white bg-white"
          }`}
        >
          <img
            className="block aspect-[830/1557] w-full object-cover object-top"
            src={activeScreenshots.mobile}
            alt={`Luma Assistant mobile ${mode} mode interface`}
          />
        </div>
      </div>
    </div>
  );
}

function ProofStrip() {
  return (
    <section className="border-y border-[#14251f]/10 bg-white text-[#14251f]">
      <div className="mx-auto grid max-w-7xl gap-4 px-5 py-6 sm:grid-cols-2 sm:px-8 lg:grid-cols-4 lg:px-10">
        {[
          ["Asia/Tehran", "Daily schedule timezone"],
          ["luma-tel", "Telegram MCP server"],
          ["~/.codex/skills", "Managed skill target"],
          ["data/", "Private runtime history"],
        ].map(([label, text]) => (
          <div className="rounded-lg border border-[#14251f]/10 bg-[#f5f4ef] p-4" key={label}>
            <p className="text-lg font-semibold">{label}</p>
            <p className="mt-1 text-sm text-[#14251f]/60">{text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function FeatureGrid() {
  return (
    <section className="bg-[#f5f4ef] text-[#14251f]">
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8 lg:px-10">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold text-[#2f6f5e]">Built for real assistant operations</p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
            Not a chat demo. A workspace for recurring work.
          </h2>
          <p className="mt-4 text-base leading-7 text-[#14251f]/70">
            Luma Assistant makes the recurring parts of Codex work visible and repeatable while keeping every scheduled
            run inspectable in normal session history.
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

function WorkflowShowcase({
  mode,
  activeScreenshots,
}: {
  mode: Mode;
  activeScreenshots: { desktop: string; mobile: string };
}) {
  const isDark = mode === "dark";

  return (
    <section className={`${isDark ? "bg-[#101412] text-[#f3f0e7]" : "bg-white text-[#14251f]"}`}>
      <div className="mx-auto grid max-w-7xl gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[0.92fr_1.08fr] lg:px-10">
        <div>
          <p className={`text-sm font-semibold ${isDark ? "text-[#8ce4cd]" : "text-[#2f6f5e]"}`}>From prompt to delivery</p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
            Schedule the work, then inspect the exact session.
          </h2>
          <div className="mt-8 space-y-4">
            {workflow.map((item, index) => (
              <div
                className={`grid grid-cols-[2.4rem_1fr] gap-4 rounded-lg border p-4 ${
                  isDark ? "border-white/10 bg-white/10" : "border-[#14251f]/10 bg-[#f5f4ef]"
                }`}
                key={item.title}
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#2f8f7e] text-sm font-bold text-white">
                  {index + 1}
                </div>
                <div>
                  <h3 className="font-semibold">{item.title}</h3>
                  <p className={`mt-1 text-sm leading-6 ${isDark ? "text-white/60" : "text-[#14251f]/60"}`}>
                    {item.text}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-[0.72fr_0.28fr]">
          <div
            className={`overflow-hidden rounded-lg border ${
              isDark ? "border-white/10 bg-[#191d1a]" : "border-[#14251f]/10 bg-white"
            }`}
          >
            <img
              className="block aspect-[2876/1550] h-full w-full object-cover object-left-top"
              src={activeScreenshots.desktop}
              alt={`Desktop ${mode} mode session history`}
            />
          </div>
          <div
            className={`overflow-hidden rounded-lg border ${
              isDark ? "border-white/10 bg-[#191d1a]" : "border-[#14251f]/10 bg-white"
            }`}
          >
            <img
              className="block aspect-[830/1557] h-full w-full object-cover object-top"
              src={activeScreenshots.mobile}
              alt={`Mobile ${mode} mode session view`}
            />
          </div>
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
            Give Codex a schedule, a skill set, and a delivery channel.
          </h2>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-white/70">
            Clone Luma Assistant, connect Codex and Telegram, add your own agents, and keep recurring assistant work
            visible from the same application.
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
