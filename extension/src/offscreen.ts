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

const DEFAULT_BASE_URL = "http://penguin.linux.test:5000";
const SILENCE_MP3 =
  "data:audio/mp3;base64,SUQzAwAAAAAAFlRFTkMAAAASAAAAAAABAAACcQCAgICAgICAgP/7kMQAAANIAAAAAExBTUUzLjk4LjIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let currentBaseUrl = DEFAULT_BASE_URL;
let eventSource: EventSource | null = null;

const audio = new Audio(SILENCE_MP3);
audio.loop = true;
audio.volume = 0;

async function loadBaseUrl() {
  const { baseUrl } = await chrome.storage.local.get("baseUrl");
  currentBaseUrl = baseUrl ?? DEFAULT_BASE_URL;
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
    console.debug("setPositionState failed", error);
  }
}

async function sendControl(action: string) {
  await fetch(`${currentBaseUrl}/control/${action}`, {
    method: "POST",
    mode: "cors",
  });
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
      void sendControl(command);
    });
  }

  navigator.mediaSession.setActionHandler("seekto", (details) => {
    if (typeof details.seekTime !== "number") return;
    // 可扩展：后端新增 seek 接口
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
}

function connectEvents() {
  eventSource?.close();
  eventSource = new EventSource(`${currentBaseUrl}/events`);

  eventSource.addEventListener("state", (event) => {
    const state = JSON.parse((event as MessageEvent).data) as BridgeState;
    void applyState(state);
  });

  eventSource.onerror = () => {
    eventSource?.close();
    setTimeout(connectEvents, 1500);
  };
}

async function boot() {
  await loadBaseUrl();
  registerActionHandlers();
  connectEvents();
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.baseUrl) {
    currentBaseUrl = changes.baseUrl.newValue ?? DEFAULT_BASE_URL;
    connectEvents();
  }
});

void boot();
