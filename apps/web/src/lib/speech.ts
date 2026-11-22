import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "./api";

export type SpeechSettings = { configured: boolean; baseUrl: string; model: string };
export const speechSettingsQueryKey = ["speech-settings"] as const;
export const getSpeechSettings = () => request<SpeechSettings>("/api/speech/settings");
export const saveSpeechSettings = (settings: { baseUrl: string; model: string; apiKey: string }) =>
  request<SpeechSettings>("/api/speech/settings", { method: "PUT", body: JSON.stringify(settings) });
export const removeSpeechSettings = () => request<SpeechSettings>("/api/speech/settings", { method: "DELETE" });

type Recording = {
  controller: AbortController;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: number;
};
type Phase = "idle" | "starting" | "recording" | "transcribing";
const audioFormats = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];

function releaseMicrophone(recording: Recording): void {
  window.clearTimeout(recording.timer);
  recording.stream?.getTracks().forEach((track) => track.stop());
}

export function useApiDictation(scope: string | null, onTranscript: (text: string) => void) {
  const current = useRef<Recording | null>(null);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [phase, setPhase] = useState<Phase>("idle");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder === "function";

  const release = useCallback(() => {
    const recording = current.current;
    current.current = null;
    if (!recording) return;
    recording.controller.abort();
    if (recording.recorder && recording.recorder.state !== "inactive") recording.recorder.stop();
    releaseMicrophone(recording);
  }, []);

  const cancel = useCallback(() => {
    release();
    setPhase("idle");
    setStartedAt(null);
    setError(null);
  }, [release]);

  useEffect(() => {
    cancel();
    return release;
  }, [scope, cancel, release]);

  async function start(): Promise<void> {
    if (current.current || !scope) return;
    if (!supported) {
      setError("Microphone recording requires a supported browser on HTTPS or localhost.");
      return;
    }
    const recording: Recording = { controller: new AbortController() };
    current.current = recording;
    setError(null);
    setPhase("starting");
    const isCurrent = () => current.current === recording && currentScope.current === scope;
    const finish = () => {
      if (!isCurrent()) return;
      current.current = null;
      setPhase("idle");
      setStartedAt(null);
    };
    try {
      const mimeType = audioFormats.find((format) => MediaRecorder.isTypeSupported(format));
      if (!mimeType) throw new Error("This browser does not support a compatible audio format.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recording.stream = stream;
      if (!isCurrent()) { releaseMicrophone(recording); return; }
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
      recording.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => {
        releaseMicrophone(recording);
        if (isCurrent()) { setError("Microphone recording stopped unexpectedly."); finish(); }
      };
      recorder.onstop = async () => {
        releaseMicrophone(recording);
        if (!isCurrent()) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
        if (!blob.size) { setError("No audio was recorded. Try again."); finish(); return; }
        setPhase("transcribing");
        setStartedAt(null);
        try {
          const { text } = await request<{ text: string }>("/api/speech/transcriptions", {
            method: "POST",
            headers: { "Content-Type": blob.type },
            body: blob,
            signal: recording.controller.signal,
          });
          if (isCurrent()) {
            if (text) onTranscript(text);
            else setError("No speech was detected. Try again.");
          }
        } catch (problem) {
          if (isCurrent()) setError(problem instanceof Error ? problem.message : "Transcription failed.");
        } finally { finish(); }
      };
      recorder.start();
      recording.timer = window.setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 180_000);
      setStartedAt(Date.now());
      setPhase("recording");
    } catch (problem) {
      releaseMicrophone(recording);
      if (!isCurrent()) return;
      setError(problem instanceof Error && problem.name === "NotAllowedError" ? "Allow microphone access in your browser or macOS settings."
        : problem instanceof Error && problem.name === "NotFoundError" ? "No microphone was found."
        : problem instanceof Error ? problem.message : "Unable to start recording.");
      finish();
    }
  }

  function stop(): void {
    const recorder = current.current?.recorder;
    if (recorder?.state === "recording") recorder.stop();
  }

  return { start, stop, cancel, phase, startedAt, error };
}
