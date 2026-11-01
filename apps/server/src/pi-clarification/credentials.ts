import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { PIStore } from "./store.js";
import { requirePolicy } from "./policy.js";

export class CredentialVault {
  private key: Buffer | null;
  constructor(
    readonly store: PIStore,
    key = process.env.PI_CREDENTIAL_ENCRYPTION_KEY || "",
  ) {
    this.key = /^[a-fA-F0-9]{64}$/.test(key) ? Buffer.from(key, "hex") : null;
  }
  configured() {
    return Boolean(this.key);
  }
  put(mailbox: string, refreshToken: string) {
    requirePolicy(
      this.key,
      "PI_CREDENTIAL_ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters",
    );
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(refreshToken, "utf8"),
      cipher.final(),
    ]);
    const packed = [
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      encrypted.toString("base64"),
    ].join(".");
    this.store.db
      .prepare(
        "INSERT INTO pi_mailboxes(address,credential) VALUES(?,?) ON CONFLICT(address) DO UPDATE SET credential=excluded.credential,last_error=NULL",
      )
      .run(mailbox, packed);
    this.store.event(null, "GMAIL_CREDENTIAL_CONNECTED", "admin", { mailbox });
  }
  get(mailbox: string): string {
    requirePolicy(this.key, "Credential encryption key is not configured");
    const row = this.store.db
      .prepare("SELECT credential FROM pi_mailboxes WHERE address=?")
      .get(mailbox) as { credential: string | null } | undefined;
    requirePolicy(row?.credential, "Gmail is not connected");
    const [iv, tag, data] = row.credential
      .split(".")
      .map((x) => Buffer.from(x, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  }
  remove(mailbox: string) {
    this.store.db
      .prepare(
        "UPDATE pi_mailboxes SET credential=NULL,cursor=NULL,watch_expires_at=NULL WHERE address=?",
      )
      .run(mailbox);
    this.store.event(null, "GMAIL_DISCONNECTED", "admin", { mailbox });
  }
  issueState() {
    const state = randomBytes(32).toString("base64url");
    this.store.db
      .prepare("DELETE FROM pi_oauth_states WHERE expires_at<?")
      .run(this.store.now().getTime());
    this.store.db
      .prepare("INSERT INTO pi_oauth_states VALUES(?,?)")
      .run(this.hash(state), this.store.now().getTime() + 600000);
    return state;
  }
  consumeState(state: string) {
    const changed = this.store.db
      .prepare("DELETE FROM pi_oauth_states WHERE hash=? AND expires_at>?")
      .run(this.hash(state), this.store.now().getTime());
    requirePolicy(changed.changes === 1, "Invalid or expired OAuth state");
  }
  private hash(v: string) {
    return createHash("sha256").update(v).digest("hex");
  }
}
