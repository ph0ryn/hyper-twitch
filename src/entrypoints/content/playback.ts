interface LivePlaybackMode {
  kind: "live";
  key: string;
}

export interface VodPlaybackMode {
  kind: "vod";
  key: string;
  videoId: string;
}

export type PlaybackMode = LivePlaybackMode | VodPlaybackMode;
export type PlaybackKind = PlaybackMode["kind"];

export function findPlaybackMode(
  pathname = globalThis.location.pathname,
): PlaybackMode | undefined {
  const match = /^\/(?:videos\/|[a-zA-Z0-9_]+\/video\/)(\d+)(?:\/|$)/.exec(pathname);
  const vodId = match?.[1];

  if (vodId) {
    return { key: `vod:${vodId}`, kind: "vod", videoId: vodId };
  }

  const liveMatch = /^\/([a-zA-Z0-9_]{1,25})\/?$/.exec(pathname);

  if (liveMatch) {
    return { key: `live:/${liveMatch[1]}`, kind: "live" };
  }

  return undefined;
}

function parseTimestamp(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const timestamp = Date.parse(value);

  if (Number.isFinite(timestamp)) {
    return timestamp;
  }

  return undefined;
}

function isVideoObjectForId(object: Record<string, unknown>, videoId: string) {
  return [object.embedUrl, object.url].some((value) => {
    if (typeof value !== "string") {
      return false;
    }

    try {
      const url = new URL(value, globalThis.location.origin);
      const pathname = url.pathname.replace(/\/+$/, "");

      return url.origin === globalThis.location.origin && pathname === `/videos/${videoId}`;
    } catch {
      return false;
    }
  });
}

export function findVideoObjectStart(value: unknown, videoId?: string): number | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const timestamp = findVideoObjectStart(item, videoId);

      if (timestamp !== undefined) {
        return timestamp;
      }
    }

    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const object = value as Record<string, unknown>;
  const type = object["@type"];
  const isVideoObject =
    type === "VideoObject" || (Array.isArray(type) && type.includes("VideoObject"));

  if (isVideoObject && (videoId === undefined || isVideoObjectForId(object, videoId))) {
    const timestamp = parseTimestamp(object.uploadDate);

    if (timestamp !== undefined) {
      return timestamp;
    }
  }

  return findVideoObjectStart(object["@graph"], videoId);
}

function isVodDocument(document: Document) {
  return (
    document
      .querySelector('meta[name="amazonbot-content-type"]')
      ?.getAttribute("content")
      ?.trim()
      .toLowerCase() === "vod"
  );
}

function findStructuredArchiveStart(document: Document, videoId?: string) {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const timestamp = findVideoObjectStart(JSON.parse(script.textContent), videoId);

      if (timestamp !== undefined) {
        return timestamp;
      }
    } catch {
      // Twitch can include non-JSON script content with this MIME type.
    }
  }

  return undefined;
}

function parseArchiveStart(document: Document) {
  if (!isVodDocument(document)) {
    return null;
  }

  const metaTimestamp = parseTimestamp(
    document.querySelector('meta[property="og:video:release_date"]')?.getAttribute("content"),
  );

  return metaTimestamp ?? findStructuredArchiveStart(document) ?? null;
}

function parseCurrentArchiveStart(videoId: string) {
  const canonicalHref = globalThis.document
    .querySelector('link[rel="canonical"]')
    ?.getAttribute("href");

  if (!canonicalHref) {
    return null;
  }

  try {
    const canonicalUrl = new URL(canonicalHref, globalThis.location.origin);
    const pathname = canonicalUrl.pathname.replace(/\/+$/, "");

    if (canonicalUrl.origin !== globalThis.location.origin || pathname !== `/videos/${videoId}`) {
      return null;
    }
  } catch {
    return null;
  }

  if (!isVodDocument(globalThis.document)) {
    return null;
  }

  return findStructuredArchiveStart(globalThis.document, videoId) ?? null;
}

export async function fetchArchiveStart(videoId: string, signal: AbortSignal) {
  const currentStartMs = parseCurrentArchiveStart(videoId);

  if (currentStartMs !== null) {
    return currentStartMs;
  }

  try {
    const url = new URL(`/videos/${videoId}`, globalThis.location.origin);
    const response = await globalThis.fetch(url, {
      cache: "no-store",
      credentials: "omit",
      signal,
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();

    if (signal.aborted) {
      return null;
    }

    return parseArchiveStart(new globalThis.DOMParser().parseFromString(html, "text/html"));
  } catch {
    return null;
  }
}
