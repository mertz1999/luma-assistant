import { PIStore } from "./store.js";
import { GmailError, type GmailClient } from "./gmail.js";
import { requirePolicy, requirePrivacy } from "./policy.js";
import type { PIMessage } from "@luma/shared";

export class GmailSyncWorker {
  constructor(
    readonly store: PIStore,
    readonly gmail: GmailClient,
    readonly ingest: (message: PIMessage) => unknown,
    readonly topic = process.env.PI_GMAIL_PUBSUB_TOPIC || "",
  ) {}
  async sync() {
    const s = this.store.settings();
    requirePolicy(
      !s.paused && !["disabled", "replay"].includes(s.mode),
      "Live sync is paused/disabled or replay only",
    );
    const mailbox = this.store.mailbox();
    requirePolicy(mailbox?.connected, "Gmail not connected");
    try {
      if (
        !s.privacyReviewed ||
        !s.providerAgreementsConfirmed ||
        !s.dataPolicyReference ||
        (!s.allowedSenders.length &&
          !s.allowedDomains.length &&
          !s.contacts.some((c) => c.active && c.canClarify))
      ) {
        const profile = await this.gmail.profile();
        requirePolicy(
          profile.emailAddress.toLowerCase() === s.mailbox.toLowerCase(),
          "Connected Google account does not match configured mailbox",
        );
        const ids = await this.gmail.listMessages(s.gmailQuery, s.gmailLabels);
        this.store.db
          .prepare(
            "UPDATE pi_mailboxes SET last_sync=?,last_error=NULL WHERE address=?",
          )
          .run(this.store.at(), s.mailbox);
        this.store.event(null, "GMAIL_METADATA_CHECK", "sync", {
          mailbox: s.mailbox,
          matchedIdentifiers: ids.messages?.length || 0,
          messageBodiesRead: false,
          modelInvoked: false,
          cursorAdvanced: false,
        });
        return;
      }
      requirePrivacy(s);
      let nextCursor = mailbox.cursor;
      // Initial/recovery profile cursor is captured BEFORE bounded enumeration to avoid missing arrivals during it.
      const full = async () => {
        const profile = await this.gmail.profile();
        requirePolicy(
          profile.emailAddress.toLowerCase() === s.mailbox,
          "Connected Google account does not match configured mailbox",
        );
        let page: string | undefined;
        const threads = new Set<string>();
        for (let n = 0; n < 5; n++) {
          const response = await this.gmail.listMessages(
            s.gmailQuery,
            s.gmailLabels,
            page,
          );
          for (const message of response.messages || [])
            threads.add(message.threadId);
          page = response.nextPageToken;
          if (!page) break;
        }
        requirePolicy(
          !page,
          "Recovery exceeds 500 messages; narrow Gmail filter before retrying (cursor not advanced)",
        );
        for (const thread of threads)
          for (const message of await this.gmail.getThread(thread))
            this.ingest(message);
        return profile.historyId;
      };
      if (!nextCursor) nextCursor = await full();
      else {
        try {
          let page: string | undefined;
          const threads = new Set<string>();
          let exhausted = false;
          for (let n = 0; n < 10; n++) {
            const response = await this.gmail.history(mailbox.cursor!, page);
            for (const entry of response.history || [])
              for (const added of entry.messagesAdded || [])
                threads.add(added.message.threadId);
            nextCursor = response.historyId;
            page = response.nextPageToken;
            if (!page) {
              exhausted = true;
              break;
            }
          }
          requirePolicy(
            exhausted,
            "History exceeds bounded batch; cursor retained, operator intervention required",
          );
          // Apply search/label filtering to changed threads, including later replies to known cases.
          for (const thread of threads) {
            const known = this.store.db
              .prepare("SELECT 1 FROM pi_cases WHERE mailbox=? AND thread_id=?")
              .get(s.mailbox, thread);
            const messages = await this.gmail.getThread(thread);
            if (known) {
              for (const message of messages) this.ingest(message);
            } else {
              for (const message of messages) {
                if (
                  s.gmailLabels.length &&
                  !message.labels.some((x) => s.gmailLabels.includes(x))
                )
                  continue;
                const match = await this.gmail.listMessages(
                  `(${s.gmailQuery}) rfc822msgid:${message.rfcMessageId.replace(/[<>]/g, "")}`,
                  s.gmailLabels,
                );
                if (match.messages?.some((x) => x.id === message.id))
                  this.ingest(message);
              }
            }
          }
        } catch (error) {
          if (error instanceof GmailError && error.status === 404) {
            this.store.event(null, "GMAIL_HISTORY_RECOVERY", "sync", {
              mailbox: s.mailbox,
            });
            nextCursor = await full();
          } else throw error;
        }
      }
      // Partial history doesn't support q. Reconcile the bounded query every successful pass as well.
      const recent = await this.gmail.listMessages(s.gmailQuery, s.gmailLabels);
      for (const thread of new Set(
        (recent.messages || []).map((m) => m.threadId),
      ))
        for (const message of await this.gmail.getThread(thread))
          this.ingest(message);
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
        error instanceof GmailError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Gmail sync failed";
      this.store.db
        .prepare("UPDATE pi_mailboxes SET last_error=? WHERE address=?")
        .run(reason, s.mailbox);
      throw error;
    }
  }
}
