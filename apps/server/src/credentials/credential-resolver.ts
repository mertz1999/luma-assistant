import { evaluateCredentialAccessPolicy, type PolicyDecisionKind } from "../policy/policy-engine.js";
import { getCredentialMetadata, getCredentialValue } from "./credential-store.js";

/**
 * Ties the credential store and the policy engine together into the one
 * thing an execution actually needs: an environment fragment containing
 * only the credentials this specific project+adapter combination is
 * authorized to receive, plus a per-credential decision trail for the
 * audit log (logged by the caller -- this function itself does not touch
 * the audit log, keeping it a pure function of its inputs and testable
 * without faking that dependency).
 *
 * Adapters never fetch their own secrets: this is the ONLY place a secret
 * value is read off disk, and only for a credential that has already been
 * explicitly requested (RunConfig.requestedCredentials) and just passed
 * policy -- never an implicit, command-text-based lookup.
 */

export interface CredentialDecision {
  credentialId: string;
  decision: PolicyDecisionKind;
  reason: string;
  rule: string;
  /** The env var name this credential injects as, if it was found at all (even on deny, useful for audit context; never the value). */
  name: string | null;
}

export interface ResolveCredentialsInput {
  dataDir: string;
  projectId: string;
  adapter: string;
  credentialIds: string[];
}

export interface ResolveCredentialsResult {
  env: Record<string, string>;
  decisions: CredentialDecision[];
}

export function resolveAuthorizedCredentials(input: ResolveCredentialsInput): ResolveCredentialsResult {
  const env: Record<string, string> = {};
  const decisions: CredentialDecision[] = [];

  for (const credentialId of input.credentialIds) {
    const metadata = getCredentialMetadata(input.dataDir, input.projectId, credentialId);
    const policy = evaluateCredentialAccessPolicy({
      requestingProjectId: input.projectId,
      adapter: input.adapter,
      credentialId,
      credentialMetadata: metadata ? { projectId: metadata.projectId, allowedAdapters: metadata.allowedAdapters } : null,
    });

    decisions.push({ credentialId, decision: policy.decision, reason: policy.reason, rule: policy.rule, name: metadata?.name ?? null });

    if (policy.decision === "ALLOW" && metadata) {
      const value = getCredentialValue(input.dataDir, input.projectId, credentialId);
      if (value !== null) {
        env[metadata.name] = value;
      }
    }
  }

  return { env, decisions };
}
