interface BridgeState {
  playerName: string;
  playbackStatus: "playing" | "paused" | "stopped" | "none";
  title: string | null;
  artist: string[];
  album: string | null;
  positionUs: number;
  durationUs: number | null;
}

interface BridgeDebugState {
  baseUrl: string;
  health: "idle" | "connecting" | "connected" | "error";
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

const BRIDGE_DEBUG_KEY = "bridgeDebug";
const BRIDGE_LOGS_KEY = "bridgeLogs";
const DEFAULT_BASE_URL = "http://penguin.linux.test:5000";

const el = {
  health: document.querySelector<HTMLSpanElement>("#health")!,
  baseUrl: document.querySelector<HTMLInputElement>("#baseUrl")!,
  saveBtn: document.querySelector<HTMLButtonElement>("#saveBaseUrl")!,
  pingBtn: document.querySelector<HTMLButtonElement>("#ping")!,
  openPanelBtn: document.querySelector<HTMLButtonElement>("#openPanel")!,
  status: document.querySelector<HTMLDivElement>("#status")!,
  logs: document.querySelector<HTMLPreElement>("#logs")!,
  clearLogs: document.querySelector<HTMLButtonElement>("#clearLogs")!,
};

function formatTs(value: number | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function renderStatus(debug: BridgeDebugState | null) {
  if (!debug) {
    el.health.textContent = "idle";
    el.status.textContent = "暂无状态";
    return;
  }

  el.health.textContent = debug.health;
  el.baseUrl.value = debug.baseUrl || DEFAULT_BASE_URL;

  const state = debug.lastState;
  const track = state?.title ? `${state.title} - ${(state.artist || []).join(", ")}` : "(无播放信息)";
  const pos = state ? `${(state.positionUs / 1_000_000).toFixed(1)}s / ${((state.durationUs || 0) / 1_000_000).toFixed(1)}s` : "-";

  el.status.textContent = [
    `health: ${debug.health}`,
    `baseUrl: ${debug.baseUrl}`,
    `last update: ${formatTs(debug.lastUpdateAt)}`,
    `last event: ${formatTs(debug.lastEventAt)}`,
    `last error: ${debug.lastError ?? "-"}`,
    `player: ${state?.playerName ?? "-"}`,
    `playback: ${state?.playbackStatus ?? "-"}`,
    `track: ${track}`,
    `position: ${pos}`,
  ].join("\n");
}

function renderLogs(logs: LogRecord[]) {
  if (!logs.length) {
    el.logs.textContent = "(no logs)";
    return;
  }
  el.logs.textContent = logs
    .slice()
    .reverse()
    .map((item) => `${new Date(item.at).toLocaleTimeString()} [${item.level}] ${item.message}`)
    .join("\n");
}

async function appendLog(record: LogRecord) {
  const data = await chrome.storage.local.get(BRIDGE_LOGS_KEY);
  const existing = Array.isArray(data[BRIDGE_LOGS_KEY]) ? (data[BRIDGE_LOGS_KEY] as LogRecord[]) : [];
  await chrome.storage.local.set({
    [BRIDGE_LOGS_KEY]: [...existing.slice(-199), record],
  });
}

async function loadAndRender() {
  const data = await chrome.storage.local.get(["baseUrl", BRIDGE_DEBUG_KEY, BRIDGE_LOGS_KEY]);
  renderStatus((data[BRIDGE_DEBUG_KEY] as BridgeDebugState | undefined) ?? null);
  renderLogs((data[BRIDGE_LOGS_KEY] as LogRecord[] | undefined) ?? []);

  if (!el.baseUrl.value) {
    el.baseUrl.value = data.baseUrl ?? DEFAULT_BASE_URL;
  }
}

async function saveBaseUrl() {
  const baseUrl = el.baseUrl.value.trim() || DEFAULT_BASE_URL;
  await chrome.storage.local.set({ baseUrl });
}

async function pingBackend() {
  const baseUrl = el.baseUrl.value.trim() || DEFAULT_BASE_URL;
  try {
    const res = await fetch(`${baseUrl}/healthz`, { method: "GET", mode: "cors" });
    const text = await res.text();
    await appendLog({
      at: Date.now(),
      level: "info",
      message: `manual ping ${baseUrl}/healthz -> ${res.status} ${text}`,
    });
  } catch (error) {
    await appendLog({
      at: Date.now(),
      level: "error",
      message: `manual ping failed: ${String(error)}`,
    });
  }
}

el.saveBtn.addEventListener("click", () => {
  void saveBaseUrl();
});

el.pingBtn.addEventListener("click", () => {
  void pingBackend();
});

el.clearLogs.addEventListener("click", async () => {
  await chrome.storage.local.set({ [BRIDGE_LOGS_KEY]: [] });
});

chrome.storage.onChanged.addListener(() => {
  void loadAndRender();
});

void loadAndRender();


el.openPanelBtn.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "bridge:open-panel" });
});
