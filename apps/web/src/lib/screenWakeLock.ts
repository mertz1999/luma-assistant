type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
  removeEventListener: (type: "release", listener: () => void) => void;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

function createSilentVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.setAttribute("x5-playsinline", "");
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.autoplay = true;
  video.preload = "auto";
  video.controls = false;
  video.disablePictureInPicture = true;
  video.tabIndex = -1;
  video.setAttribute("aria-hidden", "true");
  Object.assign(video.style, {
    position: "fixed",
    width: "1px",
    height: "1px",
    left: "-10px",
    top: "-10px",
    opacity: "0",
    pointerEvents: "none",
    zIndex: "-1",
  } as CSSStyleDeclaration);
  // Tiny silent clip (NoSleep.js technique). Required for reliable iOS keep-awake.
  video.src = `${import.meta.env.BASE_URL}keep-awake.mp4`;
  return video;
}

export function isScreenWakeLockSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  return Boolean((navigator as WakeLockNavigator).wakeLock?.request);
}

/**
 * Keep the screen awake while `enabled` is true and the document is visible.
 *
 * Why Wake Lock alone often fails:
 * - iOS Safari / installed PWAs frequently ignore or revoke Screen Wake Lock
 * - Low Power Mode / battery saver can deny it
 * - Some browsers require a user gesture and still expire the lock
 *
 * So we also play a muted looping video (classic NoSleep approach), which is
 * what actually keeps many phones awake in practice.
 */
export function createScreenWakeLockController(): {
  setEnabled: (enabled: boolean) => void;
  dispose: () => void;
} {
  let enabled = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let requestInFlight: Promise<void> | null = null;
  let video: HTMLVideoElement | null = null;
  let videoPlaying = false;

  const clearSentinel = () => {
    if (!sentinel) return;
    const current = sentinel;
    sentinel = null;
    current.removeEventListener("release", onReleased);
    if (!current.released) {
      void current.release().catch(() => undefined);
    }
  };

  const stopVideo = () => {
    if (!video) return;
    try {
      video.pause();
    } catch {
      // ignore
    }
    videoPlaying = false;
    if (video.parentNode) video.parentNode.removeChild(video);
    video.removeAttribute("src");
    video.load();
    video = null;
  };

  const ensureVideo = (): HTMLVideoElement => {
    if (video) return video;
    video = createSilentVideo();
    document.body.appendChild(video);
    return video;
  };

  const startVideo = async (): Promise<boolean> => {
    if (typeof document === "undefined") return false;
    const node = ensureVideo();
    try {
      node.currentTime = 0;
      node.muted = true;
      node.defaultMuted = true;
      const playResult = node.play();
      if (playResult && typeof playResult.then === "function") {
        await playResult;
      }
      videoPlaying = !node.paused;
      return videoPlaying;
    } catch {
      videoPlaying = false;
      return false;
    }
  };

  const onReleased = () => {
    if (sentinel) sentinel = null;
    if (enabled && typeof document !== "undefined" && document.visibilityState === "visible") {
      void requestLock();
    }
  };

  const requestLock = async (): Promise<void> => {
    if (!enabled) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;

    const wakeLock = (navigator as WakeLockNavigator).wakeLock;
    if (wakeLock?.request && !(sentinel && !sentinel.released)) {
      try {
        const next = await wakeLock.request("screen");
        if (!enabled || (typeof document !== "undefined" && document.visibilityState !== "visible")) {
          void next.release().catch(() => undefined);
        } else {
          clearSentinel();
          sentinel = next;
          next.addEventListener("release", onReleased);
        }
      } catch {
        // Denied / unsupported in this context — video fallback still runs.
      }
    }

    // Video fallback is the reliable path on iOS PWAs.
    if (enabled && typeof document !== "undefined" && document.visibilityState === "visible") {
      if (!videoPlaying || !video || video.paused) {
        await startVideo();
      }
    }
  };

  const sync = () => {
    if (!enabled) {
      clearSentinel();
      stopVideo();
      return;
    }
    if (requestInFlight) return;
    requestInFlight = requestLock().finally(() => {
      requestInFlight = null;
    });
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") sync();
    else {
      clearSentinel();
      if (video) {
        try {
          video.pause();
        } catch {
          // ignore
        }
        videoPlaying = false;
      }
    }
  };

  const onUserGesture = () => {
    if (!enabled) return;
    sync();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("pointerdown", onUserGesture, { passive: true });
    document.addEventListener("keydown", onUserGesture);
    document.addEventListener("touchstart", onUserGesture, { passive: true });
  }

  return {
    setEnabled(nextEnabled: boolean) {
      enabled = nextEnabled;
      sync();
    },
    dispose() {
      enabled = false;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        document.removeEventListener("pointerdown", onUserGesture);
        document.removeEventListener("keydown", onUserGesture);
        document.removeEventListener("touchstart", onUserGesture);
      }
      clearSentinel();
      stopVideo();
    },
  };
}
