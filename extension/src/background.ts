const OFFSCREEN_URL = "offscreen.html";
const BRIDGE_DEBUG_KEY = "bridgeDebug";
const BRIDGE_LOGS_KEY = "bridgeLogs";
const BASE_URL_KEY = "baseUrl";
const LOG_LIMIT = 200;
const OFFSCREEN_WATCHDOG_ALARM = "bridge-offscreen-watchdog";
const OFFSCREEN_WATCHDOG_MINUTES = 0.5;

interface LogRecord {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
}

let creatingOffscreen: Promise<void> | null = null;

function isOffscreenAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Only a single offscreen document may be created");
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = (async () => {
    if (await hasOffscreenDocument()) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Need a persistent Media Session for headset buttons",
      });
    } catch (error) {
      if (!isOffscreenAlreadyExistsError(error)) throw error;
    }
  })().finally(() => {
    creatingOffscreen = null;
  });

  return creatingOffscreen;
}

function ensureOffscreenSafely() {
  void ensureOffscreenDocument().catch((error) => {
    console.error("failed to ensure offscreen document", error);
  });
}

function scheduleOffscreenWatchdog() {
  chrome.alarms.create(OFFSCREEN_WATCHDOG_ALARM, { periodInMinutes: OFFSCREEN_WATCHDOG_MINUTES });
}

function bootstrapOffscreen() {
  scheduleOffscreenWatchdog();
  ensureOffscreenSafely();
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

chrome.runtime.onStartup.addListener(() => {
  bootstrapOffscreen();
});

chrome.runtime.onInstalled.addListener(() => {
  bootstrapOffscreen();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== OFFSCREEN_WATCHDOG_ALARM) return;
  ensureOffscreenSafely();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "bridge:ensure-offscreen") {
    ensureOffscreenSafely();
    return;
  }

  if (message?.type === "bridge:offscreen-unloading") {
    ensureOffscreenSafely();
    return;
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

bootstrapOffscreen();
