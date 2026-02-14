const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreen: Promise<void> | null = null;

function isOffscreenAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("Only a single offscreen document may be created");
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (creatingOffscreen) {
    return creatingOffscreen;
  }

  creatingOffscreen = (async () => {
    if (await hasOffscreenDocument()) {
      return;
    }

    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Need a persistent Media Session for headset buttons",
      });
    } catch (error) {
      if (!isOffscreenAlreadyExistsError(error)) {
        throw error;
      }
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

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenSafely();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenSafely();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "bridge:ensure-offscreen") {
    ensureOffscreenSafely();
  }
});

ensureOffscreenSafely();
