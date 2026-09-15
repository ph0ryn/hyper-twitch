import { findPlaybackMode } from "./playback";
import { publishPlaybackFeedback, subscribePlaybackFeedback } from "./playbackFeedback";

import type { FeatureRuntime } from "./featureRuntime";

const SEEK_DELAY_MS = 300;
const SEEK_STEPS: Readonly<Record<string, number>> = {
  arrowleft: -10,
  arrowright: 10,
  j: -30,
  l: 30,
};
const INTERACTIVE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="menu"], [role="menuitem"], [role="listbox"], [role="combobox"], [role="dialog"], [role="tablist"]';

function findVideo() {
  if (findPlaybackMode()?.kind !== "vod") {
    return undefined;
  }

  const video = globalThis.document.querySelector<HTMLVideoElement>(
    '[data-a-target="video-player"] video',
  );

  if (!video || video.readyState === 0 || !Number.isFinite(video.duration) || video.duration <= 0) {
    return undefined;
  }

  return video;
}

function canHandle(event: KeyboardEvent, video: HTMLVideoElement) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) {
    return false;
  }

  const target = event.composedPath()[0];

  if (!(target instanceof globalThis.Element) || target.closest(INTERACTIVE_SELECTOR)) {
    return false;
  }

  // Leave navigation outside the player (including channel links) alone.
  return (
    target === globalThis.document.body ||
    target === globalThis.document.documentElement ||
    Boolean(video.closest('[data-a-target="video-player"]')?.contains(target))
  );
}

function boundedOffset(video: HTMLVideoElement, seconds: number) {
  return Math.max(0, Math.min(video.duration, video.currentTime + seconds)) - video.currentTime;
}

export const keyboardShortcutsRuntime: FeatureRuntime = {
  mount(_ctx, signal) {
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    const held = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    let pending: { video: HTMLVideoElement; seconds: number } | undefined = undefined;

    const reset = () => {
      clearTimeout(timer);
      pending?.video.removeEventListener("seeking", cancel);
      pending = undefined;
      held.clear();
    };
    const cancel = () => {
      reset();
      publishPlaybackFeedback({ kind: "clear" });
    };
    const unsubscribe = subscribePlaybackFeedback((feedback) => {
      if (feedback.kind === "mutedSkip") {
        // Cancel the pending seek before the automatic seek's native event arrives.
        reset();
      }
    });
    const commit = () => {
      const batch = pending;

      if (!batch || !batch.video.isConnected || findVideo() !== batch.video) {
        cancel();

        return;
      }

      const seconds = boundedOffset(batch.video, batch.seconds);

      reset();

      if (seconds !== 0) {
        batch.video.currentTime += seconds;
      }

      publishPlaybackFeedback({ kind: "seek", pending: false, seconds, video: batch.video });
    };
    const keydown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const step = SEEK_STEPS[key];

      if (step === undefined && key !== "k") {
        return;
      }

      const video = findVideo();

      if (!video || !canHandle(event, video)) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      if (key === "k") {
        if (event.repeat) {
          return;
        }

        if (video.paused) {
          void video
            .play()
            .then(() => {
              if (!controller.signal.aborted && findVideo() === video) {
                publishPlaybackFeedback({ kind: "playback", paused: false, video });
              }
            })
            .catch((error: unknown) => {
              console.error("[Hyper Twitch] Unable to resume playback", error);
            });
        } else {
          video.pause();

          publishPlaybackFeedback({ kind: "playback", paused: true, video });
        }

        return;
      }

      if (step === undefined) {
        return;
      }

      if (pending && pending.video !== video) {
        cancel();
      }

      if (!pending) {
        pending = { seconds: 0, video };
        video.addEventListener("seeking", cancel);
      }

      clearTimeout(timer);
      held.add(key);
      pending.seconds += step;

      publishPlaybackFeedback({
        kind: "seek",
        pending: true,
        seconds: boundedOffset(video, pending.seconds),
        video,
      });
    };
    const keyup = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (!held.delete(key)) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      if (held.size === 0) {
        timer = setTimeout(commit, SEEK_DELAY_MS);
      }
    };
    const cleanup = () => {
      controller.abort();
      unsubscribe();
      cancel();
      signal.removeEventListener("abort", cleanup);
    };

    globalThis.window.addEventListener("keydown", keydown, options);
    globalThis.window.addEventListener("keyup", keyup, options);
    globalThis.window.addEventListener("blur", cancel, options);

    globalThis.document.addEventListener(
      "visibilitychange",
      () => {
        if (globalThis.document.hidden) {
          cancel();
        }
      },
      options,
    );

    signal.addEventListener("abort", cleanup, { once: true });

    return cleanup;
  },
};
