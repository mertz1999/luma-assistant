import type { PIMessage, PISettings } from "@luma/shared";
import { PIStore } from "./store.js";

export function requiredThreadSender(settings: PISettings): string | null {
  return (
    (
      process.env.PI_GMAIL_REQUIRED_THREAD_SENDER ||
      settings.requiredThreadSender ||
      ""
    )
      .trim()
      .toLowerCase() || null
  );
}
export function qualifyingAnchor(
  messages: PIMessage[],
  sender: string,
  mailbox: string,
  threadId: string,
): PIMessage | undefined {
  return messages.find(
    (m) =>
      m.mailbox.toLowerCase() === mailbox.toLowerCase() &&
      m.threadId === threadId &&
      m.from.toLowerCase() === sender.toLowerCase() &&
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
