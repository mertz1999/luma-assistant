import type { PIMessage, PISettings } from "@luma/shared";
import { z } from "zod";
import { PIStore } from "./store.js";

export function parseThreadSenders(value: string): string[] {
  return [
    ...new Set(value.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean)),
  ].sort();
}
export function configuredThreadSenders(settings: PISettings): string[] {
  return parseThreadSenders(
    [settings.requiredThreadSender || "", ...(settings.requiredThreadSenders || [])].join(","),
  );
}
export function deploymentThreadSenders(): string[] | null {
  const configured =
    process.env.PI_GMAIL_REQUIRED_THREAD_SENDERS ||
    process.env.PI_GMAIL_REQUIRED_THREAD_SENDER;
  if (!configured) return null;
  const senders = parseThreadSenders(configured);
  if (!senders.length)
    throw new Error("Deployment thread sender list must not be empty");
  return z.array(z.string().email()).max(100).parse(senders);
}
export function requiredThreadSenders(settings: PISettings): string[] {
  return deploymentThreadSenders() || configuredThreadSenders(settings);
}
// Canonical policy key: evidence cannot be reused under a changed sender set.
export function requiredThreadSender(settings: PISettings): string | null {
  return requiredThreadSenders(settings).join(",") || null;
}
export function qualifyingAnchor(
  messages: PIMessage[],
  sender: string,
  mailbox: string,
  threadId: string,
): PIMessage | undefined {
  const senders = parseThreadSenders(sender);
  return messages.find(
    (m) =>
      m.mailbox.toLowerCase() === mailbox.toLowerCase() &&
      m.threadId === threadId &&
      senders.includes(m.from.toLowerCase()) &&
      !m.labels.some((l) => ["SPAM", "TRASH", "DRAFT"].includes(l)),
  );
}
export function threadAuthorized(
  store: PIStore,
  mailbox: string,
  threadId: string,
): boolean {
  const sender = requiredThreadSender(store.settings());
  return (
    !sender ||
    Boolean(
      store.db
        .prepare(
          "SELECT 1 FROM pi_thread_eligibility WHERE mailbox=? AND thread_id=? AND required_sender=?",
        )
        .get(mailbox, threadId, sender),
    )
  );
}
export function recordThreadEligibility(
  store: PIStore,
  messages: PIMessage[],
  threadId: string,
): boolean {
  const s = store.settings(),
    sender = requiredThreadSender(s);
  if (!sender) return true;
  const anchor = qualifyingAnchor(messages, sender, s.mailbox, threadId);
  if (!anchor) {
    store.db
      .prepare(
        "DELETE FROM pi_thread_eligibility WHERE mailbox=? AND thread_id=?",
      )
      .run(s.mailbox, threadId);
    return false;
  }
  store.db
    .prepare(
      "INSERT INTO pi_thread_eligibility VALUES(?,?,?,?,?) ON CONFLICT(mailbox,thread_id) DO UPDATE SET required_sender=excluded.required_sender,anchor_id=excluded.anchor_id,verified_at=excluded.verified_at",
    )
    .run(s.mailbox, threadId, sender, anchor.id, store.at());
  return true;
}
