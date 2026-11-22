import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import fs from "node:fs";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { Router, type Response } from "express";
import express from "express";
import ipaddr from "ipaddr.js";
import { z } from "zod";

const audioLimit = 10 * 1024 * 1024;
const audioExtensions: Record<string, string> = {
  "audio/webm": "webm", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/ogg": "ogg",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac", "audio/aac": "aac",
};
const settingsSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().max(4096).refine((key) => /^[\x21-\x7e]*$/.test(key), "Enter a valid API key.").optional(),
});
type SpeechSettings = { baseUrl: string; model: string; apiKey: string };

class SpeechError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function transcriptionEndpoint(input: string): URL {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new SpeechError(400, "Enter a valid HTTPS base URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new SpeechError(400, "Use an HTTPS base URL without credentials, a query, or a fragment.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/audio/transcriptions`;
  return url;
}

export function isPublicSpeechAddress(address: string): boolean {
  const ip = ipaddr.process(address);
  if (ip.range() !== "unicast") return false;
  return ip.kind() === "ipv4" || ip.match(ipaddr.IPv6.parse("2000::"), 3);
}

async function publicEndpointAddress(url: URL) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicSpeechAddress(address))) {
    throw new SpeechError(400, "The transcription API must use a public HTTPS address.");
  }
  return { hostname, address: (addresses.find((record) => record.family === 4) ?? addresses[0]).address };
}

async function transcribe(settings: SpeechSettings, audio: Buffer, mime: string, extension: string, signal: AbortSignal): Promise<string> {
  const url = transcriptionEndpoint(settings.baseUrl);
  const { hostname, address } = await publicEndpointAddress(url);
  const data = new FormData();
  data.set("file", new Blob([new Uint8Array(audio)], { type: mime }), `recording.${extension}`);
  data.set("model", settings.model);
  data.set("response_format", "json");
  const multipart = new Response(data);
  const body = Buffer.from(await multipart.arrayBuffer());

  // Dial the validated address directly while preserving TLS SNI and the Host header.
  // This avoids a second DNS lookup or forwarding the API key through a redirect.
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: address,
      servername: isIP(hostname) ? "" : hostname,
      port: url.port || 443,
      path: url.pathname,
      method: "POST",
      agent: false,
      signal,
      headers: {
        Host: url.host,
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": multipart.headers.get("content-type")!,
        "Content-Length": body.length,
        Accept: "application/json",
      },
    }, (upstream) => {
      const status = upstream.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        upstream.destroy();
        const reason = status === 401 || status === 403 ? "The provider rejected the API key."
          : status === 404 || status === 400 || status === 422 ? "The provider rejected the request. Check the base URL, model, and audio format."
          : status === 402 || status === 429 ? "The provider reported a quota or billing limit."
          : status >= 300 && status < 400 ? "Use the final HTTPS base URL. The provider redirected the request."
          : "The transcription provider is unavailable. Try again.";
        reject(new SpeechError(502, reason));
        return;
      }
      upstream.setEncoding("utf8");
      let json = "";
      upstream.on("data", (chunk: string) => {
        json += chunk;
        if (json.length > 128_000) upstream.destroy(new SpeechError(502, "The provider returned a transcript that is too large."));
      });
      upstream.on("error", reject);
      upstream.on("end", () => {
        try {
          const { text } = JSON.parse(json);
          if (typeof text === "string") { resolve(text.trim()); return; }
        } catch { /* The provider did not return a compatible transcript. */ }
        reject(new SpeechError(502, "The provider returned an invalid transcription response."));
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

function fail(res: Response, error: unknown, fallback: string): void {
  res.status(error instanceof SpeechError ? error.status : 502).json({
    ok: false, error: { message: error instanceof SpeechError ? error.message : fallback },
  });
}

export function createSpeechRouter(file: string): Router {
  function read(): SpeechSettings | null {
    if (!fs.existsSync(file)) return null;
    const result = settingsSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return result.success && result.data.apiKey ? { ...result.data, apiKey: result.data.apiKey } : null;
  }

  function publicSettings(settings: SpeechSettings | null) {
    return settings ? { configured: true, baseUrl: settings.baseUrl, model: settings.model }
      : { configured: false, baseUrl: "", model: "" };
  }

  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/settings", (_req, res) => {
    try { res.json({ ok: true, data: publicSettings(read()) }); }
    catch (error) { fail(res, error, "Unable to read transcription settings."); }
  });
  router.put("/settings", async (req, res) => {
    const input = settingsSchema.safeParse(req.body);
    if (!input.success) {
      fail(res, new SpeechError(400, input.error.issues[0]?.message ?? "Check your transcription settings."), "");
      return;
    }
    try {
      const { model } = input.data;
      const baseUrl = input.data.baseUrl.replace(/\/+$/, "");
      await publicEndpointAddress(transcriptionEndpoint(baseUrl));
      const current = read();
      const apiKey = input.data.apiKey || (current?.baseUrl === baseUrl ? current.apiKey : "");
      if (!apiKey) throw new SpeechError(400, "Enter an API key for this base URL.");
      const settings = { baseUrl, model, apiKey };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(settings), { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
      res.json({ ok: true, data: publicSettings(settings) });
    } catch (error) { fail(res, error, "Unable to save settings. Check the API hostname and try again."); }
  });
  router.delete("/settings", (_req, res) => {
    try {
      fs.rmSync(file, { force: true });
      res.json({ ok: true, data: publicSettings(null) });
    } catch (error) { fail(res, error, "Unable to remove transcription settings."); }
  });
  router.post("/transcriptions", express.raw({ limit: audioLimit, type: "audio/*" }), async (req, res) => {
    const mime = (req.header("Content-Type") || "").split(";")[0].trim().toLowerCase();
    const extension = audioExtensions[mime];
    if (!extension) {
      fail(res, new SpeechError(415, "This audio format is not supported."), "");
      return;
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      fail(res, new SpeechError(400, "Record some audio before transcribing."), "");
      return;
    }
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(75_000);
    res.on("close", () => controller.abort());
    try {
      const settings = read();
      if (!settings) throw new SpeechError(409, "Set up a transcription provider in Voice settings first.");
      const text = await transcribe(settings, req.body, mime, extension, AbortSignal.any([controller.signal, timeout]));
      res.json({ ok: true, data: { text } });
    } catch (error) {
      if (!controller.signal.aborted) fail(res, error, timeout.aborted ? "Transcription took too long. Try a shorter recording." : "Could not reach the transcription provider.");
    }
  });
  router.use((error: unknown, _req: express.Request, res: Response, next: express.NextFunction) => {
    if ((error as { type?: string }).type === "entity.too.large") {
      fail(res, new SpeechError(413, "The recording exceeds 10 MB."), "");
      return;
    }
    next(error);
  });
  return router;
}
