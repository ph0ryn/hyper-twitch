import { browser, storage, type Browser } from "#imports";

import {
  isLiveWatchRecord,
  isVodWatchRecord,
  mergeWatchRanges,
  type LiveWatchRecord,
  type LiveWatchStreamRecord,
  type VodWatchRecord,
} from "../../utils/watchHistory/model";
import {
  isValidProvisionalId,
  isWatchHistoryRequest,
  isValidWatchRanges,
  createSerialQueue,
  normalizeWatchHistoryLogin,
  parseLiveWatchMetadata,
  parseVodWatchMetadata,
  watchHistoryMessages,
  watchHistoryStorageKeys,
  type LiveWatchMetadata,
  type MergeLiveRangesRequest,
  type MergeVodRangesRequest,
  type VodWatchMetadata,
} from "../../utils/watchHistory/protocol";

const GQL_ENDPOINT = "https://gql.twitch.tv/gql";
const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const LIVE_METADATA_OPERATION = "HyperTwitchLiveMetadata";
const LIVE_METADATA_QUERY = `query ${LIVE_METADATA_OPERATION}($login: String!) {
  user(login: $login) {
    id
    login
    stream {
      id
      createdAt
    }
  }
}`;
const VOD_METADATA_OPERATION = "HyperTwitchVodMetadata";
const VOD_METADATA_QUERY = `query ${VOD_METADATA_OPERATION}($videoId: ID!) {
  video(id: $videoId) {
    id
    owner {
      id
      login
    }
    recordedAt
    broadcastType
  }
}`;
const GQL_TIMEOUT_MS = 5_000;
const LIVE_METADATA_CACHE_TTL_MS = 60_000;

type Metadata = LiveWatchMetadata | VodWatchMetadata;

const liveMetadataCache = new Map<string, { expiresAt: number; metadata: LiveWatchMetadata }>();
const vodMetadataCache = new Map<string, VodWatchMetadata>();
const pendingMetadata = new Map<string, Promise<Metadata | null>>();

const enqueueWrite = createSerialQueue();

function defaultVodRecord(videoId: string): VodWatchRecord {
  return {
    kind: "vod",
    ranges: [],
    updatedAt: 0,
    version: 1,
    videoId,
  };
}

function defaultLiveRecord(login: string, ownerId?: string): LiveWatchRecord {
  const record: LiveWatchRecord = {
    kind: "live",
    login,
    streams: {},
    updatedAt: 0,
    version: 1,
  };

  if (ownerId) {
    record.ownerId = ownerId;
  }

  return record;
}

async function queryMetadata(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), GQL_TIMEOUT_MS);

  try {
    return await globalThis.fetch(GQL_ENDPOINT, {
      body: JSON.stringify({ operationName, query, variables }),
      cache: "no-store",
      credentials: "omit",
      headers: {
        "Client-ID": TWITCH_WEB_CLIENT_ID,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function fetchLiveMetadata(login: string) {
  const response = await queryMetadata(LIVE_METADATA_OPERATION, LIVE_METADATA_QUERY, {
    login,
  });

  if (!response.ok) {
    return null;
  }

  return parseLiveWatchMetadata(await response.json(), login);
}

async function fetchVodMetadata(videoId: string) {
  const response = await queryMetadata(VOD_METADATA_OPERATION, VOD_METADATA_QUERY, {
    videoId,
  });

  if (!response.ok) {
    return null;
  }

  return parseVodWatchMetadata(await response.json(), videoId);
}

async function getLiveMetadata(login: string) {
  const cached = liveMetadataCache.get(login);

  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.metadata;
    }

    liveMetadataCache.delete(login);
  }

  const key = `live:${login}`;
  const pending = pendingMetadata.get(key);

  if (pending) {
    return (await pending) as LiveWatchMetadata | null;
  }

  const request = fetchLiveMetadata(login).catch(() => null);

  pendingMetadata.set(key, request);

  try {
    const metadata = await request;

    if (metadata) {
      liveMetadataCache.set(login, {
        expiresAt: Date.now() + LIVE_METADATA_CACHE_TTL_MS,
        metadata,
      });
    }

    return metadata;
  } finally {
    if (pendingMetadata.get(key) === request) {
      pendingMetadata.delete(key);
    }
  }
}

async function getVodMetadata(videoId: string) {
  const cached = vodMetadataCache.get(videoId);

  if (cached) {
    return cached;
  }

  const key = `vod:${videoId}`;
  const pending = pendingMetadata.get(key);

  if (pending) {
    return (await pending) as VodWatchMetadata | null;
  }

  const request = fetchVodMetadata(videoId).catch(() => null);

  pendingMetadata.set(key, request);

  try {
    const metadata = await request;

    if (metadata) {
      vodMetadataCache.set(videoId, metadata);
    }

    return metadata;
  } finally {
    if (pendingMetadata.get(key) === request) {
      pendingMetadata.delete(key);
    }
  }
}

async function mergeVodRanges(request: MergeVodRangesRequest) {
  const key = watchHistoryStorageKeys.vod(request.videoId);

  return enqueueWrite(async () => {
    const previous = await storage.getItem<VodWatchRecord>(key);
    let record = defaultVodRecord(request.videoId);

    if (isVodWatchRecord(previous) && previous.videoId === request.videoId) {
      record = previous;
    }

    const ranges = mergeWatchRanges([...record.ranges, ...request.ranges]);
    const next: VodWatchRecord = { ...record, ranges, updatedAt: Date.now() };

    await storage.setItem(key, next);

    return { key, record: next };
  });
}

async function mergeLiveRanges(request: MergeLiveRangesRequest) {
  const login = normalizeWatchHistoryLogin(request.login);

  if (!login || !isValidProvisionalId(request.provisionalId)) {
    return null;
  }

  const metadata = await getLiveMetadata(login);
  const identity = metadata?.ownerId ?? login;
  const streamId = metadata?.streamId ?? request.provisionalId;
  const key = watchHistoryStorageKeys.live(identity);

  return enqueueWrite(async () => {
    const previous = await storage.getItem<LiveWatchRecord>(key);
    let record = defaultLiveRecord(login, metadata?.ownerId);

    const sameOwner = metadata?.ownerId !== undefined && previous?.ownerId === metadata.ownerId;

    if (isLiveWatchRecord(previous) && (previous.login === login || sameOwner)) {
      record = previous;
    }

    if (metadata?.ownerId && record.ownerId !== metadata.ownerId) {
      record = { ...record, ownerId: metadata.ownerId };
    }

    if (record.login !== login) {
      record = { ...record, login };
    }

    const previousStream = record.streams[streamId];
    const ranges = mergeWatchRanges([...(previousStream?.ranges ?? []), ...request.ranges]);
    const updatedAt = Date.now();
    const nextStream: LiveWatchStreamRecord = {
      ranges,
      updatedAt,
    };

    if (metadata?.createdAtMs !== undefined) {
      nextStream.createdAtMs = metadata.createdAtMs;
    } else if (previousStream?.createdAtMs !== undefined) {
      nextStream.createdAtMs = previousStream.createdAtMs;
    }

    if (metadata?.streamId !== undefined) {
      nextStream.streamId = metadata.streamId;
    } else if (previousStream?.streamId !== undefined) {
      nextStream.streamId = previousStream.streamId;
    }

    const next: LiveWatchRecord = {
      ...record,
      streams: {
        ...record.streams,
        [streamId]: nextStream,
      },
      updatedAt,
    };

    await storage.setItem(key, next);

    return { key, record: next };
  });
}

function handleMessage(message: unknown, sender: Browser.runtime.MessageSender) {
  if (sender.tab?.id === undefined || !isWatchHistoryRequest(message)) {
    return undefined;
  }

  if (message.type === watchHistoryMessages.getLiveMetadata) {
    const login = normalizeWatchHistoryLogin(message.login);

    if (!login) {
      return Promise.resolve(null);
    }

    return getLiveMetadata(login);
  }

  if (message.type === watchHistoryMessages.getVodMetadata) {
    return getVodMetadata(message.videoId);
  }

  if (message.type === watchHistoryMessages.mergeVodRanges) {
    if (!isValidWatchRanges(message.ranges)) {
      return Promise.resolve(null);
    }

    return mergeVodRanges(message);
  }

  if (!isValidWatchRanges(message.ranges)) {
    return Promise.resolve(null);
  }

  return mergeLiveRanges(message);
}

export function installWatchHistoryBackground() {
  browser.runtime.onMessage.addListener(handleMessage);
}
