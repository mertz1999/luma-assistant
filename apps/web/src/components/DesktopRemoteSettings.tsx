import { useState } from "react";
import type { DesktopBridge, DesktopState } from "../lib/desktop";

const statusLabels = {
  unpaired: "Not paired",
  unavailable: "Pairing credentials unavailable",
  connecting: "Connecting",
  online: "Online",
  offline: "Offline",
  revoked: "Pairing revoked",
};

export function DesktopRemoteSettings({
  state, cloudUrl, bridge, busy, perform, onChange,
}: {
  state: DesktopState;
  cloudUrl: string;
  bridge: DesktopBridge;
  busy: boolean;
  perform(action: () => Promise<unknown>): Promise<void>;
  onChange(remote: DesktopState["remote"]): void;
}) {
  const { remote } = state;
  const [code, setCode] = useState("");
  const [name, setName] = useState("My Mac");
  const [folders, setFolders] = useState<string[]>(remote.folders);
  const [canControl, setCanControl] = useState(remote.canControl);
  const selected = folders.filter(folder => state.folders.includes(folder));
  const canEdit = remote.status !== "revoked" && remote.status !== "unavailable";
  return (
    <section>
      <h3>Remote access</h3>
      <p role="status">{statusLabels[remote.status]}{remote.cloudUrl ? ` · ${remote.cloudUrl}` : ""}</p>
      {canEdit ? (
        <form className="space-y-2" onSubmit={event => {
          event.preventDefault();
          void perform(async () => {
            const result = remote.paired
              ? await bridge.configureRemote({ folders: selected, canControl })
              : await bridge.pairRemote({ cloudUrl, code, name, folders: selected });
            setCode("");
            setCanControl(result.canControl);
            onChange(result);
          });
        }}>
          {!remote.paired ? <>
            <p>In Luma Cloud, open Remote Macs and choose Pair a Mac. Paste the code here and select the folders to share.</p>
            <label htmlFor="luma-device-name">Device name</label>
            <input id="luma-device-name" value={name} maxLength={80} onChange={event => setName(event.target.value)} />
            <label htmlFor="luma-device-code">Pairing code</label>
            <input id="luma-device-code" value={code} autoComplete="off" spellCheck={false} required maxLength={26} onChange={event => setCode(event.target.value)} />
          </> : null}
          <fieldset className="min-w-0 space-y-1">
            <legend className="text-xs font-medium">Share sessions in these folders</legend>
            {state.folders.map(folder => (
              <label key={folder} className="flex items-start gap-2 break-all text-xs">
                <input className="mt-0.5 shrink-0" type="checkbox" checked={selected.includes(folder)}
                  onChange={event => setFolders(current => event.target.checked ? [...current, folder] : current.filter(item => item !== folder))} />
                {folder}
              </label>
            ))}
            {!state.folders.length ? <p>Enable a folder in This Mac first.</p> : null}
          </fieldset>
          {remote.paired ? <label className="flex items-start gap-2 text-xs">
            <input className="mt-0.5" type="checkbox" checked={canControl} onChange={event => setCanControl(event.target.checked)} />
            Allow sending messages and stopping runs from Luma Cloud
          </label> : null}
          <button className="desktop-primary" disabled={busy || !selected.length || (!remote.paired && (!cloudUrl.trim() || !code.trim()))}>
            {remote.paired ? "Save remote access" : "Pair this Mac"}
          </button>
        </form>
      ) : null}
      {remote.paired || remote.status === "unavailable" ? (
        <button type="button" className="desktop-control mt-2" disabled={busy} onClick={() => void perform(async () => {
          onChange(await bridge.unpairRemote());
          setFolders([]);
          setCanControl(false);
        })}>Unpair this Mac</button>
      ) : null}
    </section>
  );
}
