# Running PI test preview

Preview URL: **https://pi-clarification-test.deepspring.co**. Sign in with the existing Luma owner password. Open Cowork → Test mode → Replay AR TYPE NOT POPULATED, then inspect the case's task, approval, outbound and evidence tabs. PPO demonstrates mandatory escalation. The main app at assistant2.deepspring.co continues to serve its existing installation.

The user authorized starting this test instance and reusing the cluster email credentials on November 1, 2026. It runs from the PI feature checkout using separate ports (19091 API, 19075 web), separate data, and distinct PM2 process names. The preview Service, Ingress and NetworkPolicy are `cloud-dev/reza-luma-pi-test`. The policy permits only ingress-nginx controller pods to reach the preview ports. Existing TLS and wildcard DNS are reused. PM2 keeps the two preview processes alive and saves their configuration for resurrection.

## Gmail connection and limits

The existing `production/pi-mailroom-email` credentials are for **admin@proimagetx.ai**, using Auth0 → Google Workload Identity Federation → IAM signing → Workspace domain-wide delegation. A live profile check succeeded using **only `gmail.readonly`**. No new OAuth client or browser consent is needed for this adapter. No service-account private key is downloaded. Intermediate/access tokens are memory-only. The authorized credential material is supplied through a private 0600 server file; no secret is committed or displayed.

The deployment send lock is true, and the federated transport separately refuses sending and Gmail draft creation even if another setting changes. Nothing was emailed. Automatic watches/labels are not created for metadata-only polling.

Checks run every 120 seconds. While privacy/provider policy or authorized sender/contact configuration is incomplete, the worker reads only the profile and message identifiers/count, never message bodies, attachments or model context. It records actual last-sync health without advancing the full-processing history cursor. Cowork explains this `Metadata-only polling` state. The full synthetic approval/handoff workflow remains available in its separate demo database.

Before live case processing, configure verified PI contacts, workflow routing, sender/approver permissions, and a legally reviewed privacy/provider policy. Select/configure a reasoning API model/credential or isolated JSON provider if live AI reasoning is desired. These business/privacy attestations were not invented during setup. Model requests have not been made for live email.

## Release and maintenance

Use only the repository release entrypoint:

```sh
KUBECONFIG=/path/to/authorized/kubeconfig make release-manual
```

It prepares private configuration, builds all workspaces, starts/reloads only `luma-pi-test-server` and `luma-pi-test-web`, saves PM2 state, and applies the preview's own Kubernetes resources. `PI_PREVIEW_NETWORK_ONLY=1` reapplies only prepared preview networking. The launcher filters inherited PM2 internal environment fields so a release invoked from a Luma session cannot overwrite another application's process identity. A regression test covers that boundary.

The source and initial mock-only validation are in PR #3. This follow-up adds the real cluster authentication adapter and preview release setup. Authentication failures report host/status only, without provider token/error bodies. Disconnect disables the local federation connection without revoking the shared cluster credential used by other PI applications; reconnect is owner-authenticated and verifies the actual mailbox.

## Verification

The live HTTPS route and existing-password login work; anonymous PI API calls return 401. Read-only Gmail connection and successful metadata checks are visible, and the live case database has no ingested email bodies. Mocked AR replay, complete approved task download, send-lock display, real federation settings and mobile layout are checked in the public preview. The Browser plugin was unavailable, so rendered validation used the repository's Playwright workflow and an additional public-URL Playwright smoke run.
