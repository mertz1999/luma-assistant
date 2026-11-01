import { PIStore } from "./store.js";
import { GmailError, type GmailClient } from "./gmail.js";
import { requirePolicy, requireProcessingAuthorization } from "./policy.js";
import {
  requiredThreadSender,
  parseThreadSenders,
  recordThreadEligibility,
} from "./thread-policy.js";
import type { PIMessage } from "@luma/shared";

export class GmailSyncWorker {
  constructor(
    readonly store: PIStore,
    readonly gmail: GmailClient,
    readonly ingest: (message: PIMessage) => unknown,
    readonly topic = process.env.PI_GMAIL_PUBSUB_TOPIC || "",
  ) {}
  async sync() {
    const s = this.store.settings(),
      sender = requiredThreadSender(s);
    requirePolicy(
      !s.paused && !["disabled", "replay"].includes(s.mode),
      "Live sync is paused/disabled or replay only",
    );
    const mailbox = this.store.mailbox();
    requirePolicy(mailbox?.connected, "Gmail not connected");
    const query = sender
      ? `(${s.gmailQuery}) {${parseThreadSenders(sender)
          .map((address) => `from:${address}`)
          .join(" ")}}`
      : s.gmailQuery;
    const processed = new Set<string>();
    try {
      if (
        !s.receiveOnly &&
        s.modelInputMode === "reviewed_policy" &&
        (!s.privacyReviewed ||
          !s.providerAgreementsConfirmed ||
          !s.dataPolicyReference ||
          (!sender &&
            !s.allowedSenders.length &&
            !s.allowedDomains.length &&
            !s.contacts.some((c) => c.active && c.canClarify)))
      ) {
        const profile = await this.gmail.profile();
        requirePolicy(
          profile.emailAddress.toLowerCase() === s.mailbox.toLowerCase(),
          "Connected Google account does not match configured mailbox",
        );
        const ids = await this.gmail.listMessages(query, s.gmailLabels);
        this.store.db
          .prepare(
            "UPDATE pi_mailboxes SET last_sync=?,last_error=NULL WHERE address=?",
          )
          .run(this.store.at(), s.mailbox);
        this.store.event(null, "GMAIL_METADATA_CHECK", "sync", {
          mailbox: s.mailbox,
          matchedIdentifiers: ids.messages?.length || 0,
          requiredThreadSender: sender,
          messageBodiesRead: false,
          modelInvoked: false,
          cursorAdvanced: false,
        });
        return;
      }
      if (!s.receiveOnly) requireProcessingAuthorization(s);
      const processThread = async (
        threadId: string,
        historyDelivery = false,
      ) => {
        if (processed.has(threadId)) return;
        processed.add(threadId);
        if (sender) {
          // Read only headers to decide eligibility. Never fetch an excluded thread's body.
          const metadata = await this.gmail.getThreadMetadata(threadId);
          if (!recordThreadEligibility(this.store, metadata, threadId)) return;
          const messages = await this.gmail.getThread(threadId);
          for (const message of messages) this.ingest(message);
          // Preserve older mailbox-sent context after the first incoming message creates the case.
          for (const message of messages)
            if (
              message.from.toLowerCase() === s.mailbox.toLowerCase() ||
              message.labels.includes("SENT")
            )
              this.ingest(message);
          return;
        }
        const messages = await this.gmail.getThread(threadId);
        const known = this.store.db
          .prepare("SELECT 1 FROM pi_cases WHERE mailbox=? AND thread_id=?")
          .get(s.mailbox, threadId);
        for (const message of messages) {
          if (!historyDelivery || known) {
            this.ingest(message);
            continue;
          }
          if (
            s.gmailLabels.length &&
            !message.labels.some((l) => s.gmailLabels.includes(l))
          )
            continue;
          const match = await this.gmail.listMessages(
            `(${s.gmailQuery}) rfc822msgid:${message.rfcMessageId.replace(/[<>]/g, "")}`,
            s.gmailLabels,
          );
          if (match.messages?.some((m) => m.id === message.id))
            this.ingest(message);
        }
      };
      const full = async () => {
        const profile = await this.gmail.profile();
        requirePolicy(
          profile.emailAddress.toLowerCase() === s.mailbox.toLowerCase(),
          "Connected Google account does not match configured mailbox",
        );
        let page: string | undefined;
        const threads = new Set<string>();
        for (let n = 0; n < 5; n++) {
          const result = await this.gmail.listMessages(
            query,
            s.gmailLabels,
            page,
          );
          for (const m of result.messages || []) threads.add(m.threadId);
          page = result.nextPageToken;
          if (!page) break;
        }
        requirePolicy(
          !page,
          "Recovery exceeds 500 messages; narrow Gmail filter before retrying (cursor not advanced)",
        );
        for (const threadId of threads) await processThread(threadId);
        return profile.historyId;
      };
      let nextCursor = mailbox.cursor;
      if (!nextCursor) nextCursor = await full();
      else {
        try {
          let page: string | undefined,
            exhausted = false;
          const threads = new Set<string>();
          for (let n = 0; n < 10; n++) {
            const result = await this.gmail.history(mailbox.cursor!, page);
            for (const entry of result.history || [])
              for (const added of entry.messagesAdded || [])
                threads.add(added.message.threadId);
            nextCursor = result.historyId;
            page = result.nextPageToken;
            if (!page) {
              exhausted = true;
              break;
            }
          }
          requirePolicy(
            exhausted,
            "History exceeds bounded batch; cursor retained, operator intervention required",
          );
          for (const threadId of threads) await processThread(threadId, true);
        } catch (error) {
          if (error instanceof GmailError && error.status === 404) {
            this.store.event(null, "GMAIL_HISTORY_RECOVERY", "sync", {
              mailbox: s.mailbox,
            });
            nextCursor = await full();
          } else throw error;
        }
      }
      const recent = await this.gmail.listMessages(query, s.gmailLabels);
      for (const threadId of new Set(
        (recent.messages || []).map((m) => m.threadId),
      ))
        await processThread(threadId);
      const renewed = this.store
        .events()
        .find(
          (e) =>
            e.kind === "GMAIL_WATCH_RENEWED" && e.data.mailbox === s.mailbox,
        );
      if (
        this.topic &&
        (!mailbox.watch_expires_at ||
          Date.parse(mailbox.watch_expires_at) - this.store.now().getTime() <
            86400000 ||
          !renewed ||
          this.store.now().getTime() - Date.parse(renewed.at) >= 86400000)
      ) {
        const watch = await this.gmail.watch(this.topic, s.gmailLabels);
        this.store.db
          .prepare("UPDATE pi_mailboxes SET watch_expires_at=? WHERE address=?")
          .run(new Date(Number(watch.expiration)).toISOString(), s.mailbox);
        this.store.event(null, "GMAIL_WATCH_RENEWED", "sync", {
          mailbox: s.mailbox,
        });
      }
      this.store.db
        .prepare(
          "UPDATE pi_mailboxes SET cursor=?,last_sync=?,last_error=NULL WHERE address=?",
        )
        .run(nextCursor, this.store.at(), s.mailbox);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "Gmail sync failed";
      this.store.db
        .prepare("UPDATE pi_mailboxes SET last_error=? WHERE address=?")
        .run(reason, s.mailbox);
      throw error;
    }
  }
}
