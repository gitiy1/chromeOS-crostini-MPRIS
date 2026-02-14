type PlaybackStatus = "playing" | "paused" | "none";

interface BridgeState {
  playerName: string;
  playbackStatus: "playing" | "paused" | "stopped" | "none";
  title: string | null;
  artist: string[];
  album: string | null;
  artUrl: string | null;
  durationUs: number | null;
  positionUs: number;
  playbackRate: number;
  canGoNext: boolean;
  canGoPrevious: boolean;
  canPlay: boolean;
  canPause: boolean;
}

type BridgeHealth = "idle" | "connecting" | "connected" | "error";

interface BridgeDebugState {
  baseUrl: string;
  health: BridgeHealth;
  lastError: string | null;
  lastEventAt: number | null;
  lastUpdateAt: number | null;
  lastState: BridgeState | null;
}

interface LogRecord {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
}

const DEFAULT_BASE_URL = "http://penguin.linux.test:5000";
const BRIDGE_DEBUG_KEY = "bridgeDebug";
const BRIDGE_LOGS_KEY = "bridgeLogs";
const LOG_LIMIT = 200;

let currentBaseUrl = DEFAULT_BASE_URL;
let eventSource: EventSource | null = null;
let bridgeDebug: BridgeDebugState = {
  baseUrl: DEFAULT_BASE_URL,
  health: "idle",
  lastError: null,
  lastEventAt: null,
  lastUpdateAt: null,
  lastState: null,
};
let bridgeLogs: LogRecord[] = [];

const audio = new Audio();
audio.autoplay = false;
audio.muted = true;
audio.volume = 0;

let focusAudioReady = false;
let audioContext: AudioContext | null = null;

function hasStorageApi(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

function pushLocalLog(item: LogRecord) {
  bridgeLogs = [...bridgeLogs, item].slice(-LOG_LIMIT);
}

function syncLogToBackground(item: LogRecord) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  void chrome.runtime.sendMessage({ type: "bridge:append-log", payload: item }).catch(() => undefined);
}

function syncDebugToBackground() {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  void chrome.runtime.sendMessage({ type: "bridge:update-debug", payload: bridgeDebug }).catch(() => undefined);
}

async function saveDebugState() {
  syncDebugToBackground();
  if (!hasStorageApi()) return;
  try {
    await chrome.storage.local.set({ [BRIDGE_DEBUG_KEY]: bridgeDebug });
  } catch {
    // ignore, background relay still keeps logs/debug alive.
  }
}

async function saveLogs() {
  if (!hasStorageApi()) return;
  try {
    await chrome.storage.local.set({ [BRIDGE_LOGS_KEY]: bridgeLogs });
  } catch {
    // ignore, background relay still keeps logs/debug alive.
  }
}

function log(level: LogRecord["level"], message: string) {
  const item: LogRecord = { at: Date.now(), level, message };
  pushLocalLog(item);
  syncLogToBackground(item);

  if (level === "error") {
    console.error(`[bridge] ${message}`);
  } else if (level === "warn") {
    console.warn(`[bridge] ${message}`);
  } else {
    console.info(`[bridge] ${message}`);
  }

  void saveLogs();
}

async function setHealth(health: BridgeHealth, error?: string) {
  bridgeDebug = {
    ...bridgeDebug,
    baseUrl: currentBaseUrl,
    health,
    lastError: error ?? null,
    lastUpdateAt: Date.now(),
  };
  await saveDebugState();
}

async function loadDebugData() {
  if (!hasStorageApi()) {
    log("warn", "chrome.storage.local unavailable in offscreen context");
    return;
  }

  try {
    const data = await chrome.storage.local.get(["baseUrl", BRIDGE_LOGS_KEY, BRIDGE_DEBUG_KEY]);
    currentBaseUrl = data.baseUrl ?? DEFAULT_BASE_URL;

    const loadedLogs = data[BRIDGE_LOGS_KEY];
    if (Array.isArray(loadedLogs)) {
      bridgeLogs = loadedLogs.slice(-LOG_LIMIT);
    }

    const loadedDebug = data[BRIDGE_DEBUG_KEY];
    if (loadedDebug && typeof loadedDebug === "object") {
      bridgeDebug = {
        ...bridgeDebug,
        ...loadedDebug,
        baseUrl: currentBaseUrl,
      };
    }
  } catch (error) {
    log("warn", `loadDebugData failed: ${String(error)}`);
  }

  await saveDebugState();
  await saveLogs();
}

async function initFocusAudio() {
  if (focusAudioReady) return;

  if (typeof AudioContext === "undefined") {
    log("warn", "AudioContext API unavailable; media controls may not appear reliably");
    return;
  }

  audioContext = new AudioContext();
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();

  oscillator.type = "sine";
  oscillator.frequency.value = 220;
  gainNode.gain.value = 0.00001;

  oscillator.connect(gainNode);
  gainNode.connect(destination);

  audio.srcObject = destination.stream;
  oscillator.start();

  focusAudioReady = true;
  log("info", "focus audio initialized with WebAudio stream");
}

function setPlaybackState(state: PlaybackStatus) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = state;
}

function toArtworkSrc(artUrl: string): string {
  if (artUrl.startsWith("http://") || artUrl.startsWith("https://")) {
    return artUrl;
  }
  if (artUrl.startsWith("file://")) {
    return `${currentBaseUrl}/art?src=${encodeURIComponent(artUrl)}`;
  }
  return `${currentBaseUrl}/art?src=${encodeURIComponent(artUrl)}`;
}

function setMetadata(state: BridgeState) {
  if (!("mediaSession" in navigator)) return;

  const artwork = state.artUrl ? [{ src: toArtworkSrc(state.artUrl), sizes: "512x512", type: "image/*" }] : [];

  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.title ?? "Crostini Linux",
    artist: state.artist.join(", ") || state.playerName,
    album: state.album ?? "",
    artwork,
  });
}

function updatePosition(state: BridgeState) {
  if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession)) return;
  const duration = Math.max((state.durationUs ?? 0) / 1_000_000, 0);
  const position = Math.max(state.positionUs / 1_000_000, 0);

  try {
    if (duration > 0) {
      const payload: MediaPositionState = { duration, position: Math.min(position, duration) };
      if (state.playbackStatus === "playing") {
        payload.playbackRate = Math.max(state.playbackRate, 0.1);
      }
      navigator.mediaSession.setPositionState(payload);
    }
  } catch (error) {
    log("warn", `setPositionState failed: ${String(error)}`);
  }
}

async function sendControl(action: string) {
  await fetch(`${currentBaseUrl}/control/${action}`, { method: "POST", mode: "cors" });
  log("info", `sent control action: ${action}`);
}

function registerActionHandlers() {
  if (!("mediaSession" in navigator)) return;
  const map: Record<string, string> = {
    play: "play",
    pause: "pause",
    previoustrack: "previous",
    nexttrack: "next",
    stop: "stop",
  };

  for (const [action, command] of Object.entries(map)) {
    navigator.mediaSession.setActionHandler(action as MediaSessionAction, () => {
      void sendControl(command).catch((error) => {
        void setHealth("error", `control failed: ${String(error)}`);
        log("error", `control action failed (${command}): ${String(error)}`);
      });
    });
  }
}

async function ensureAudioFocus(active: boolean) {
  await initFocusAudio();
  if (!focusAudioReady) return;

  if (active) {
    if (audioContext?.state === "suspended") {
      await audioContext.resume().catch(() => undefined);
    }

    if (audio.paused) {
      await audio.play().catch((error) => {
        log("warn", `failed to start focus audio: ${String(error)}`);
        return undefined;
      });
    }
  } else {
    audio.pause();
    if (audioContext?.state === "running") {
      await audioContext.suspend().catch(() => undefined);
    }
  }
}

async function applyState(state: BridgeState) {
  setMetadata(state);
  updatePosition(state);

  const playbackState: PlaybackStatus =
    state.playbackStatus === "playing" ? "playing" : state.playbackStatus === "paused" ? "paused" : "none";

  setPlaybackState(playbackState);
  await ensureAudioFocus(playbackState !== "none");

  bridgeDebug = {
    ...bridgeDebug,
    baseUrl: currentBaseUrl,
    health: "connected",
    lastError: null,
    lastEventAt: Date.now(),
    lastUpdateAt: Date.now(),
    lastState: state,
  };
  await saveDebugState();
}

function connectEvents() {
  eventSource?.close();
  void setHealth("connecting");
  log("info", `connecting to SSE: ${currentBaseUrl}/events`);

  eventSource = new EventSource(`${currentBaseUrl}/events`);

  eventSource.addEventListener("open", () => {
    void setHealth("connected");
    log("info", "SSE connected");
  });

  eventSource.addEventListener("state", (event) => {
    const state = JSON.parse((event as MessageEvent).data) as BridgeState;
    void applyState(state);
  });

  eventSource.onerror = (event) => {
    const detail = `SSE error (${event.type})`;
    void setHealth("error", detail);
    log("warn", detail);
    eventSource?.close();
    setTimeout(connectEvents, 1500);
  };
}

function addLifecycleLogs() {
  window.addEventListener("pagehide", () => {
    log("warn", "offscreen pagehide fired");
  });

  window.addEventListener("beforeunload", () => {
    log("warn", "offscreen beforeunload fired");
  });

  document.addEventListener("visibilitychange", () => {
    log("info", `offscreen visibility=${document.visibilityState}`);
  });
}

async function boot() {
  log("info", "offscreen boot start");
  addLifecycleLogs();
  await loadDebugData();
  registerActionHandlers();
  connectEvents();
  log("info", "offscreen boot completed");
}

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.baseUrl) {
      currentBaseUrl = changes.baseUrl.newValue ?? DEFAULT_BASE_URL;
      void setHealth("idle");
      log("info", `baseUrl updated: ${currentBaseUrl}`);
      connectEvents();
    }
  });
}

void boot().catch((error) => {
  void setHealth("error", String(error));
  log("error", `offscreen boot failed: ${String(error)}`);
});
