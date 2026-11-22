import { useEffect, useState, type ReactNode } from "react";
import { Cloud, FolderPlus, Laptop, LoaderCircle, Settings2, Trash2, X } from "lucide-react";
import { setActiveWorkspace } from "../lib/api";
import type { DesktopState } from "../lib/desktop";
import { DesktopRemoteSettings } from "./DesktopRemoteSettings";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function DesktopShell({ children }: { children: ReactNode }) {
  const bridge = window.lumaDesktop;
  const [state, setState] = useState<DesktopState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cloudUrl, setCloudUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!bridge) return;
    document.body.classList.add("luma-desktop");
    let cancelled = false;
    const refresh = () => bridge.getState().then(next => {
      if (cancelled) return;
      setState(next);
      setCloudUrl(current => current || next.cloudUrl);
    }).catch(reason => { if (!cancelled) setError(String(reason)); });
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2000);
    return () => { cancelled = true; window.clearInterval(interval); document.body.classList.remove("luma-desktop"); };
  }, [bridge]);

  if (!bridge) return children;

  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : String(reason)); }
    finally { setBusy(false); }
  }

  async function chooseFolder() {
    const folder = await bridge!.chooseFolder();
    if (!folder) return;
    await setActiveWorkspace(folder);
    window.location.reload();
  }

  const isLocal = bridge.isLocal;
  const ready = state?.engine.status === "ready";
  const needsFolder = isLocal && ready && state?.folders.length === 0;
  const starting = isLocal && !ready;
  const engine = state?.engine;
  const cursorLogin = engine?.cursorHome && engine.cursorData && engine.cursorPath
    ? `HOME=${shellQuote(engine.cursorHome)} AGENT_CLI_CREDENTIAL_STORE=file CURSOR_CONFIG_DIR=${shellQuote(engine.cursorHome)} CURSOR_DATA_DIR=${shellQuote(engine.cursorData)} ${shellQuote(engine.cursorPath)} --disable-auto-update login` : "";

  return (
    <div className="desktop-container">
      <div className="desktop-toolbar">
        <span className="desktop-wordmark">Luma <span>Desktop</span></span>
        <div className="desktop-modes" aria-label="Execution environment">
          <button type="button" aria-pressed={isLocal} disabled={busy || isLocal} onClick={() => void perform(() => bridge.switchConnection("local"))}><Laptop size={15} />This Mac</button>
          <button type="button" aria-pressed={!isLocal} disabled={busy || !isLocal} onClick={() => state?.cloudUrl ? void perform(() => bridge.switchConnection("cloud", state.cloudUrl)) : setSettingsOpen(true)}><Cloud size={15} />Cloud</button>
        </div>
        <span className="desktop-environment" title={isLocal ? "Sessions execute on this Mac" : state?.cloudUrl}>{isLocal ? (ready ? "Local engine ready" : state?.engine.status === "error" ? "Local engine stopped" : "Starting local engine…") : state?.cloudUrl || "Luma cloud"}</span>
        {isLocal ? <button type="button" className="desktop-control" disabled={busy || !ready} onClick={() => void perform(chooseFolder)}><FolderPlus size={15} />Add folder</button> : null}
        <button type="button" className="desktop-control" onClick={() => setSettingsOpen(!settingsOpen)} aria-expanded={settingsOpen} aria-label="Desktop settings"><Settings2 size={17} /></button>
      </div>

      {settingsOpen ? (
        <div className="desktop-settings" role="dialog" aria-label="Desktop settings">
          <div className="desktop-settings-heading"><h2>Desktop settings</h2><button type="button" onClick={() => setSettingsOpen(false)} aria-label="Close desktop settings"><X size={18} /></button></div>
          <form onSubmit={event => { event.preventDefault(); void perform(() => bridge.switchConnection("cloud", cloudUrl)); }}>
            <label htmlFor="luma-cloud-url">Luma cloud URL</label>
            <input id="luma-cloud-url" type="url" required placeholder="https://luma.example.com" value={cloudUrl} onChange={event => setCloudUrl(event.target.value)} />
            <p>Connect to your existing server, then sign in with its password. Cloud workspaces stay on that server.</p>
            <button type="submit" className="desktop-primary" disabled={busy || !cloudUrl.trim()}><Cloud size={15} />Connect to cloud</button>
          </form>
          {state?.remote ? (
            <DesktopRemoteSettings
              state={state} bridge={bridge} cloudUrl={cloudUrl} busy={busy} perform={perform}
              onChange={remote => setState(current => current ? { ...current, remote } : current)}
            />
          ) : null}
          {isLocal ? <section>
            <h3>Enabled folders on this Mac</h3>
            <p>Local sessions use a filesystem sandbox for the selected folder. Model requests still use the internet.</p>
            {state?.folders.map(folder => <div className="desktop-folder" key={folder}><span title={folder}>{folder}</span><button type="button" disabled={busy} onClick={() => void perform(async () => { await bridge.removeFolder(folder); window.location.reload(); })} aria-label={`Remove ${folder}`}><Trash2 size={15} /></button></div>)}
            <button type="button" className="desktop-control" disabled={busy || !ready} onClick={() => void perform(chooseFolder)}><FolderPlus size={15} />Enable another folder</button>
          </section> : null}
          {isLocal && ready ? <section>
            <h3>Local runners</h3>
            <p>Run the matching command in Terminal if a runner asks you to sign in. Install any missing CLI and reopen Luma.</p>
            <ul className="space-y-3 text-xs">
              <li>Codex · {engine?.codexPath ? "Installed" : "CLI missing"}
                {engine?.codexPath && !engine.authAvailable ? <div className="mt-1 opacity-80">Sign in with the Codex CLI, then reopen Luma to import the login.</div> : null}
              </li>
              <li>Claude Code · {engine?.claudePath ? "Installed" : "CLI missing"}
                {engine?.claudePath ? <div className="mt-1 opacity-80" title={engine.claudeHome}>Uses your Claude Code profile. To sign in, run <code>claude auth login</code> in Terminal.</div> : null}
              </li>
              <li>Cursor Agent · {engine?.cursorPath ? "Installed" : "CLI missing"}
                {cursorLogin ? <code className="mt-1 block select-all break-all rounded bg-control p-2">{cursorLogin}</code> : null}
              </li>
            </ul>
          </section> : null}
          <p>Local sessions continue when you switch to Cloud or close the window. Quitting Luma stops the local engine. Your Mac must be awake for local work.</p>
          {error ? <div className="desktop-error" role="alert">{error}</div> : null}
        </div>
      ) : null}

      {error && !settingsOpen ? <div className="desktop-error desktop-error-banner" role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button></div> : null}

      <div className="desktop-app">
        {starting || needsFolder ? <div className="desktop-onboarding">
          <div className="desktop-onboarding-card">
            {starting ? <>
              {state?.engine.status === "error" ? <Laptop size={30} /> : <LoaderCircle size={30} className="animate-spin" />}
              <h1>{state?.engine.status === "error" ? "Local engine needs attention" : "Starting Luma on this Mac"}</h1>
              <p>{state?.engine.error || "Preparing your private local session service…"}</p>
              {state?.engine.status === "error" ? <button type="button" className="desktop-primary" disabled={busy} onClick={() => void perform(() => bridge.retryLocal())}>Retry local engine</button> : null}
            </> : <>
              <FolderPlus size={32} />
              <h1>Choose a folder to work in</h1>
              <p>Enable a project folder to start your first local session. Your local conversations and cloud conversations are stored separately.</p>
              <button type="button" className="desktop-primary" disabled={busy} onClick={() => void perform(chooseFolder)}><FolderPlus size={17} />Choose folder</button>
              <button type="button" className="desktop-control" onClick={() => setSettingsOpen(true)}><Cloud size={16} />Connect to Luma cloud</button>
            </>}
          </div>
        </div> : children}
      </div>
    </div>
  );
}
