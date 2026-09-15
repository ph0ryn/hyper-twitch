export type PlaybackFeedback =
  | { kind: "clear" }
  | { kind: "seek"; video: HTMLVideoElement; seconds: number; pending: boolean }
  | { kind: "mutedSkip"; video: HTMLVideoElement; seconds: number }
  | { kind: "playback"; video: HTMLVideoElement; paused: boolean };

const subscribers = new Set<(feedback: PlaybackFeedback) => void>();

export function publishPlaybackFeedback(feedback: PlaybackFeedback) {
  for (const subscriber of subscribers) {
    subscriber(feedback);
  }
}

export function subscribePlaybackFeedback(subscriber: (feedback: PlaybackFeedback) => void) {
  subscribers.add(subscriber);

  return () => {
    subscribers.delete(subscriber);
  };
}
