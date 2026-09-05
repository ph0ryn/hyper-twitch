import { subscribePlaybackFeedback } from "./playbackFeedback";

import type { FeatureRuntime } from "./featureRuntime";

export const overlayFeedbackRuntime: FeatureRuntime = {
  mount(_ctx, signal) {
    let overlay: HTMLDivElement | undefined = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const clear = () => {
      clearTimeout(timer);
      overlay?.remove();
      overlay = undefined;
    };
    const unsubscribe = subscribePlaybackFeedback((feedback) => {
      clearTimeout(timer);

      if (feedback.kind === "clear") {
        clear();

        return;
      }

      const player = feedback.video.closest<HTMLElement>('[data-a-target="video-player"]');

      if (!player || !player.isConnected) {
        clear();

        return;
      }

      if (overlay?.parentElement !== player) {
        clear();
        overlay = globalThis.document.createElement("div");
        overlay.dataset.hyperTwitchFeedback = "";
        overlay.setAttribute("role", "status");
        overlay.setAttribute("aria-atomic", "true");

        overlay.style.cssText =
          "position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;pointer-events:none;";

        const label = globalThis.document.createElement("span");

        label.style.cssText =
          "padding:12px 20px;border-radius:10px;background:rgba(0,0,0,.78);color:white;font:600 28px/1.3 system-ui,sans-serif;font-variant-numeric:tabular-nums;";

        overlay.append(label);
        player.append(overlay);
      }

      const label = overlay.firstElementChild!;

      if (feedback.kind === "seek") {
        const seconds = Math.round(Math.abs(feedback.seconds) * 10) / 10;
        let sign = "";

        if (feedback.seconds < 0) {
          sign = "−";
        }

        if (feedback.seconds > 0) {
          sign = "+";
        }

        label.textContent = `${sign}${seconds} s`;

        if (feedback.pending) {
          return;
        }
      } else {
        label.textContent = "Playing";

        if (feedback.paused) {
          label.textContent = "Paused";
        }
      }

      timer = setTimeout(clear, 700);
    });
    const cleanup = () => {
      unsubscribe();
      clear();
      signal.removeEventListener("abort", cleanup);
    };

    signal.addEventListener("abort", cleanup, { once: true });

    return cleanup;
  },
};
