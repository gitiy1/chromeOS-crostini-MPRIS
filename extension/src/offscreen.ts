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
const SILENCE_MP3 =
  "data:audio/mp3;base64,SUQzAwAAAAAAFlRFTkMAAAASAAAAAAABAAACcQCAgICAgICAgP/7kMQAAANIAAAAAExBTUUzLjk4LjIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
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

const audio = new Audio(SILENCE_MP3);
audio.loop = true;
audio.volume = 0;

function hasStorageApi(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

async function saveDebugState() {
  if (!hasStorageApi()) return;
  await chrome.storage.local.set({ [BRIDGE_DEBUG_KEY]: bridgeDebug });
}

async function saveLogs() {
  if (!hasStorageApi()) return;
  await chrome.storage.local.set({ [BRIDGE_LOGS_KEY]: bridgeLogs });
}

async function log(level: LogRecord["level"], message: string) {
  const item: LogRecord = { at: Date.now(), level, message };
  bridgeLogs = [...bridgeLogs, item].slice(-LOG_LIMIT);
  if (level === "error") {
    console.error(`[bridge] ${message}`);
  } else if (level === "warn") {
    console.warn(`[bridge] ${message}`);
  } else {
    console.info(`[bridge] ${message}`);
  }
  await saveLogs();
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
  if (!hasStorageApi()) return;

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

  await saveDebugState();
  await saveLogs();
}

function setPlaybackState(state: PlaybackStatus) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = state;
}

function setMetadata(state: BridgeState) {
  if (!("mediaSession" in navigator)) return;

  const artwork = state.artUrl
    ? [{ src: `${currentBaseUrl}/art?src=${encodeURIComponent(state.artUrl)}`, sizes: "512x512", type: "image/*" }]
    : [];

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
  const playbackRate = state.playbackStatus === "playing" ? Math.max(state.playbackRate, 0.1) : 0;

  try {
    if (duration > 0) {
      navigator.mediaSession.setPositionState({ duration, position: Math.min(position, duration), playbackRate });
    }
  } catch (error) {
    void log("warn", `setPositionState failed: ${String(error)}`);
  }
}

async function sendControl(action: string) {
  await fetch(`${currentBaseUrl}/control/${action}`, {
    method: "POST",
    mode: "cors",
  });
  await log("info", `sent control action: ${action}`);
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
        void log("error", `control action failed (${command}): ${String(error)}`);
      });
    });
  }

  navigator.mediaSession.setActionHandler("seekto", (details) => {
    if (typeof details.seekTime !== "number") return;
    void log("info", `seek requested by UI: ${details.seekTime.toFixed(3)}s (not implemented yet)`);
  });
}

async function ensureAudioFocus(active: boolean) {
  if (active) {
    if (audio.paused) {
      await audio.play().catch(() => undefined);
    }
  } else {
    audio.pause();
  }
}

async function applyState(state: BridgeState) {
  setMetadata(state);
  updatePosition(state);

  const playbackState: PlaybackStatus =
    state.playbackStatus === "playing"
      ? "playing"
      : state.playbackStatus === "paused"
        ? "paused"
        : "none";

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
  void log("info", `connecting to SSE: ${currentBaseUrl}/events`);

  eventSource = new EventSource(`${currentBaseUrl}/events`);

  eventSource.addEventListener("open", () => {
    void setHealth("connected");
    void log("info", "SSE connected");
  });

  eventSource.addEventListener("state", (event) => {
    const state = JSON.parse((event as MessageEvent).data) as BridgeState;
    void applyState(state);
  });

  eventSource.onerror = (event) => {
    const detail = `SSE error (${event.type})`;
    void setHealth("error", detail);
    void log("warn", detail);
    eventSource?.close();
    setTimeout(connectEvents, 1500);
  };
}

async function boot() {
  await loadDebugData();
  registerActionHandlers();
  connectEvents();
  await log("info", "offscreen boot completed");
}

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.baseUrl) {
      currentBaseUrl = changes.baseUrl.newValue ?? DEFAULT_BASE_URL;
      void setHealth("idle");
      void log("info", `baseUrl updated: ${currentBaseUrl}`);
      connectEvents();
    }
  });
}

void boot().catch((error) => {
  void setHealth("error", String(error));
  void log("error", `offscreen boot failed: ${String(error)}`);
});
