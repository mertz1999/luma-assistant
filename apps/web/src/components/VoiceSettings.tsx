import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { removeSpeechSettings, saveSpeechSettings, speechSettingsQueryKey, type SpeechSettings } from "@/lib/speech";

const fieldClass = "mt-1 w-full rounded-md border border-card-border bg-control px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

export function VoiceSettings({ open, setOpen, settings, loading }: {
  open: boolean;
  setOpen: (open: boolean) => void;
  settings: SpeechSettings | undefined;
  loading: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[90] max-h-[calc(100dvh-24px)] w-[min(460px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-card-border bg-surface-1 p-5 shadow-xl outline-none">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-base font-semibold">Voice settings</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-foreground/65">Recordings go to this provider when you stop recording. Review the transcript before sending.</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" className="w-7 shrink-0 p-0" aria-label="Close voice settings"><X className="h-4 w-4" /></Button>
            </Dialog.Close>
          </div>
          {loading ? <p role="status" className="text-sm">Loading voice settings…</p> : (
            <ProviderForm key={`${settings?.baseUrl}:${settings?.model}`} settings={settings} onSaved={() => setOpen(false)} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ProviderForm({ settings, onSaved }: { settings?: SpeechSettings; onSaved: () => void }) {
  const client = useQueryClient();
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl || "");
  const [model, setModel] = useState(settings?.model || "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canReuseKey = settings?.configured && baseUrl.trim().replace(/\/+$/, "") === settings.baseUrl;

  async function update(operation: () => Promise<SpeechSettings>) {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const saved = await operation();
      client.setQueryData(speechSettingsQueryKey, saved);
      onSaved();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Unable to update voice settings.");
    } finally { setBusy(false); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void update(() => saveSpeechSettings({ baseUrl, model, apiKey }));
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <label className="block text-sm">
        Base URL
        <input className={fieldClass} type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required maxLength={2048} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} />
      </label>
      <label className="block text-sm">
        Model
        <input className={fieldClass} value={model} onChange={(event) => setModel(event.target.value)} required maxLength={200} placeholder="openai/whisper-large-v3" autoComplete="off" spellCheck={false} />
      </label>
      <label className="block text-sm">
        API key
        <input className={fieldClass} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required={!canReuseKey} maxLength={4096} placeholder={canReuseKey ? "Key saved. Enter a new one to replace it." : "Enter your provider API key"} autoComplete="new-password" />
      </label>
      {error ? <p role="alert" className="text-sm text-danger-fg">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save provider"}</Button>
        {settings?.configured ? <Button type="button" variant="ghost" disabled={busy} onClick={() => void update(removeSpeechSettings)}>Remove provider</Button> : null}
      </div>
    </form>
  );
}
