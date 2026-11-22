import { createContext, useContext, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CursorModelInfo, ReasoningEffort, RunRunner, RunnerModelCatalogs } from "@luma/shared";
import { getModelCatalogs } from "./api";

const fallbackEfforts: Record<RunRunner, ReasoningEffort[]> = {
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  cursor: ["low", "medium", "high"],
};
const cursorFallback = ["composer-2.5", "auto", "gpt-5.3-codex", "claude-opus-4-6", "claude-sonnet-4-6", "gemini-3.1-pro"];

export function createModelOptions(catalogs?: RunnerModelCatalogs) {
  const find = (runner: RunRunner, model?: string) => runner === "cursor" ? undefined : catalogs?.[runner].models.find(m => m.id === model || m.resolvedModel === model);
  return {
    modelOptionsForRunner(runner: RunRunner, cursorModels: CursorModelInfo[] = []): string[] {
      if (runner === "cursor") return cursorModels.length ? cursorModels.map(m => m.id) : cursorFallback;
      return catalogs?.[runner].models.map(m => m.id) ?? (runner === "claude" ? ["sonnet", "opus", "haiku"] : ["gpt-5.6-sol"]);
    },
    reasoningEffortOptionsForRunner(runner: RunRunner, model?: string): ReasoningEffort[] {
      const supported = find(runner, model)?.supportedEfforts;
      return supported?.length ? supported : fallbackEfforts[runner];
    },
    modelSupportsEffort(runner: RunRunner, model: string): boolean {
      return find(runner, model)?.supportsEffort !== false;
    },
    effortForModel(runner: RunRunner, model: string, current: ReasoningEffort): ReasoningEffort {
      const info = find(runner, model);
      const supported = info?.supportedEfforts?.length ? info.supportedEfforts : fallbackEfforts[runner];
      return supported.includes(current) ? current : info?.defaultEffort && supported.includes(info.defaultEffort)
        ? info.defaultEffort : supported.includes("high") ? "high" : supported[0];
    },
    modelLabel(runner: RunRunner, id: string): string {
      const model = find(runner, id);
      if (!model) return id;
      // Show the resolved version so aliases such as "sonnet" reveal new releases.
      return model.resolvedModel && model.resolvedModel !== model.id
        ? `${model.displayName} · ${model.resolvedModel}` : model.displayName;
    },
  };
}

export function useModelCatalogState(enabled: boolean) {
  const client = useQueryClient();
  const [refreshingRunner, setRefreshingRunner] = useState<"codex" | "claude" | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["runner-model-catalogs"],
    queryFn: () => getModelCatalogs(),
    enabled,
    staleTime: 30_000,
    retry: false,
    refetchInterval: q => q.state.data?.codex.refreshing || q.state.data?.claude.refreshing ? 2000 : 60_000,
  });
  const refresh = async (runner: "codex" | "claude") => {
    if (refreshingRunner) return;
    setRefreshingRunner(runner);
    setRefreshError(null);
    try { client.setQueryData(["runner-model-catalogs"], await getModelCatalogs(runner)); }
    catch (error) { setRefreshError(error instanceof Error ? error.message : "Could not refresh models."); }
    finally { setRefreshingRunner(null); }
  };
  return { catalogs: query.data, refreshingRunner, refresh, error: refreshError || (query.error ? "Could not load models. Your current selection is preserved." : null) };
}

type State = ReturnType<typeof useModelCatalogState>;
export const ModelCatalogContext = createContext<State>({ catalogs: undefined, refreshingRunner: null, refresh: async () => {}, error: null });
export function useModelOptions(override?: State) {
  const context = useContext(ModelCatalogContext);
  const catalogs = (override || context).catalogs;
  return useMemo(() => createModelOptions(catalogs), [catalogs]);
}

export function ModelCatalogRefresh({ runner, compact = false }: { runner: RunRunner; compact?: boolean }): JSX.Element | null {
  const state = useContext(ModelCatalogContext);
  if (runner === "cursor") return null;
  const item = state.catalogs?.[runner];
  const busy = state.refreshingRunner === runner || item?.refreshing;
  const details = [item?.cliVersion, item?.updatedAt ? `Updated ${new Date(item.updatedAt).toLocaleString()}` : "Models have not been discovered yet", item?.error || state.error].filter(Boolean).join(". ");
  return <button type="button" className="shrink-0 rounded px-1.5 py-1 text-[11px] text-brand hover:bg-control-hover disabled:opacity-60" disabled={!!state.refreshingRunner || busy} title={details} aria-label={`Refresh ${runner === "codex" ? "Codex" : "Claude"} models`} onClick={() => void state.refresh(runner)}>
    {busy ? "Refreshing…" : compact ? "↻ Models" : "Refresh models"}
  </button>;
}

export function ModelCatalogNotice({ runner }: { runner: RunRunner }): JSX.Element | null {
  const state = useContext(ModelCatalogContext);
  if (runner === "cursor") return null;
  const item = state.catalogs?.[runner];
  const error = item?.error || state.error;
  if (error) return <p role="status" className="mt-1 text-xs text-amber-700 dark:text-amber-300">{item?.source === "cache" ? "Using saved models. " : "Model discovery unavailable. "}{error}</p>;
  if (item?.source === "cache") return <p className="mt-1 text-xs text-foreground/60">Using saved models{item.refreshing ? "; checking for updates…" : "."}</p>;
  return null;
}

export function ModelEffortOptions({ runner, model, value }: { runner: RunRunner; model: string; value: ReasoningEffort }): JSX.Element {
  const { reasoningEffortOptionsForRunner } = useModelOptions();
  const options = reasoningEffortOptionsForRunner(runner, model);
  return <>
    {!options.includes(value) ? <option value={value}>{value} (saved)</option> : null}
    {options.map(option => <option key={option} value={option}>{option === "xhigh" ? "extra high" : option}</option>)}
  </>;
}
