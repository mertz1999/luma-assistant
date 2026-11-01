# Live PI mailbox intake

Open https://pi-clarification-test.deepspring.co and use the existing Luma password. The URL name is unchanged, but this instance now uses the production mailbox with demo mode disabled and the old demo database removed.

## Enforced scope

Mailbox: **admin@proimagetx.ai**.

A thread is admitted only if a real Gmail message in that thread has the exact From address **LNQCore@proimagetx.com** or **tanaki.reza1999@gmail.com** (either one is sufficient), compared case-insensitively. Other incoming participants' replies and mailbox-sent context can then appear in the same case. Putting that address in To/CC, a display name, forwarded headers, quoted content or the subject does not qualify a thread. Gmail's actual thread ID determines continuity; reusing a subject alone does not establish the same conversation.

Initial discovery searches the inbox for matching sender messages from the last 30 days. History processing checks the full thread headers, including older messages, so a new reply can qualify through a prior message from either allowed sender. Spam, trash and drafts do not establish eligibility. Bounces/automatic replies do not start agent response loops; a mailing-list header by itself is not treated as an automatic reply.

The backend verifies headers before fetching bodies, records the qualifying message ID, and enforces the same guard on full thread reads, individual message/attachment reads, and any future reply/draft path. Known cases and history-cursor recovery do not bypass it. Deployment configuration locks the allowed sender list so normal settings edits cannot loosen this installation's boundary.

**Google permission boundary:** Gmail OAuth scopes cannot restrict a token to particular senders or threads. The underlying credential is mailbox-wide `gmail.readonly`; the sender/thread restriction is enforced by this application's backend. No send/compose scope is used by the cluster adapter.

## Current behavior

- Polling runs every 120 seconds, independently of the browser. Operations → Poll Gmail now queues an immediate pass.
- Qualifying messages are sanitized and saved locally; a case starts as `RECEIVED`, then progresses through automatic analysis. Incoming replies update that case and trigger another analysis. Mailbox-sent messages remain context only and do not trigger reply loops.
- **Automatic AI analysis is enabled at the owner’s request**, using the existing Codex login (Cursor is also supported). Each new eligible incoming message queues analysis without a manual summary or per-message confirmation. The service supplies sanitized thread text and applies its existing identifier/credential/quote redaction. This is not guaranteed anonymization; residual patient information can reach the chosen AI connection. Provider/privacy-agreement fields remain unconfirmed rather than being fabricated. See [the local worker guide](pi-clarification-local-workers.md).
- Outbound email and Gmail draft creation remain locked. Nothing is emailed back to the sender.
- There are no live sample cases, replay controls or simulator endpoints. Automated tests retain isolated fixtures outside the live mailbox/database.

## Developer/client context in the active prompt

Developers: **Reza, Mahdi, Hossein/Hosseins**. They are not the clients; their comments provide technical context, not client scope approval.

Clients: **Piper, Stephanie, Tony, Mickeal/Michael/Mike/Mke, Dawn, Brandy**. The listed names/spellings are owner-provided context, not identity verification or automatic approval authority. Actual client approvers still require configured email contacts and backend verification.

The Gmail address added for Reza admits his threads but does not change his developer role or grant client approval authority.

Target PI deployments, merges, releases and workflow dispatch are prohibited. Implementation requires an exactly approved task, isolated checks and explicit diff review before draft PR publication. PI invoicing PR publication is blocked by its existing PR-triggered staging deployment workflow.

The release publishes this section into the effective versioned prompt while preserving unrelated prompt edits.

## How to test with a real email

1. Send a simple non-sensitive email **from LNQCore@proimagetx.com or tanaki.reza1999@gmail.com to admin@proimagetx.ai**, e.g. subject `PI inbox check` and body `Please confirm the generic AR type display behavior. No patient data is included.`
2. Wait roughly two minutes, or use **Cowork → Operations → Poll Gmail now**.
3. Open **Cowork → Cases**. A real case should appear and move beyond `RECEIVED` as the AI processes it. Select it to see the actual subject and sanitized thread. Case titles are deliberately generic to keep sensitive subject information out of titles.
4. Reply in that same Gmail conversation from another participant, keeping admin@proimagetx.ai included. The existing case should gain the reply after the next poll.
5. Negative check: a fresh email from another address without an actual message from either allowed sender in its thread should not create a case. Merely CC'ing an allowed sender is insufficient; that sender must actually reply-all to qualify it.

Expect **automatic AI analysis and no email reply**. Check the case’s evidence, specifications and outbound panels for a decision, specification or local clarification draft. No manual summary is required. Missing details or high-risk requests may result in waiting/escalation instead of a draft. Check the send-lock banner and Gmail last-sync/error status. Confirm delivery to the inbox and the actual sender if a case does not appear.
