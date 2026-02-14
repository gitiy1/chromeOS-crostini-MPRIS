const BRIDGE_DEBUG_KEY = "bridgeDebug";
const BRIDGE_LOGS_KEY = "bridgeLogs";
const BASE_URL_KEY = "baseUrl";
const LOG_LIMIT = 200;
const PANEL_URL = "panel.html";

interface LogRecord {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
}

let panelWindowId: number | null = null;

async function openOrFocusPanelWindow() {
  if (panelWindowId !== null) {
    try {
      await chrome.windows.update(panelWindowId, { focused: true });
      return;
    } catch {
      panelWindowId = null;
    }
  }

  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(PANEL_URL),
    type: "popup",
    width: 480,
    height: 760,
    focused: true,
  });

  panelWindowId = created.id ?? null;
}

async function appendBridgeLog(item: LogRecord) {
  try {
    const data = await chrome.storage.local.get(BRIDGE_LOGS_KEY);
    const existing = Array.isArray(data[BRIDGE_LOGS_KEY]) ? (data[BRIDGE_LOGS_KEY] as LogRecord[]) : [];
    await chrome.storage.local.set({
      [BRIDGE_LOGS_KEY]: [...existing.slice(-LOG_LIMIT + 1), item],
    });
  } catch (error) {
    console.error("failed to append bridge log", error);
  }
}

async function updateBridgeDebug(debug: unknown) {
  try {
    await chrome.storage.local.set({ [BRIDGE_DEBUG_KEY]: debug });
  } catch (error) {
    console.error("failed to update bridge debug", error);
  }
}

async function getStorageSnapshot() {
  const data = await chrome.storage.local.get([BASE_URL_KEY, BRIDGE_DEBUG_KEY, BRIDGE_LOGS_KEY]);
  return {
    baseUrl: data[BASE_URL_KEY],
    bridgeDebug: data[BRIDGE_DEBUG_KEY],
    bridgeLogs: data[BRIDGE_LOGS_KEY],
  };
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === panelWindowId) {
    panelWindowId = null;
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "bridge:open-panel") {
    void openOrFocusPanelWindow()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "bridge:append-log" && message.payload) {
    void appendBridgeLog(message.payload as LogRecord);
    return;
  }

  if (message?.type === "bridge:update-debug" && message.payload) {
    void updateBridgeDebug(message.payload);
    return;
  }

  if (message?.type === "bridge:get-storage-snapshot") {
    void getStorageSnapshot()
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});
