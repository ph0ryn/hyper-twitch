import { interpolateStreamTime, type StreamTimeAnchor } from "../streamTime/protocol.ts";

export const WATCH_HISTORY_VERSION = 1 as const;
export const WATCH_RANGE_MERGE_GAP_MS = 1_000;

export type WatchRange = readonly [startMs: number, endMs: number];

export interface VodWatchRecord {
  version: typeof WATCH_HISTORY_VERSION;
  kind: "vod";
  videoId: string;
  updatedAt: number;
  ranges: WatchRange[];
}

export interface LiveWatchStreamRecord {
  streamId?: string;
  createdAtMs?: number;
  updatedAt: number;
  ranges: WatchRange[];
}

export interface LiveWatchRecord {
  version: typeof WATCH_HISTORY_VERSION;
  kind: "live";
  login: string;
  ownerId?: string;
  updatedAt: number;
  streams: Record<string, LiveWatchStreamRecord>;
}

export interface TimeRangesLike {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

export interface WatchRangeBounds {
  minimumMs?: number;
  maximumMs?: number;
  mergeGapMs?: number;
}

export interface VodWatchMetadata {
  recordedAtMs: number;
  durationMs: number;
  login?: string | null;
  ownerId?: string | null;
}

export interface WatchOverlaySegment {
  leftPercent: number;
  widthPercent: number;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return isFiniteInteger(value) && value >= 0;
}

function isWatchRange(value: unknown): value is WatchRange {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isFiniteInteger(value[0]) &&
    isFiniteInteger(value[1]) &&
    value[1] > value[0]
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMergeGap(value: number | undefined): number {
  if (isFiniteNonNegativeInteger(value)) {
    return value;
  }

  return WATCH_RANGE_MERGE_GAP_MS;
}

function normalizeBound(value: number | undefined, fallback: number): number {
  if (isFiniteInteger(value)) {
    return value;
  }

  return fallback;
}

export function normalizeLogin(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const login = value.trim().toLowerCase();

  if (!/^[a-z0-9_]{1,25}$/.test(login)) {
    return null;
  }

  return login;
}

export function playbackTimestampToMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const parts = value.trim().split(":");

  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }

  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  let hours = 0;

  if (parts.length === 3) {
    hours = Number(parts[0]);
  }

  if (seconds >= 60 || minutes >= 60) {
    return null;
  }

  const timestampMs = (hours * 3_600 + minutes * 60 + seconds) * 1_000;

  if (!Number.isSafeInteger(timestampMs)) {
    return null;
  }

  return timestampMs;
}

export function mergeWatchRanges(
  ranges: readonly WatchRange[],
  mergeGapMs = WATCH_RANGE_MERGE_GAP_MS,
): WatchRange[] {
  const gapMs = normalizeMergeGap(mergeGapMs);
  const sorted = ranges
    .filter(isWatchRange)
    .map(([startMs, endMs]) => [startMs, endMs] as WatchRange)
    .sort(
      ([leftStart, leftEnd], [rightStart, rightEnd]) =>
        leftStart - rightStart || leftEnd - rightEnd,
    );

  const merged: WatchRange[] = [];

  for (const [startMs, endMs] of sorted) {
    const previous = merged.at(-1);

    if (!previous || startMs > previous[1] + gapMs) {
      merged.push([startMs, endMs]);
    } else if (endMs > previous[1]) {
      merged[merged.length - 1] = [previous[0], endMs];
    }
  }

  return merged;
}

export function sanitizeWatchRanges(value: unknown, bounds: WatchRangeBounds = {}): WatchRange[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const minimumMs = normalizeBound(bounds.minimumMs, Number.MIN_SAFE_INTEGER);
  const maximumMs = normalizeBound(bounds.maximumMs, Number.MAX_SAFE_INTEGER);

  if (minimumMs > maximumMs) {
    return [];
  }

  const ranges: WatchRange[] = [];

  for (const range of value) {
    if (isWatchRange(range)) {
      const startMs = Math.max(minimumMs, range[0]);
      const endMs = Math.min(maximumMs, range[1]);

      if (endMs > startMs) {
        ranges.push([startMs, endMs]);
      }
    }
  }

  return mergeWatchRanges(ranges, bounds.mergeGapMs);
}

export function subtractWatchRanges(
  ranges: readonly WatchRange[],
  excludedRanges: readonly WatchRange[],
): WatchRange[] {
  const sources = sanitizeWatchRanges(ranges, { mergeGapMs: 0 });
  const exclusions = sanitizeWatchRanges(excludedRanges, { mergeGapMs: 0 });
  const remaining: WatchRange[] = [];

  for (const [sourceStartMs, sourceEndMs] of sources) {
    let cursorMs = sourceStartMs;

    for (const [excludedStartMs, excludedEndMs] of exclusions) {
      if (excludedEndMs > cursorMs && excludedStartMs >= sourceEndMs) {
        break;
      }

      if (excludedEndMs > cursorMs) {
        if (excludedStartMs > cursorMs) {
          remaining.push([cursorMs, Math.min(excludedStartMs, sourceEndMs)]);
        }

        cursorMs = Math.max(cursorMs, excludedEndMs);

        if (cursorMs >= sourceEndMs) {
          break;
        }
      }
    }

    if (cursorMs < sourceEndMs) {
      remaining.push([cursorMs, sourceEndMs]);
    }
  }

  return mergeWatchRanges(remaining, 0);
}

export function timeRangesToWatchRanges(
  timeRanges: TimeRangesLike | null | undefined,
  offsetMs = 0,
): WatchRange[] {
  if (!timeRanges || !isFiniteInteger(offsetMs) || !isFiniteNonNegativeInteger(timeRanges.length)) {
    return [];
  }

  const ranges: WatchRange[] = [];

  for (let index = 0; index < timeRanges.length; index += 1) {
    try {
      const startSeconds = timeRanges.start(index);
      const endSeconds = timeRanges.end(index);

      if (Number.isFinite(startSeconds) && Number.isFinite(endSeconds)) {
        const startMs = Math.round(offsetMs + startSeconds * 1_000);
        const endMs = Math.round(offsetMs + endSeconds * 1_000);

        if (endMs > startMs) {
          ranges.push([startMs, endMs]);
        }
      }
    } catch {
      // MediaSource ranges can disappear while the player is being replaced.
    }
  }

  return mergeWatchRanges(ranges);
}

function normalizeLiveMediaRanges(mediaRanges: TimeRangesLike | readonly WatchRange[]) {
  if (Array.isArray(mediaRanges)) {
    return sanitizeWatchRanges(mediaRanges);
  }

  return timeRangesToWatchRanges(mediaRanges as TimeRangesLike);
}

export function liveMediaRangesToUtcRanges(
  mediaRanges: TimeRangesLike | readonly WatchRange[],
  anchor: StreamTimeAnchor,
): WatchRange[] {
  if (!isFiniteInteger(anchor.absoluteEndMs) || !Number.isFinite(anchor.mediaEnd)) {
    return [];
  }

  const ranges = normalizeLiveMediaRanges(mediaRanges);

  return mergeWatchRanges(
    ranges.map(([startMs, endMs]) => [
      Math.round(interpolateStreamTime(anchor, startMs / 1_000)),
      Math.round(interpolateStreamTime(anchor, endMs / 1_000)),
    ]),
  );
}

function normalizeOwnerId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const ownerId = value.trim();

  if (ownerId.length > 0) {
    return ownerId;
  }

  return null;
}

function liveRecordMatchesMetadata(record: LiveWatchRecord, metadata: VodWatchMetadata) {
  const metadataOwnerId = normalizeOwnerId(metadata.ownerId);
  const recordOwnerId = normalizeOwnerId(record.ownerId);

  if (metadataOwnerId && recordOwnerId) {
    return metadataOwnerId === recordOwnerId;
  }

  const metadataLogin = normalizeLogin(metadata.login);
  const recordLogin = normalizeLogin(record.login);

  return metadataLogin !== null && metadataLogin === recordLogin;
}

export function toVodWatchRanges(
  vodRecord: VodWatchRecord | null | undefined,
  liveRecords: readonly LiveWatchRecord[],
  metadata: VodWatchMetadata,
): WatchRange[] {
  let durationMs: number | null = null;

  if (isFiniteNonNegativeInteger(metadata.durationMs)) {
    durationMs = metadata.durationMs;
  }

  const directRangeBounds: WatchRangeBounds = { minimumMs: 0 };

  if (durationMs !== null) {
    directRangeBounds.maximumMs = durationMs;
  }

  const directRanges = sanitizeWatchRanges(vodRecord?.ranges, directRangeBounds);

  if (!isFiniteInteger(metadata.recordedAtMs) || durationMs === null || durationMs <= 0) {
    return directRanges;
  }

  const liveRanges: WatchRange[] = [];

  for (const record of liveRecords) {
    if (isLiveWatchRecord(record) && liveRecordMatchesMetadata(record, metadata)) {
      for (const stream of Object.values(record.streams)) {
        for (const [startMs, endMs] of sanitizeWatchRanges(stream.ranges)) {
          const relativeStartMs = startMs - metadata.recordedAtMs;
          const relativeEndMs = endMs - metadata.recordedAtMs;
          const clippedStartMs = Math.max(0, relativeStartMs);
          const clippedEndMs = Math.min(durationMs, relativeEndMs);

          if (clippedEndMs > clippedStartMs) {
            liveRanges.push([clippedStartMs, clippedEndMs]);
          }
        }
      }
    }
  }

  return mergeWatchRanges([...directRanges, ...liveRanges]);
}

export function watchRangeToOverlay(
  range: WatchRange,
  durationMs: number,
): WatchOverlaySegment | null {
  if (!isFiniteNonNegativeInteger(durationMs) || durationMs <= 0) {
    return null;
  }

  const [startMs, endMs] = range;

  if (!isFiniteInteger(startMs) || !isFiniteInteger(endMs) || endMs <= startMs) {
    return null;
  }

  const clippedStartMs = Math.max(0, Math.min(durationMs, startMs));
  const clippedEndMs = Math.max(0, Math.min(durationMs, endMs));

  if (clippedEndMs <= clippedStartMs) {
    return null;
  }

  return {
    leftPercent: (clippedStartMs / durationMs) * 100,
    widthPercent: ((clippedEndMs - clippedStartMs) / durationMs) * 100,
  };
}

export function watchRangesToOverlay(
  ranges: readonly WatchRange[],
  durationMs: number,
): WatchOverlaySegment[] {
  return ranges
    .map((range) => watchRangeToOverlay(range, durationMs))
    .filter((segment): segment is WatchOverlaySegment => segment !== null);
}

function isStoredRangeList(value: unknown, nonNegative = false): value is WatchRange[] {
  return (
    Array.isArray(value) &&
    value.every(
      (range) => isWatchRange(range) && (!nonNegative || (range[0] >= 0 && range[1] >= 0)),
    )
  );
}

export function isVodWatchRecord(value: unknown): value is VodWatchRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === WATCH_HISTORY_VERSION &&
    value.kind === "vod" &&
    typeof value.videoId === "string" &&
    value.videoId.trim().length > 0 &&
    isFiniteNonNegativeInteger(value.updatedAt) &&
    isStoredRangeList(value.ranges, true)
  );
}

function isLiveWatchStreamRecord(value: unknown): value is LiveWatchStreamRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.streamId === undefined ||
      (typeof value.streamId === "string" && value.streamId !== "")) &&
    (value.createdAtMs === undefined || isFiniteNonNegativeInteger(value.createdAtMs)) &&
    isFiniteNonNegativeInteger(value.updatedAt) &&
    isStoredRangeList(value.ranges)
  );
}

export function isLiveWatchRecord(value: unknown): value is LiveWatchRecord {
  if (!isRecord(value)) {
    return false;
  }

  const login = normalizeLogin(value.login);

  if (
    value.version !== WATCH_HISTORY_VERSION ||
    value.kind !== "live" ||
    login === null ||
    login !== value.login ||
    (value.ownerId !== undefined && normalizeOwnerId(value.ownerId) === null) ||
    !isFiniteNonNegativeInteger(value.updatedAt) ||
    !isRecord(value.streams)
  ) {
    return false;
  }

  return Object.values(value.streams).every(isLiveWatchStreamRecord);
}
