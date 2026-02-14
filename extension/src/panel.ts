type PlaybackStatus = "playing" | "paused" | "none";

interface PlayerDescriptor {
  busName: string;
  playerName: string;
}

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
  activePlayerBusName: string | null;
  selectionMode: "auto" | "manual";
  selectedPlayerBusName: string | null;
  availablePlayers: PlayerDescriptor[];
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


interface PanelElements {
  health: HTMLSpanElement;
  baseUrl: HTMLInputElement;
  saveBtn: HTMLButtonElement;
  pingBtn: HTMLButtonElement;
  status: HTMLDivElement;
  logs: HTMLPreElement;
  clearLogs: HTMLButtonElement;
  playerMode: HTMLSelectElement;
  playerSelect: HTMLSelectElement;
}
const DEFAULT_BASE_URL = "http://penguin.linux.test:5167";
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
let isShuttingDown = false;
let positionSyncTimer: number | null = null;
let reconnectTimer: number | null = null;


const el: PanelElements = {
  health: document.querySelector<HTMLSpanElement>("#health")!,
  baseUrl: document.querySelector<HTMLInputElement>("#baseUrl")!,
  saveBtn: document.querySelector<HTMLButtonElement>("#saveBaseUrl")!,
  pingBtn: document.querySelector<HTMLButtonElement>("#ping")!,
  status: document.querySelector<HTMLDivElement>("#status")!,
  logs: document.querySelector<HTMLPreElement>("#logs")!,
  clearLogs: document.querySelector<HTMLButtonElement>("#clearLogs")!,
  playerMode: document.querySelector<HTMLSelectElement>("#playerMode")!,
  playerSelect: document.querySelector<HTMLSelectElement>("#playerSelect")!,
};


function removeDuplicateSelectorNodes(selector: string) {
  const nodes = Array.from(document.querySelectorAll(selector));
  if (nodes.length <= 1) {
    return;
  }

  for (const node of nodes.slice(1)) {
    const container = node.closest("label") ?? node;
    container.remove();
  }

  log("warn", `removed duplicated selector nodes for ${selector}`);
}

function dedupePlayerSelectors() {
  removeDuplicateSelectorNodes("#playerMode");
  removeDuplicateSelectorNodes("#playerSelect");
}

function formatTs(value: number | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}


function renderPlayerSelectors(state: BridgeState | null) {
  const mode = state?.selectionMode ?? "auto";
  if (document.activeElement !== el.playerMode) {
    el.playerMode.value = mode;
  }

  const players = state?.availablePlayers ?? [];
  const selectedBus = state?.selectedPlayerBusName ?? "";
  const activeBus = state?.activePlayerBusName ?? "";

  const options = players
    .map((player) => {
      const activeTag = player.busName === activeBus ? "（当前）" : "";
      return `<option value="${player.busName}">${player.playerName} ${activeTag}</option>`;
    })
    .join("");

  el.playerSelect.innerHTML = options || '<option value="">(未发现播放器)</option>';
  el.playerSelect.disabled = mode !== "manual" || players.length === 0;
  el.playerSelect.value = selectedBus || activeBus || players[0]?.busName || "";
}

function renderPanel() {
  el.health.textContent = bridgeDebug.health;
  if (document.activeElement !== el.baseUrl) {
    el.baseUrl.value = currentBaseUrl;
  }

  const state = bridgeDebug.lastState;
  renderPlayerSelectors(state);
  const track = state?.title ? `${state.title} - ${(state.artist || []).join(", ")}` : "(无播放信息)";
  const pos = state
    ? `${(state.positionUs / 1_000_000).toFixed(1)}s / ${((state.durationUs || 0) / 1_000_000).toFixed(1)}s`
    : "-";

  el.status.textContent = [
    `health: ${bridgeDebug.health}`,
    `baseUrl: ${bridgeDebug.baseUrl}`,
    `last update: ${formatTs(bridgeDebug.lastUpdateAt)}`,
    `last event: ${formatTs(bridgeDebug.lastEventAt)}`,
    `last error: ${bridgeDebug.lastError ?? "-"}`,
    `player: ${state?.playerName ?? "-"}`,
    `mode: ${state?.selectionMode ?? "auto"}`,
    `selected: ${state?.selectedPlayerBusName ?? "-"}`,
    `playback: ${state?.playbackStatus ?? "-"}`,
    `track: ${track}`,
    `position: ${pos}`,
  ].join("\n");

  if (!bridgeLogs.length) {
    el.logs.textContent = "(no logs)";
    return;
  }

  el.logs.textContent = bridgeLogs
    .slice()
    .reverse()
    .map((item) => `${new Date(item.at).toLocaleTimeString()} [${item.level}] ${item.message}`)
    .join("\n");
}


async function savePlayerSelection(mode: "auto" | "manual", selectedPlayerBusName: string | null) {
  const payload = {
    mode,
    selectedPlayerBusName: selectedPlayerBusName && selectedPlayerBusName.length ? selectedPlayerBusName : null,
  };

  const res = await fetch(`${currentBaseUrl}/player-selection`, {
    method: "POST",
    mode: "cors",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`save player selection failed: ${res.status}`);
  }

  log("info", `player selection updated: mode=${mode}, selected=${payload.selectedPlayerBusName ?? "-"}`);
}

async function pingBackend() {
  const baseUrl = el.baseUrl.value.trim() || DEFAULT_BASE_URL;
  try {
    const res = await fetch(`${baseUrl}/healthz`, { method: "GET", mode: "cors" });
    const text = await res.text();
    log("info", `manual ping ${baseUrl}/healthz -> ${res.status} ${text}`);
  } catch (error) {
    log("error", `manual ping failed: ${String(error)}`);
  }
}

function bindPanelUiEvents() {
  el.saveBtn.addEventListener("click", () => {
    const baseUrl = el.baseUrl.value.trim() || DEFAULT_BASE_URL;
    void chrome.storage.local.set({ baseUrl });
  });

  el.pingBtn.addEventListener("click", () => {
    void pingBackend();
  });

  el.clearLogs.addEventListener("click", () => {
    bridgeLogs = [];
    void chrome.storage.local.set({ [BRIDGE_LOGS_KEY]: [] });
    renderPanel();
  });

  el.playerMode.addEventListener("change", () => {
    const mode = (el.playerMode.value === "manual" ? "manual" : "auto") as "auto" | "manual";
    const selectedPlayerBusName = mode === "manual" ? el.playerSelect.value : null;
    void savePlayerSelection(mode, selectedPlayerBusName).catch((error) => {
      log("error", `save player selection failed: ${String(error)}`);
    });
  });

  el.playerSelect.addEventListener("change", () => {
    if (el.playerMode.value !== "manual") {
      return;
    }

    void savePlayerSelection("manual", el.playerSelect.value).catch((error) => {
      log("error", `save player selection failed: ${String(error)}`);
    });
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.baseUrl) {
      currentBaseUrl = changes.baseUrl.newValue ?? DEFAULT_BASE_URL;
    }
    if (changes[BRIDGE_LOGS_KEY] && Array.isArray(changes[BRIDGE_LOGS_KEY].newValue)) {
      bridgeLogs = changes[BRIDGE_LOGS_KEY].newValue.slice(-LOG_LIMIT);
    }
    if (changes[BRIDGE_DEBUG_KEY] && changes[BRIDGE_DEBUG_KEY].newValue && typeof changes[BRIDGE_DEBUG_KEY].newValue === "object") {
      bridgeDebug = {
        ...bridgeDebug,
        ...changes[BRIDGE_DEBUG_KEY].newValue,
      };
    }
    renderPanel();
  });
}


function hasStorageApi(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

function pushLocalLog(item: LogRecord) {
  bridgeLogs = [...bridgeLogs, item].slice(-LOG_LIMIT);
}

function syncLogToBackground(item: LogRecord) {
  if (isShuttingDown) return;
  void sendMessageSafe({ type: "bridge:append-log", payload: item });
}

function syncDebugToBackground() {
  if (isShuttingDown) return;
  void sendMessageSafe({ type: "bridge:update-debug", payload: bridgeDebug });
}

function sendMessageSafe(message: unknown) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return Promise.resolve(null);
  }

  try {
    return chrome.runtime.sendMessage(message).catch((error) => {
      if (String(error).includes("Extension context invalidated")) {
        return null;
      }
      return null;
    });
  } catch (error) {
    if (String(error).includes("Extension context invalidated")) {
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  }
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
  renderPanel();
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
  renderPanel();
}

async function loadDebugData() {
  if (!hasStorageApi()) {
    const reply = await sendMessageSafe({ type: "bridge:get-storage-snapshot" });
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
  renderPanel();
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

async function syncKeepaliveAudioForPlayback(playbackState: PlaybackStatus) {
  if (!keepaliveAudioContext) {
    if (playbackState !== "playing") {
      return;
    }
    await ensureKeepaliveAudio();
    return;
  }

  if (playbackState === "playing") {
    if (keepaliveAudioContext.state === "suspended") {
      await keepaliveAudioContext.resume().catch((error) => {
        log("warn", `failed to resume keepalive audio context: ${String(error)}`);
        return undefined;
      });
    }
    return;
  }

  if (keepaliveAudioContext.state === "running") {
    await keepaliveAudioContext.suspend().catch((error) => {
      log("warn", `failed to suspend keepalive audio context: ${String(error)}`);
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
      };

      if (state.playbackStatus === "playing") {
        payload.playbackRate = Math.max(state.playbackRate, 0.1);
      }

      navigator.mediaSession.setPositionState(payload);
    }
  } catch (error) {
    log("warn", `setPositionState failed: ${String(error)}`);
  }
}

function startPositionSyncLoop() {
  if (positionSyncTimer !== null) {
    window.clearInterval(positionSyncTimer);
  }

  positionSyncTimer = window.setInterval(() => {
    if (isShuttingDown) return;
    const projected = getProjectedState();
    if (!projected || projected.playbackStatus !== "playing") return;
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
  await syncKeepaliveAudioForPlayback(playbackState);

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
  renderPanel();
}

function connectEvents() {
  if (isShuttingDown) return;

  eventSource?.close();
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

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
    if (isShuttingDown) return;

    const detail = `SSE error (${event.type})`;
    void setHealth("error", detail);
    log("warn", detail);
    eventSource?.close();

    reconnectTimer = window.setTimeout(connectEvents, 1500);
  };
}

function cleanup() {
  isShuttingDown = true;
  eventSource?.close();

  if (positionSyncTimer !== null) {
    window.clearInterval(positionSyncTimer);
    positionSyncTimer = null;
  }

  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function addLifecycleLogs() {
  window.addEventListener("pagehide", () => {
    console.warn("[bridge] panel pagehide fired");
    cleanup();
  });

  window.addEventListener("beforeunload", () => {
    console.warn("[bridge] panel beforeunload fired");
    cleanup();
  });

  document.addEventListener("visibilitychange", () => {
    log("info", `panel visibility=${document.visibilityState}`);
  });
}

async function boot() {
  dedupePlayerSelectors();
  bindPanelUiEvents();
  renderPanel();
  log("info", "panel boot start");

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
