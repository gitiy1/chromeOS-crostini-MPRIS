const DEFAULT_BASE_URL = "http://penguin.linux.test:5167";

const el = {
  baseUrl: document.querySelector<HTMLInputElement>("#baseUrl")!,
  saveBtn: document.querySelector<HTMLButtonElement>("#saveBaseUrl")!,
  pingBtn: document.querySelector<HTMLButtonElement>("#ping")!,
  openPanelBtn: document.querySelector<HTMLButtonElement>("#openPanel")!,
};

async function loadBaseUrl() {
  const data = await chrome.storage.local.get(["baseUrl"]);
  el.baseUrl.value = data.baseUrl ?? DEFAULT_BASE_URL;
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
    console.info(`[bridge] popup ping ${baseUrl}/healthz -> ${res.status} ${text}`);
  } catch (error) {
    console.error(`[bridge] popup ping failed: ${String(error)}`);
  }
}

el.saveBtn.addEventListener("click", () => {
  void saveBaseUrl();
});

el.pingBtn.addEventListener("click", () => {
  void pingBackend();
});

el.openPanelBtn.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "bridge:open-panel" });
});

void loadBaseUrl();
