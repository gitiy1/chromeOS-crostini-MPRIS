const OFFSCREEN_URL = "offscreen.html";
const BRIDGE_DEBUG_KEY = "bridgeDebug";
const BRIDGE_LOGS_KEY = "bridgeLogs";
const LOG_LIMIT = 200;

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

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenSafely();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenSafely();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "bridge:ensure-offscreen") {
    ensureOffscreenSafely();
    return;
  }

  if (message?.type === "bridge:append-log" && message.payload) {
    void appendBridgeLog(message.payload as LogRecord);
    return;
  }

  if (message?.type === "bridge:update-debug" && message.payload) {
    void updateBridgeDebug(message.payload);
  }
});

ensureOffscreenSafely();
