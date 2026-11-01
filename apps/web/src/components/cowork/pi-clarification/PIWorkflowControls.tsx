import { useEffect, useState } from "react";
import type { PICaseDetail, PISettings } from "@luma/shared";
import { piRequest } from "../../../lib/api";

const button =
  "rounded-md border border-card-border bg-control px-3 py-2 text-sm disabled:opacity-40";
const input =
  "w-full rounded-md border border-card-border bg-control px-3 py-2 text-sm";
type RecordView = {
  id: string;
  state: string;
  summary: string;
  paths: string[];
  checks: { command: string[]; passed: boolean }[];
  error: string | null;
  prUrl: string | null;
};
type RepoView = {
  id: string;
  implementationAllowed: boolean;
  validationConfigured: boolean;
};
type Reviewed = {
  sourceDigest: string;
  reviewed: { summary: string; current: boolean } | null;
};
type Act = (fn: () => Promise<unknown>, message?: string) => Promise<void>;

export function PIWorkflowControls({
  detail,
  settings,
  busy,
  act,
}: {
  detail: PICaseDetail;
  settings: PISettings | null;
  busy: boolean;
  act: Act;
}) {
  const [summary, setSummary] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [source, setSource] = useState(""),
    [current, setCurrent] = useState(false);
  const [repos, setRepos] = useState<RepoView[]>([]),
    [repo, setRepo] = useState(""),
    [records, setRecords] = useState<RecordView[]>([]),
    [diff, setDiff] = useState(""),
    [reviewedId, setReviewedId] = useState("");
  const [loadError, setLoadError] = useState("");
  const [diffId, setDiffId] = useState("");
  const caseId = detail.case.id;
  useEffect(() => {
    let active = true;
    Promise.all([
      piRequest<Reviewed>(`/cases/${caseId}/model-input`),
      piRequest<RepoView[]>("/repositories"),
      piRequest<RecordView[]>(`/cases/${caseId}/implementations`),
    ])
      .then(([model, repositoryList, implementationList]) => {
        if (!active) return;
        setSource(model.sourceDigest);
        setSummary(model.reviewed?.summary || "");
        setCurrent(Boolean(model.reviewed?.current));
        setConfirmed(false);
        setRepos(repositoryList);
        setRecords(implementationList);
        setLoadError("");
      })
      .catch(() => {
        if (active)
          setLoadError("Could not load PI workflow controls. Reload the case.");
      });
    return () => {
      active = false;
    };
  }, [
    caseId,
    detail.messages.length,
    detail.case.specVersion,
    detail.events.length,
  ]);
  useEffect(() => {
    setRepo("");
    setDiff("");
    setReviewedId("");
  }, [caseId]);
  if (detail.case.demo) return null;
  const candidates = detail.handoffs.at(-1)?.repositoryCandidates || [];
  return (
    <div className="space-y-4">
      {loadError ? <p role="alert">{loadError}</p> : null}
      {settings?.modelInputMode === "reviewed_summary" ? (
        <section className="space-y-2 rounded border border-card-border p-3">
          <h3 className="font-medium">Reviewed AI input</h3>
          <p className="text-sm">
            Write the business problem and expected behavior. Remove patient
            names, dates of service, other identifiers and credentials. Only
            this reviewed summary enters AI thread context. New messages or
            specification changes require another review.
          </p>
          <label className="block text-sm">
            De-identified summary
            <textarea
              aria-label="De-identified summary"
              className={input}
              rows={6}
              value={summary}
              onChange={(e) => {
                setSummary(e.target.value);
                setCurrent(false);
              }}
            />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I reviewed the latest thread and specification and removed
            identifying details from this summary.
          </label>
          <button
            className={button}
            disabled={
              busy || !confirmed || summary.trim().length < 20 || !source
            }
            onClick={() =>
              void act(async () => {
                await piRequest(`/cases/${caseId}/model-input`, {
                  method: "PUT",
                  body: JSON.stringify({
                    summary,
                    deidentifiedConfirmed: true,
                    sourceDigest: source,
                  }),
                });
                setCurrent(true);
              }, "Reviewed input saved. Request an agent draft to analyze it.")
            }
          >
            Save reviewed input
          </button>
          <p className="text-xs">
            {current
              ? "Current reviewed input is available."
              : "AI needs a review of the latest case."}{" "}
            Provider-agreement settings are unchanged. Raw emails and
            attachments are excluded.
          </p>
        </section>
      ) : null}
      <section className="space-y-2 rounded border border-card-border p-3">
        <h3 className="font-medium">Implementation and draft PR</h3>
        <p className="text-sm">
          Requires an approved task, a current reviewed summary and configured
          repository checks. Changes are validated in an isolated checkout
          without network or deployment credentials. The agent cannot merge,
          deploy or dispatch workflows.
        </p>
        <label className="block text-sm">
          Repository
          <select
            className={input}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          >
            <option value="">Select an approved repository</option>
            {repos
              .filter(
                (r) => r.implementationAllowed && candidates.includes(r.id),
              )
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                  {r.validationConfigured ? "" : " — validation setup needed"}
                </option>
              ))}
          </select>
        </label>
        <button
          className={button}
          disabled={busy || !repo || !candidates.length}
          onClick={() =>
            void act(
              () =>
                piRequest(`/cases/${caseId}/implementations`, {
                  method: "POST",
                  body: JSON.stringify({ repository: repo }),
                }),
              "Implementation job queued; no deployment is authorized",
            )
          }
        >
          Generate and validate changes
        </button>
        {!candidates.length ? (
          <p className="text-xs">
            No approved implementation task yet. Verified client scope approval
            is still required.
          </p>
        ) : null}
        {records.map((r) => (
          <article
            className="space-y-2 rounded border border-card-border p-3"
            key={r.id}
          >
            <p>
              {r.state}: {r.summary || "Implementation job"}
            </p>
            <p className="break-words text-xs">{r.paths.join(", ")}</p>
            {r.checks.map((check, i) => (
              <p className="text-xs" key={i}>
                {check.passed ? "Passed" : "Failed"}: {check.command.join(" ")}
              </p>
            ))}
            {r.error ? (
              <p role="alert" className="text-sm">
                {r.error}
              </p>
            ) : null}
            {r.prUrl ? (
              <a
                className="underline"
                href={r.prUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open draft PR
              </a>
            ) : null}
            {r.state === "ready" ? (
              <>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setDiff(
                        await piRequest<string>(
                          `/implementations/${r.id}/diff`,
                        ),
                      );
                      setDiffId(r.id);
                      setReviewedId("");
                    }, "Review the diff before publishing")
                  }
                >
                  Review diff
                </button>
                {diff && diffId === r.id ? (
                  <>
                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
                      {diff}
                    </pre>
                    <label className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={reviewedId === r.id}
                        onChange={(e) =>
                          setReviewedId(e.target.checked ? r.id : "")
                        }
                      />
                      I reviewed these changes and their validation results.
                    </label>
                  </>
                ) : null}
                <button
                  className={button}
                  disabled={busy || reviewedId !== r.id}
                  onClick={() =>
                    void act(
                      () =>
                        piRequest(`/implementations/${r.id}/publish`, {
                          method: "POST",
                          body: JSON.stringify({ codeReviewed: true }),
                        }),
                      "Draft PR publication checked; no deployment authorized",
                    )
                  }
                >
                  Create draft PR
                </button>
              </>
            ) : null}
          </article>
        ))}
      </section>
    </div>
  );
}
