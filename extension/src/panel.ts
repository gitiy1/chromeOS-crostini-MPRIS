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
  canSeek: boolean;
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
const KEEPALIVE_FREQUENCY = 220;
const KEEPALIVE_GAIN = 0.00001;
const POSITION_SYNC_INTERVAL_MS = 1000;
const DEFAULT_SEEK_OFFSET_SECONDS = 10;

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
let keepaliveAudioContext: AudioContext | null = null;
let latestState: BridgeState | null = null;
let latestStateAtMs = 0;

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
      log("warn", "storage unavailable in panel; using runtime defaults");
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
  if (typeof AudioContext === "undefined") {
    log("warn", "AudioContext unavailable; keepalive audio cannot start");
    return;
  }

  if (!keepaliveAudioContext) {
    keepaliveAudioContext = new AudioContext();
    const oscillator = keepaliveAudioContext.createOscillator();
    const gainNode = keepaliveAudioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = KEEPALIVE_FREQUENCY;
    gainNode.gain.value = KEEPALIVE_GAIN;

    oscillator.connect(gainNode);
    gainNode.connect(keepaliveAudioContext.destination);
    oscillator.start();
  }

  if (keepaliveAudioContext.state === "suspended") {
    await keepaliveAudioContext.resume().catch((error) => {
      log("warn", `failed to resume keepalive audio context: ${String(error)}`);
      return undefined;
    });
  }
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

function getProjectedState(): BridgeState | null {
  if (!latestState) return null;
  if (latestState.playbackStatus !== "playing") return latestState;

  const elapsedUs = Math.max(0, (Date.now() - latestStateAtMs) * 1000);
  const projectedPositionUs = latestState.positionUs + elapsedUs * Math.max(latestState.playbackRate, 0.1);
  const maxDurationUs = latestState.durationUs ?? projectedPositionUs;

  return {
    ...latestState,
    positionUs: Math.min(projectedPositionUs, maxDurationUs),
  };
}

function updatePosition(state: BridgeState) {
  if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession)) return;

  const duration = Math.max((state.durationUs ?? 0) / 1_000_000, 0);
  const position = Math.max(state.positionUs / 1_000_000, 0);

  try {
    if (duration > 0) {
      const payload: MediaPositionState = {
        duration,
        position: Math.min(position, duration),
        playbackRate: state.playbackStatus === "playing" ? Math.max(state.playbackRate, 0.1) : 0,
      };
      navigator.mediaSession.setPositionState(payload);
    }
  } catch (error) {
    log("warn", `setPositionState failed: ${String(error)}`);
  }
}

function startPositionSyncLoop() {
  setInterval(() => {
    const projected = getProjectedState();
    if (!projected) return;
    updatePosition(projected);
  }, POSITION_SYNC_INTERVAL_MS);
}

async function sendControl(action: string) {
  await fetch(`${currentBaseUrl}/control/${action}`, { method: "POST", mode: "cors" });
  log("info", `sent control action: ${action}`);
}

async function sendSeekTo(positionUs: number) {
  await fetch(`${currentBaseUrl}/control/seek?positionUs=${Math.max(0, Math.floor(positionUs))}`, {
    method: "POST",
    mode: "cors",
  });
  log("info", `sent control seekTo: ${Math.floor(positionUs)}us`);
}

async function sendSeekBy(offsetUs: number) {
  await fetch(`${currentBaseUrl}/control/seek?offsetUs=${Math.floor(offsetUs)}`, {
    method: "POST",
    mode: "cors",
  });
  log("info", `sent control seekBy: ${Math.floor(offsetUs)}us`);
}

function resolvePlayPauseCommand(action: "play" | "pause"): "play" | "pause" {
  const status = bridgeDebug.lastState?.playbackStatus;
  if (action === "pause" && status === "paused") {
    return "play";
  }
  if (action === "play" && status === "playing") {
    return "pause";
  }
  return action;
}

function registerActionHandlers() {
  if (!("mediaSession" in navigator)) return;

  const setHandler = <A extends MediaSessionAction>(action: A, handler: MediaSessionActionHandler | null) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      log("warn", `action handler not supported: ${action}`);
    }
  };

  const sendMapped = (action: MediaSessionAction) => {
    let command: string;

    if (action === "play" || action === "pause") {
      command = resolvePlayPauseCommand(action);
    } else if (action === "previoustrack") {
      command = "previous";
    } else if (action === "nexttrack") {
      command = "next";
    } else if (action === "stop") {
      command = "stop";
    } else {
      return;
    }

    void sendControl(command).catch((error) => {
      void setHealth("error", `control failed: ${String(error)}`);
      log("error", `control action failed (${command}): ${String(error)}`);
    });
  };

  for (const action of ["play", "pause", "previoustrack", "nexttrack", "stop"] as const) {
    setHandler(action, () => {
      sendMapped(action);
    });
  }

  setHandler("seekbackward", (details) => {
    const offsetSeconds = details.seekOffset ?? DEFAULT_SEEK_OFFSET_SECONDS;
    void sendSeekBy(-offsetSeconds * 1_000_000).catch((error) => {
      void setHealth("error", `seekbackward failed: ${String(error)}`);
      log("error", `seekbackward failed: ${String(error)}`);
    });
  });

  setHandler("seekforward", (details) => {
    const offsetSeconds = details.seekOffset ?? DEFAULT_SEEK_OFFSET_SECONDS;
    void sendSeekBy(offsetSeconds * 1_000_000).catch((error) => {
      void setHealth("error", `seekforward failed: ${String(error)}`);
      log("error", `seekforward failed: ${String(error)}`);
    });
  });

  setHandler("seekto", (details) => {
    if (typeof details.seekTime !== "number") return;

    const targetUs = details.seekTime * 1_000_000;
    if (latestState) {
      latestState = { ...latestState, positionUs: Math.max(0, Math.floor(targetUs)) };
      latestStateAtMs = Date.now();
      updatePosition(latestState);
    }

    void sendSeekTo(targetUs).catch((error) => {
      void setHealth("error", `seekto failed: ${String(error)}`);
      log("error", `seekto failed: ${String(error)}`);
    });
  });
}

async function applyState(state: BridgeState) {
  latestState = state;
  latestStateAtMs = Date.now();

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
    log("warn", "panel pagehide fired");
  });

  window.addEventListener("beforeunload", () => {
    log("warn", "panel beforeunload fired");
  });

  document.addEventListener("visibilitychange", () => {
    log("info", `panel visibility=${document.visibilityState}`);
  });
}

async function boot() {
  log("info", "panel boot start");
  await ensureKeepaliveAudio();
  log("info", "keepalive audio initialized via AudioContext oscillator");

  addLifecycleLogs();
  startPositionSyncLoop();
  await loadDebugData();
  registerActionHandlers();
  connectEvents();
  log("info", "panel boot completed");
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
  log("error", `panel boot failed: ${String(error)}`);
});
