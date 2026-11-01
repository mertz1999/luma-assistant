import fs from "node:fs";
import { z } from "zod";
import { requirePolicy } from "./policy.js";

const FederationConfigSchema = z
  .object({
    MAILROOM_EMAIL_AUTH0_DOMAIN: z.string().regex(/^[a-z0-9.-]+\.auth0\.com$/i),
    MAILROOM_EMAIL_AUTH0_CLIENT_ID: z.string().min(1),
    MAILROOM_EMAIL_AUTH0_CLIENT_SECRET: z.string().min(1),
    MAILROOM_EMAIL_AUTH0_AUDIENCE: z.string().url(),
    MAILROOM_EMAIL_FEDERATION_AUDIENCE: z
      .string()
      .regex(
        /^\/\/iam\.googleapis\.com\/projects\/\d+\/locations\/global\/workloadIdentityPools\/[\w-]+\/providers\/[\w-]+$/,
      ),
    MAILROOM_EMAIL_SERVICE_ACCOUNT: z
      .string()
      .regex(/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/i),
    MAILROOM_EMAIL_SENDER: z.string().email(),
  })
  .strict();
export type FederationConfig = z.infer<typeof FederationConfigSchema>;
export interface GmailTokenProvider {
  readonly readOnly: boolean;
  accessToken(): Promise<{ value: string; expiresAt: number }>;
}

// Reuse PI's Auth0 -> Google WIF -> IAM signing -> Workspace delegation.
// Only gmail.readonly is ever requested. No service-account private key or token is persisted.
export class FederatedGmailCredentials implements GmailTokenProvider {
  readonly readOnly = true;
  private cached: { value: string; expiresAt: number } | null = null;
  private pending: Promise<{ value: string; expiresAt: number }> | null = null;
  constructor(
    readonly config: FederationConfig,
    readonly mailbox: string,
    readonly fetcher: typeof fetch = fetch,
    readonly now = () => Date.now(),
  ) {
    FederationConfigSchema.parse(config);
    requirePolicy(
      config.MAILROOM_EMAIL_SENDER.toLowerCase() === mailbox.toLowerCase(),
      "Federated credential mailbox mismatch",
    );
  }
  static fromFile(file: string, mailbox: string) {
    const stat = fs.statSync(file);
    requirePolicy(
      stat.isFile() && (stat.mode & 0o077) === 0,
      "Federation credential file must be private (0600)",
    );
    return new FederatedGmailCredentials(
      FederationConfigSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))),
      mailbox,
    );
  }
  async accessToken() {
    if (this.cached && this.cached.expiresAt > this.now() + 60000)
      return this.cached;
    if (this.pending) return this.pending;
    this.pending = this.exchange().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async post(
    url: string,
    data: unknown,
    token?: string,
    form = false,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, {
      method: "POST",
      headers: {
        "Content-Type": form
          ? "application/x-www-form-urlencoded"
          : "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: form
        ? new URLSearchParams(data as Record<string, string>)
        : JSON.stringify(data),
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    requirePolicy(
      response.ok,
      `Federated Gmail authentication failed at ${new URL(url).hostname} (${response.status})`,
    );
    const raw = await response.text();
    requirePolicy(raw.length < 100000, "Federation response exceeds limit");
    return JSON.parse(raw);
  }
  private async exchange() {
    const c = this.config;
    const auth = await this.post(
      `https://${c.MAILROOM_EMAIL_AUTH0_DOMAIN}/oauth/token`,
      {
        client_id: c.MAILROOM_EMAIL_AUTH0_CLIENT_ID,
        client_secret: c.MAILROOM_EMAIL_AUTH0_CLIENT_SECRET,
        audience: c.MAILROOM_EMAIL_AUTH0_AUDIENCE,
        grant_type: "client_credentials",
      },
    );
    requirePolicy(
      typeof auth.access_token === "string",
      "Auth0 returned no access token",
    );
    const sts = await this.post("https://sts.googleapis.com/v1/token", {
      audience: c.MAILROOM_EMAIL_FEDERATION_AUDIENCE,
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      subjectToken: auth.access_token,
      scope: "https://www.googleapis.com/auth/iam",
    });
    requirePolicy(
      typeof sts.access_token === "string",
      "Google STS returned no access token",
    );
    const now = Math.floor(this.now() / 1000);
    const claims = {
      iss: c.MAILROOM_EMAIL_SERVICE_ACCOUNT,
      sub: this.mailbox,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    };
    const signed = await this.post(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(c.MAILROOM_EMAIL_SERVICE_ACCOUNT)}:signJwt`,
      { payload: JSON.stringify(claims) },
      sts.access_token,
    );
    requirePolicy(
      typeof signed.signedJwt === "string",
      "Google IAM returned no signed assertion",
    );
    const token = await this.post(
      "https://oauth2.googleapis.com/token",
      {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signed.signedJwt,
      },
      undefined,
      true,
    );
    requirePolicy(
      typeof token.access_token === "string" &&
        typeof token.expires_in === "number" &&
        token.expires_in > 0,
      "Google returned no delegated Gmail token",
    );
    this.cached = {
      value: token.access_token,
      expiresAt: this.now() + Math.min(token.expires_in, 3600) * 1000,
    };
    return this.cached;
  }
}
