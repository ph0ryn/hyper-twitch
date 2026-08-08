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

export interface StreamSyncReport {
  bufferedEndAbsoluteMs: number;
  bufferedStartAbsoluteMs: number;
  currentAbsoluteMs: number;
  joinedAt: number;
  joinedCurrentAbsoluteMs: number;
  reportedAt: number;
}

export type StreamSyncResponse =
  | { participantCount: number; status: "waiting" }
  | {
      participantCount: number;
      status: "ready";
      targetAbsoluteMs: number;
    };

export interface StreamSyncTargetState {
  targetAbsoluteMs: number;
  updatedAt: number;
}

export const streamTimeMessages = {
  getLatestSegment: "streamTime:getLatestSegment",
  leaveSync: "streamTime:leaveSync",
  subscribe: "streamTime:subscribe",
  unsubscribe: "streamTime:unsubscribe",
  updateSync: "streamTime:updateSync",
} as const;

export interface StreamSyncUpdateRequest {
  report: StreamSyncReport;
  sessionId: string;
  type: typeof streamTimeMessages.updateSync;
}

type StreamTimeMessage = (typeof streamTimeMessages)[keyof typeof streamTimeMessages];

export type StreamTimeRequest =
  | StreamSyncUpdateRequest
  | { sessionId: string; type: Exclude<StreamTimeMessage, typeof streamTimeMessages.updateSync> };

export interface StreamSyncCalculation {
  response: StreamSyncResponse;
  targetState: StreamSyncTargetState | undefined;
}

const STREAM_SYNC_BUFFER_END_GUARD_MS = 5_000;
const STREAM_SYNC_BUFFER_EDGE_MARGIN_MS = 250;

export function isStreamSyncReport(value: unknown): value is StreamSyncReport {
  if (!value || typeof value !== "object") {
    return false;
  }

  const report = value as Partial<StreamSyncReport>;

  return (
    Number.isFinite(report.bufferedEndAbsoluteMs) &&
    Number.isFinite(report.bufferedStartAbsoluteMs) &&
    Number.isFinite(report.currentAbsoluteMs) &&
    Number.isFinite(report.joinedAt) &&
    Number.isFinite(report.joinedCurrentAbsoluteMs) &&
    Number.isFinite(report.reportedAt) &&
    (report.bufferedStartAbsoluteMs as number) <= (report.bufferedEndAbsoluteMs as number)
  );
}

export function calculateStreamSync(
  participants: readonly StreamSyncReport[],
  targetState: StreamSyncTargetState | undefined,
  now: number,
): StreamSyncCalculation {
  const participantCount = participants.length;

  if (participantCount === 0) {
    return { response: { participantCount, status: "waiting" }, targetState: undefined };
  }

  if (participantCount === 1) {
    return { response: { participantCount, status: "waiting" }, targetState };
  }

  const candidate = Math.min(
    ...participants.map(
      (participant) => participant.currentAbsoluteMs + Math.max(0, now - participant.reportedAt),
    ),
    ...participants.map(
      (participant) =>
        participant.joinedCurrentAbsoluteMs +
        Math.max(0, now - participant.joinedAt) -
        STREAM_SYNC_BUFFER_END_GUARD_MS,
    ),
    ...participants.map(
      (participant) => participant.bufferedEndAbsoluteMs - STREAM_SYNC_BUFFER_END_GUARD_MS,
    ),
  );
  let projectedTarget = candidate;

  if (targetState) {
    projectedTarget = targetState.targetAbsoluteMs + Math.max(0, now - targetState.updatedAt);
  }

  const targetAbsoluteMs = Math.min(candidate, projectedTarget);
  const nextTargetState = { targetAbsoluteMs, updatedAt: now };
  const available = participants.every(
    (participant) =>
      participant.bufferedStartAbsoluteMs + STREAM_SYNC_BUFFER_EDGE_MARGIN_MS <= targetAbsoluteMs &&
      targetAbsoluteMs <= participant.bufferedEndAbsoluteMs - STREAM_SYNC_BUFFER_EDGE_MARGIN_MS,
  );

  if (!available) {
    return {
      response: { participantCount, status: "waiting" },
      targetState: nextTargetState,
    };
  }

  return {
    response: {
      participantCount,
      status: "ready",
      targetAbsoluteMs,
    },
    targetState: nextTargetState,
  };
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
