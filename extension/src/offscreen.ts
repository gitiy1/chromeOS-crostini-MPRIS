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
const KEEPALIVE_SAMPLE_RATE = 44_100;
const KEEPALIVE_DURATION_SECONDS = 2;
const KEEPALIVE_FREQUENCY = 220;
const KEEPALIVE_AMPLITUDE = 2;

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
audio.autoplay = true;
audio.loop = true;
audio.preload = "auto";
audio.volume = 1;
audio.src = createKeepaliveWavUrl();


function createKeepaliveWavUrl(): string {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = KEEPALIVE_SAMPLE_RATE * blockAlign;
  const totalSamples = KEEPALIVE_SAMPLE_RATE * KEEPALIVE_DURATION_SECONDS;
  const dataSize = totalSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, KEEPALIVE_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < totalSamples; i += 1) {
    const sample = Math.round(
      KEEPALIVE_AMPLITUDE * Math.sin((2 * Math.PI * KEEPALIVE_FREQUENCY * i) / KEEPALIVE_SAMPLE_RATE),
    );
    view.setInt16(offset, sample, true);
    offset += 2;
  }

  const blob = new Blob([buffer], { type: "audio/wav" });
  return URL.createObjectURL(blob);
}

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
    const reply = await chrome.runtime.sendMessage({ type: "bridge:get-storage-snapshot" }).catch(() => null);
    if (reply?.ok && reply.payload) {
      currentBaseUrl = reply.payload.baseUrl ?? DEFAULT_BASE_URL;

      if (Array.isArray(reply.payload.bridgeLogs)) {
        bridgeLogs = reply.payload.bridgeLogs.slice(-LOG_LIMIT);
      }

      if (reply.payload.bridgeDebug && typeof reply.payload.bridgeDebug === "object") {
        bridgeDebug = {
          ...bridgeDebug,
          ...reply.payload.bridgeDebug,
          baseUrl: currentBaseUrl,
        };
      }

      syncDebugToBackground();
      log("info", "loaded debug snapshot via background relay");
    } else {
      log("warn", "storage unavailable in offscreen; using runtime defaults");
    }
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

async function ensureKeepaliveAudio() {
  if (!audio.paused) return;

  await audio.play().catch((error) => {
    log("warn", `failed to start keepalive audio: ${String(error)}`);
    return undefined;
  });
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

async function applyState(state: BridgeState) {
  setMetadata(state);
  updatePosition(state);

  const playbackState: PlaybackStatus =
    state.playbackStatus === "playing" ? "playing" : state.playbackStatus === "paused" ? "paused" : "none";

  setPlaybackState(playbackState);
  await ensureKeepaliveAudio();

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
  audio.addEventListener("ended", () => {
    void ensureKeepaliveAudio();
  });
  audio.addEventListener("pause", () => {
    void ensureKeepaliveAudio();
  });

  await ensureKeepaliveAudio();
  log("info", "keepalive audio initialized via generated wav");

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
