export interface IndexedStreamSegment {
  durationMs: number;
  programDateTimeMs: number;
  url: string;
}

export interface StreamTimeSegment extends IndexedStreamSegment {
  completedAt: number;
}

export interface StreamTimeAnchor {
  absoluteEndMs: number;
  mediaEnd: number;
}

export const streamTimeMessages = {
  getLatestSegment: "streamTime:getLatestSegment",
  subscribe: "streamTime:subscribe",
  unsubscribe: "streamTime:unsubscribe",
} as const;

export interface StreamTimeRequest {
  sessionId: string;
  type: (typeof streamTimeMessages)[keyof typeof streamTimeMessages];
}

function parseDuration(value: string) {
  const duration = Number.parseFloat(value.split(",", 1)[0] ?? "");

  if (Number.isFinite(duration) && duration >= 0) {
    return duration * 1_000;
  }

  return undefined;
}

export function parseMediaPlaylist(text: string, playlistUrl: string) {
  const segments: IndexedStreamSegment[] = [];
  let durationMs: number | undefined = undefined;
  let programDateTimeMs: number | undefined = undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const parsed = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length));

      programDateTimeMs = undefined;

      if (Number.isFinite(parsed)) {
        programDateTimeMs = parsed;
      }
    } else if (line.startsWith("#EXTINF:")) {
      durationMs = parseDuration(line.slice("#EXTINF:".length));
    } else if (line === "#EXT-X-DISCONTINUITY") {
      durationMs = undefined;
      programDateTimeMs = undefined;
    } else if (line && !line.startsWith("#") && durationMs !== undefined) {
      if (programDateTimeMs !== undefined) {
        try {
          const url = new URL(line, playlistUrl);

          url.hash = "";
          segments.push({ durationMs, programDateTimeMs, url: url.href });
          programDateTimeMs += durationMs;
        } catch {
          programDateTimeMs = undefined;
        }
      }

      durationMs = undefined;
    }
  }

  return segments;
}

export function interpolateStreamTime(anchor: StreamTimeAnchor, currentTime: number) {
  return anchor.absoluteEndMs + (currentTime - anchor.mediaEnd) * 1_000;
}

export function interpolateArchiveTime(startMs: number, currentTime: number) {
  return startMs + currentTime * 1_000;
}
