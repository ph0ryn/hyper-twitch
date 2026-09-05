const VIEWER_COUNT_SELECTOR = '[data-a-target="animated-channel-viewers-count"]';
const SYNC_STYLE_TEXT = `
[data-hyper-twitch-stream-sync] {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  gap: 6px;
  min-block-size: 32px;
  padding: 5px 10px;
  margin-inline-end: 8px;
  border: 1px solid var(--color-border-base, #3b3b44);
  border-radius: 8px;
  background: var(--color-background-base, #18181b);
  color: var(--color-text-base, #efeff1);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease-out;
}
[data-hyper-twitch-stream-sync]::before {
  content: "↔";
  font-size: 16px;
}
[data-hyper-twitch-stream-sync]:hover {
  background: var(--color-background-button-secondary-hover, #34343b);
}
[data-hyper-twitch-stream-sync]:focus-visible {
  outline: 2px solid #65b98c;
  outline-offset: 2px;
}
[data-hyper-twitch-stream-sync][aria-pressed="true"] {
  background: #98e1b9;
  border-color: #98e1b9;
  color: #152c20;
}
[data-hyper-twitch-stream-sync][aria-pressed="true"]:hover {
  background: #b8efcf;
}
[data-hyper-twitch-stream-sync][aria-busy="true"] {
  border-style: dashed;
  border-color: #176b53;
}
[data-hyper-twitch-stream-sync]:active { transform: scale(.96); }
@media (prefers-reduced-motion: reduce) {
  [data-hyper-twitch-stream-sync] { transition: none; }
  [data-hyper-twitch-stream-sync]:active { transform: none; }
}
`;

export function findViewerCountWrapper(metrics: HTMLElement) {
  const viewerCount = [...metrics.querySelectorAll<HTMLElement>(VIEWER_COUNT_SELECTOR)].find(
    (element) => element.getClientRects().length > 0,
  );

  if (!viewerCount) {
    return null;
  }

  let wrapper = viewerCount;

  while (wrapper.parentElement && wrapper.parentElement !== metrics) {
    wrapper = wrapper.parentElement;
  }

  if (wrapper.parentElement === metrics) {
    return wrapper;
  }

  return null;
}

export type SyncButtonState = "buffering" | "sync" | "synced" | "waiting";

export function renderSyncButton(
  syncButton: HTMLButtonElement,
  state: SyncButtonState,
  syncRequested: boolean,
) {
  const pressed = String(syncRequested);

  if (syncButton.dataset.state === state && syncButton.getAttribute("aria-pressed") === pressed) {
    return;
  }

  syncButton.textContent = "Sync";
  syncButton.dataset.state = state;
  syncButton.setAttribute("aria-pressed", pressed);
  syncButton.setAttribute("aria-busy", String(state === "buffering" || state === "waiting"));

  const titles = {
    buffering: "Adjusting playback speed. Select to stop syncing.",
    sync: "Sync this live stream with other live streams",
    synced: "Synced with other live streams. Select to stop syncing.",
    waiting: "Waiting for another live stream. Select to stop syncing.",
  } as const;

  syncButton.title = titles[state];

  if (syncRequested) {
    syncButton.setAttribute("aria-label", "Stop syncing this live stream");
  } else {
    syncButton.setAttribute("aria-label", "Sync this live stream with other live streams");
  }
}

export function ensureSyncStyle(style: HTMLStyleElement | undefined): HTMLStyleElement {
  if (style?.isConnected) {
    return style;
  }

  const parent = globalThis.document.head;

  style?.remove();
  const nextStyle = globalThis.document.createElement("style");

  nextStyle.dataset.hyperTwitchStreamSyncStyle = "";
  nextStyle.textContent = SYNC_STYLE_TEXT;
  parent.append(nextStyle);

  return nextStyle;
}

export function createSyncButton(onClick: () => void): HTMLButtonElement {
  const button = globalThis.document.createElement("button");

  button.type = "button";
  button.dataset.hyperTwitchStreamSync = "";
  button.setAttribute("aria-label", "Sync live streams to the same moment");
  button.addEventListener("click", onClick);

  return button;
}
