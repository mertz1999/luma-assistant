import { createContext, useContext, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getProjects } from "./projects-api";
import type { Project } from "@luma/shared";

export type ProjectPanelState = { tab: "memory" | "activity" | "settings" | "create"; projectId: string | null } | null;
export function useProjectState(enabled: boolean) {
  const client = useQueryClient();
  const [panel, setPanel] = useState<ProjectPanelState>(null);
  const query = useQuery({ queryKey: ["projects"], queryFn: getProjects, enabled, refetchInterval: enabled ? 30_000 : false, retry: 1 });
  const invalidate = () => { void client.invalidateQueries({ queryKey: ["projects"] }); void client.invalidateQueries({ queryKey: ["project-memory"] }); };
  const acceptProject = (project: Project) => client.setQueryData<{ projects: Project[] }>(["projects"], current => ({ projects: [project, ...(current?.projects || []).filter(item => item.id !== project.id)] }));
  return { projects: query.data?.projects || [], loading: query.isLoading, error: query.error, panel, setPanel, invalidate, acceptProject };
}
export type ProjectUiState = ReturnType<typeof useProjectState> & {
  setDraftProject: (projectId: string | null) => void;
  startProjectDraft: (projectId: string) => void;
  currentProjectId: string | null;
  selectedSessionId: string | null;
  selectedRunId: string | null;
  onMoveSession: (projectId: string | null) => Promise<void>;
};
export const ProjectsContext = createContext<ProjectUiState | null>(null);
export function useProjects(): ProjectUiState {
  const value = useContext(ProjectsContext);
  if (!value) throw new Error("Project controls require a project context.");
  return value;
}
