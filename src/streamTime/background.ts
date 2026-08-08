import { browser, type Browser } from "#imports";

import {
  parseMediaPlaylist,
  streamTimeMessages,
  type IndexedStreamSegment,
  type StreamTimeRequest,
  type StreamTimeSegment,
} from "./protocol";

const HLS_URLS = ["https://*.ttvnw.net/*"];
const MAX_ENTRIES = 512;

const activeSessionByTab = new Map<number, string>();
const closedSessions = new Set<string>();
const completedByUrl = new Map<string, Map<number, number>>();
const inFlightPlaylists = new Set<string>();
const latestByTab = new Map<number, StreamTimeSegment>();
const segmentsByUrl = new Map<string, IndexedStreamSegment>();

function capMap<K, V>(map: Map<K, V>) {
  while (map.size > MAX_ENTRIES) {
    map.delete(map.keys().next().value as K);
  }
}

function capSet<T>(set: Set<T>) {
  while (set.size > MAX_ENTRIES) {
    set.delete(set.values().next().value as T);
  }
}

function normalizeUrl(value: string) {
  const url = new URL(value);

  url.hash = "";

  return url.href;
}

function setLatest(tabId: number, segment: IndexedStreamSegment, completedAt: number) {
  const current = latestByTab.get(tabId);

  if (!current || current.completedAt <= completedAt) {
    latestByTab.set(tabId, { ...segment, completedAt });
  }
}

function rememberCompleted(url: string, tabId: number, completedAt: number) {
  const key = normalizeUrl(url);
  const indexed = segmentsByUrl.get(key);

  if (indexed) {
    setLatest(tabId, indexed, completedAt);

    return;
  }

  const completions = completedByUrl.get(key) ?? new Map<number, number>();

  completions.set(tabId, completedAt);
  completedByUrl.set(key, completions);
  capMap(completedByUrl);
}

function indexSegments(segments: IndexedStreamSegment[]) {
  for (const segment of segments) {
    segmentsByUrl.set(segment.url, segment);

    const completions = completedByUrl.get(segment.url);

    if (completions) {
      for (const [tabId, completedAt] of completions) {
        if (activeSessionByTab.has(tabId)) {
          setLatest(tabId, segment, completedAt);
        }
      }

      completedByUrl.delete(segment.url);
    }
  }

  capMap(segmentsByUrl);
}

async function fetchPlaylist(url: string) {
  if (inFlightPlaylists.has(url)) {
    return;
  }

  inFlightPlaylists.add(url);

  try {
    const response = await fetch(url, { cache: "no-store" });

    if (response.ok) {
      indexSegments(parseMediaPlaylist(await response.text(), url));
    }
  } catch {
    // The next Twitch playlist request retries after a transient failure.
  } finally {
    inFlightPlaylists.delete(url);
  }
}

function clearCapturedState(tabId: number) {
  latestByTab.delete(tabId);

  for (const [url, completions] of completedByUrl) {
    completions.delete(tabId);

    if (completions.size === 0) {
      completedByUrl.delete(url);
    }
  }
}

function clearTab(tabId: number) {
  activeSessionByTab.delete(tabId);
  clearCapturedState(tabId);
}

function subscribeTab(tabId: number, sessionId: string) {
  if (closedSessions.has(sessionId)) {
    return false;
  }

  activeSessionByTab.set(tabId, sessionId);
  clearCapturedState(tabId);

  return true;
}

function unsubscribeTab(tabId: number, sessionId: string) {
  closedSessions.add(sessionId);
  capSet(closedSessions);

  if (activeSessionByTab.get(tabId) === sessionId) {
    activeSessionByTab.delete(tabId);
    clearCapturedState(tabId);
  }
}

function isMediaSegmentUrl(value: string) {
  const pathname = new URL(value).pathname;

  return pathname.includes("/segment/") || /\.(?:m4s|mp4|ts)$/i.test(pathname);
}

function handleBeforeRequest(details: Browser.webRequest.OnBeforeRequestDetails) {
  if (
    details.tabId >= 0 &&
    activeSessionByTab.has(details.tabId) &&
    details.url.includes(".m3u8")
  ) {
    void fetchPlaylist(details.url);
  }

  return undefined;
}

function handleCompleted(details: Browser.webRequest.OnCompletedDetails) {
  if (
    details.tabId >= 0 &&
    activeSessionByTab.has(details.tabId) &&
    isMediaSegmentUrl(details.url)
  ) {
    rememberCompleted(details.url, details.tabId, details.timeStamp);
  }
}

function handleMessage(message: unknown, sender: Browser.runtime.MessageSender) {
  const tabId = sender.tab?.id;

  if (
    tabId === undefined ||
    typeof message !== "object" ||
    message === null ||
    !("sessionId" in message) ||
    !("type" in message)
  ) {
    return undefined;
  }

  const { sessionId, type } = message as Partial<StreamTimeRequest>;

  if (typeof sessionId !== "string") {
    return undefined;
  }

  if (type === streamTimeMessages.subscribe) {
    return Promise.resolve(subscribeTab(tabId, sessionId));
  }

  if (type === streamTimeMessages.unsubscribe) {
    unsubscribeTab(tabId, sessionId);

    return Promise.resolve(true);
  }

  if (type === streamTimeMessages.getLatestSegment) {
    const activeSession = activeSessionByTab.get(tabId);

    if (closedSessions.has(sessionId)) {
      return Promise.resolve(null);
    }

    if (activeSession === undefined) {
      activeSessionByTab.set(tabId, sessionId);
    } else if (activeSession !== sessionId) {
      return Promise.resolve(null);
    }

    return Promise.resolve(latestByTab.get(tabId) ?? null);
  }

  return undefined;
}

export function installStreamTimeBackground() {
  browser.tabs.onRemoved.addListener(clearTab);
  browser.webRequest.onBeforeRequest.addListener(handleBeforeRequest, { urls: HLS_URLS });
  browser.webRequest.onCompleted.addListener(handleCompleted, { urls: HLS_URLS });
  browser.runtime.onMessage.addListener(handleMessage);
}
