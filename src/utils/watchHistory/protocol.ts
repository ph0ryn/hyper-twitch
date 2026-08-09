import type { LiveWatchRecord, VodWatchRecord, WatchRange } from "./model";

export const watchHistoryMessages = {
  getLiveMetadata: "watchHistory:getLiveMetadata",
  getVodMetadata: "watchHistory:getVodMetadata",
  mergeLiveRanges: "watchHistory:mergeLiveRanges",
  mergeVodRanges: "watchHistory:mergeVodRanges",
} as const;

export interface LiveWatchMetadata {
  kind: "live";
  ownerId: string;
  login: string;
  streamId: string;
  createdAtMs: number;
}

export interface VodWatchMetadata {
  kind: "vod";
  videoId: string;
  ownerId: string;
  login: string;
  recordedAtMs: number;
  broadcastType: "ARCHIVE";
}

export type WatchHistoryMetadata = LiveWatchMetadata | VodWatchMetadata;

export interface GetLiveMetadataRequest {
  type: typeof watchHistoryMessages.getLiveMetadata;
  login: string;
}

export interface GetVodMetadataRequest {
  type: typeof watchHistoryMessages.getVodMetadata;
  videoId: string;
}

export interface MergeLiveRangesRequest {
  type: typeof watchHistoryMessages.mergeLiveRanges;
  login: string;
  provisionalId: string;
  ranges: WatchRange[];
}

export interface MergeVodRangesRequest {
  type: typeof watchHistoryMessages.mergeVodRanges;
  videoId: string;
  ranges: WatchRange[];
}

export type WatchHistoryRequest =
  | GetLiveMetadataRequest
  | GetVodMetadataRequest
  | MergeLiveRangesRequest
  | MergeVodRangesRequest;

export type WatchHistoryRecord = VodWatchRecord | LiveWatchRecord;

export const watchHistoryStorageKeys = {
  live(identity: string) {
    return `local:watchHistory.v1.live.${identity}` as const;
  },
  vod(videoId: string) {
    return `local:watchHistory.v1.vod.${videoId}` as const;
  },
};

const LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;
const NUMERIC_ID_PATTERN = /^\d{1,32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isValidLogin(value: unknown): value is string {
  return typeof value === "string" && LOGIN_PATTERN.test(value);
}

export function normalizeWatchHistoryLogin(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const login = value.trim().toLowerCase();

  if (!isValidLogin(login)) {
    return undefined;
  }

  return login;
}

export function isValidVideoId(value: unknown): value is string {
  return typeof value === "string" && NUMERIC_ID_PATTERN.test(value);
}

export function isValidOwnerId(value: unknown): value is string {
  return typeof value === "string" && NUMERIC_ID_PATTERN.test(value);
}

export function isValidStreamId(value: unknown): value is string {
  return typeof value === "string" && NUMERIC_ID_PATTERN.test(value);
}

export function isValidProvisionalId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isValidWatchRange(value: unknown): value is WatchRange {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Number.isInteger(value[0]) &&
    Number.isInteger(value[1]) &&
    value[0] >= 0 &&
    value[1] > value[0]
  );
}

export function isValidWatchRanges(value: unknown): value is WatchRange[] {
  return Array.isArray(value) && value.every(isValidWatchRange);
}

export function isLiveWatchMetadata(value: unknown): value is LiveWatchMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<LiveWatchMetadata>;

  return (
    metadata.kind === "live" &&
    isValidOwnerId(metadata.ownerId) &&
    isValidLogin(metadata.login) &&
    isValidStreamId(metadata.streamId) &&
    isNonNegativeInteger(metadata.createdAtMs)
  );
}

export function isVodWatchMetadata(value: unknown): value is VodWatchMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<VodWatchMetadata>;

  return (
    metadata.kind === "vod" &&
    isValidVideoId(metadata.videoId) &&
    isValidOwnerId(metadata.ownerId) &&
    isValidLogin(metadata.login) &&
    isNonNegativeInteger(metadata.recordedAtMs) &&
    metadata.broadcastType === "ARCHIVE"
  );
}

export function isWatchHistoryRequest(value: unknown): value is WatchHistoryRequest {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }

  const request = value as {
    type?: unknown;
    login?: unknown;
    provisionalId?: unknown;
    ranges?: unknown;
    videoId?: unknown;
  };

  if (request.type === watchHistoryMessages.getLiveMetadata) {
    return normalizeWatchHistoryLogin(request.login) !== undefined;
  }

  if (request.type === watchHistoryMessages.getVodMetadata) {
    return isValidVideoId(request.videoId);
  }

  if (request.type === watchHistoryMessages.mergeVodRanges) {
    return isValidVideoId(request.videoId) && isValidWatchRanges(request.ranges);
  }

  if (request.type === watchHistoryMessages.mergeLiveRanges) {
    return (
      normalizeWatchHistoryLogin(request.login) !== undefined &&
      isValidProvisionalId(request.provisionalId) &&
      isValidWatchRanges(request.ranges)
    );
  }

  return false;
}

function getGraphqlPayload(value: unknown): Record<string, unknown> | null {
  let payload = value;

  if (Array.isArray(value)) {
    payload = value[0];
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as { data?: unknown; errors?: unknown };

  if (Array.isArray(record.errors) && record.errors.length > 0) {
    return null;
  }

  if (!record.data || typeof record.data !== "object") {
    return null;
  }

  return record.data as Record<string, unknown>;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      return undefined;
    }

    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp) || timestamp < 0) {
    return undefined;
  }

  return timestamp;
}

export function parseLiveWatchMetadata(
  value: unknown,
  requestedLogin: string,
): LiveWatchMetadata | null {
  const login = normalizeWatchHistoryLogin(requestedLogin);
  const data = getGraphqlPayload(value);
  const user = data?.user;

  if (!login || !user || typeof user !== "object") {
    return null;
  }

  const userRecord = user as {
    id?: unknown;
    login?: unknown;
    stream?: unknown;
  };
  const stream = userRecord.stream;

  if (!stream || typeof stream !== "object") {
    return null;
  }

  const streamRecord = stream as {
    id?: unknown;
    createdAt?: unknown;
  };
  const responseLogin = normalizeWatchHistoryLogin(userRecord.login);
  const createdAtMs = parseTimestamp(streamRecord.createdAt);

  if (
    !isValidOwnerId(userRecord.id) ||
    responseLogin !== login ||
    !isValidStreamId(streamRecord.id) ||
    createdAtMs === undefined
  ) {
    return null;
  }

  return {
    createdAtMs,
    kind: "live",
    login,
    ownerId: userRecord.id,
    streamId: streamRecord.id,
  };
}

export function parseVodWatchMetadata(
  value: unknown,
  requestedVideoId: string,
): VodWatchMetadata | null {
  const data = getGraphqlPayload(value);
  const video = data?.video;

  if (!isValidVideoId(requestedVideoId) || !video || typeof video !== "object") {
    return null;
  }

  const videoRecord = video as {
    id?: unknown;
    owner?: unknown;
    recordedAt?: unknown;
    broadcastType?: unknown;
  };
  const owner = videoRecord.owner;

  if (!owner || typeof owner !== "object") {
    return null;
  }

  const ownerRecord = owner as { id?: unknown; login?: unknown };
  const login = normalizeWatchHistoryLogin(ownerRecord.login);
  const recordedAtMs = parseTimestamp(videoRecord.recordedAt);

  if (
    videoRecord.id !== requestedVideoId ||
    !isValidOwnerId(ownerRecord.id) ||
    !login ||
    recordedAtMs === undefined ||
    videoRecord.broadcastType !== "ARCHIVE"
  ) {
    return null;
  }

  return {
    broadcastType: "ARCHIVE",
    kind: "vod",
    login,
    ownerId: ownerRecord.id,
    recordedAtMs,
    videoId: requestedVideoId,
  };
}

export function createSerialQueue() {
  let tail = Promise.resolve();

  return function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);

    tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  };
}
