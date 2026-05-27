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
  ["Remote Codex", "Use your Codex CLI from any browser"],
  ["Cron jobs", "Run specific work at specific moments"],
  ["Sandbox terminal", "Open a controlled terminal from your phone"],
  ["Core Codex", "Plan mode, MCP, AGENTS.md, agents, and history"],
];

const featureRows = [
  {
    icon: Bot,
    title: "Connect to your Codex CLI",
    text: "Use the Codex CLI you already trust, but from a persistent web application with sessions, approvals, history, and live tool output.",
  },
  {
    icon: MessageSquareText,
    title: "Install it on a server",
    text: "Run Luma Assistant on your own server, put it behind HTTPS, and reach your Codex workspace anywhere you have the URL.",
  },
  {
    icon: Layers3,
    title: "Cron-style assistant jobs",
    text: "Create scheduled jobs for specific recurring work, then open every result as a normal Codex session with messages and status.",
  },
  {
    icon: Network,
    title: "MCP tools in plain sight",
    text: "Keep MCP calls visible beside shell commands, web searches, file changes, diffs, approvals, and assistant responses.",
  },
  {
    icon: TerminalSquare,
    title: "Sandbox terminal anywhere",
    text: "Open a per-session sandbox terminal from your laptop, phone, or another machine when you need direct command access.",
  },
  {
    icon: ShieldCheck,
    title: "Codex CLI core included",
    text: "Plan mode, MCP, workspace instructions like AGENTS.md, agents, skills, approvals, and session history stay available from the UI.",
  },
];

const workflow = [
  {
    title: "Connect your CLI",
    text: "Point Luma Assistant at Codex, authenticate once, and select the workspace you want to operate.",
  },
  {
    title: "Use it from a URL",
    text: "Install it on a server, protect it with auth and HTTPS, then open it from desktop or mobile.",
  },
  {
    title: "Automate recurring work",
    text: "Create cron-style jobs for specific tasks and inspect each execution in normal session history.",
  },
  {
    title: "Drop into terminal",
    text: "Use the sandbox terminal when you need hands-on command access from wherever you are.",
  },
];

function App() {
  const [mode, setMode] = useState<Mode>("light");
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
              Your Codex CLI, reachable by URL
            </p>
            <h1 className="max-w-xl text-5xl font-semibold leading-none sm:text-6xl lg:text-7xl">
              Luma Assistant
            </h1>
            <p className={`mt-6 max-w-xl text-lg leading-8 ${isDark ? "text-white/70" : "text-[#14251f]/70"}`}>
              A self-hosted web app for your Codex CLI. Install it on a server, open it from anywhere, schedule
              recurring work, use MCP and plan mode, and drop into a sandbox terminal when you need control.
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
          ["Codex CLI", "Connected through your own server"],
          ["Cron jobs", "Specific work at specific moments"],
          ["Terminal", "Sandbox access from desktop or phone"],
          ["MCP + Plan", "Core Codex features in the UI"],
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
          <p className="text-sm font-semibold text-[#2f6f5e]">Built for remote Codex work</p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
            Your Codex CLI becomes an application you can use anywhere.
          </h2>
          <p className="mt-4 text-base leading-7 text-[#14251f]/70">
            Luma Assistant keeps the core Codex CLI experience intact while adding a browser UI, server deployment,
            scheduled jobs, mobile-friendly terminal access, and persistent session history.
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
          <p className={`text-sm font-semibold ${isDark ? "text-[#8ce4cd]" : "text-[#2f6f5e]"}`}>From URL to terminal</p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
            Use Codex remotely without losing the CLI features.
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
            Put your Codex CLI online for yourself.
          </h2>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-white/70">
            Clone Luma Assistant, connect your Codex CLI, deploy it on a server, and use plan mode, MCP, agents,
            cron-style jobs, and sandbox terminal access from one application.
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
