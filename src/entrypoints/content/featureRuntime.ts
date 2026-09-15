import { featureDefinitions, getFeatureEnabledSetting, type FeatureId } from "../../utils/features";
import { keyboardShortcutsRuntime } from "./keyboardShortcuts";
import { overlayFeedbackRuntime } from "./overlayFeedback";
import { skipMutedSegmentsRuntime } from "./skipMutedSegments";
import { streamSyncRuntime, streamTimeRuntime } from "./streamTime";
import { watchHistoryRuntime } from "./watchHistory";

import type { ContentScriptContext } from "#imports";

export interface FeatureRuntime {
  mount(ctx: ContentScriptContext, signal: AbortSignal): () => void;
}

export type FeatureRuntimeRegistry = Record<FeatureId, FeatureRuntime>;

export const featureRuntimes: FeatureRuntimeRegistry = {
  keyboardShortcuts: keyboardShortcutsRuntime,
  overlayFeedback: overlayFeedbackRuntime,
  skipMutedSegments: skipMutedSegmentsRuntime,
  streamSync: streamSyncRuntime,
  streamTime: streamTimeRuntime,
  watchHistory: watchHistoryRuntime,
};

interface ActiveRuntime {
  controller: AbortController;
  cleanup: () => void;
}

interface RuntimeState {
  active?: ActiveRuntime;
  enabled: boolean;
  id: FeatureId;
  runtime: FeatureRuntime;
  unwatch: () => void;
}

function reportError(id: FeatureId, error: unknown) {
  console.error(`[Hyper Twitch] Feature "${String(id)}" failed`, error);
}

export function runFeatureRuntimes(ctx: ContentScriptContext) {
  const states: RuntimeState[] = [];
  let disposed = false;

  const dispose = (state: RuntimeState) => {
    const active = state.active;

    state.active = undefined;

    if (!active) {
      return;
    }

    active.controller.abort();

    try {
      active.cleanup();
    } catch (error) {
      reportError(state.id, error);
    }
  };

  const mount = (state: RuntimeState) => {
    dispose(state);

    if (disposed) {
      return;
    }

    const controller = new AbortController();

    try {
      const cleanup = state.runtime.mount(ctx, controller.signal);

      if (typeof cleanup !== "function") {
        throw new TypeError("mount() must return a cleanup function");
      }

      state.active = { cleanup, controller };
    } catch (error) {
      controller.abort();
      reportError(state.id, error);
    }
  };

  const apply = (state: RuntimeState, enabled: boolean) => {
    if (disposed || state.enabled === enabled) {
      return;
    }

    state.enabled = enabled;

    if (enabled) {
      mount(state);
    } else {
      dispose(state);
    }
  };

  for (const id of Object.keys(featureDefinitions) as FeatureId[]) {
    const state = {
      enabled: false,
      id,
      runtime: featureRuntimes[id],
      unwatch: () => {},
    } satisfies RuntimeState;
    const setting = getFeatureEnabledSetting(id);
    let watched = false;

    state.unwatch = setting.watch((enabled) => {
      watched = true;
      apply(state, enabled);
    });

    states.push(state);

    void setting.getValue().then(
      (enabled) => {
        if (!watched) {
          apply(state, enabled);
        }
      },
      (error: unknown) => reportError(id, error),
    );
  }

  const disposeAll = () => {
    if (disposed) {
      return;
    }

    disposed = true;

    for (const state of states) {
      state.unwatch();
      dispose(state);
    }
  };

  ctx.onInvalidated(disposeAll);

  ctx.addEventListener(globalThis, "wxt:locationchange", () => {
    for (const state of states) {
      if (state.enabled) {
        mount(state);
      }
    }
  });

  if (ctx.isInvalid) {
    disposeAll();
  }
}
