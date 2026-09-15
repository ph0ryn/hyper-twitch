const GQL_ENDPOINT = "https://gql.twitch.tv/gql";
const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL_TIMEOUT_MS = 5_000;

export async function queryTwitchGql(
  operation: { operationName: string; query: string; variables: Record<string, unknown> },
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), GQL_TIMEOUT_MS);
  let requestSignal = controller.signal;

  if (signal) {
    requestSignal = AbortSignal.any([signal, controller.signal]);
  }

  try {
    return await globalThis.fetch(GQL_ENDPOINT, {
      body: JSON.stringify(operation),
      cache: "no-store",
      credentials: "omit",
      headers: {
        "Client-ID": TWITCH_WEB_CLIENT_ID,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: requestSignal,
    });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}
