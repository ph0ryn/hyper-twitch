import { storage } from "#imports";

export type FeatureDefinition = Readonly<{
  defaultEnabled: boolean;
  description: string;
  label: string;
}>;

export const featureDefinitions = {
  keyboardShortcuts: {
    defaultEnabled: true,
    description: "Skip 10s with ← / →, 30s with J / L. Press K to play or pause.",
    label: "Playback shortcuts",
  },
  overlayFeedback: {
    defaultEnabled: true,
    description: "Show seek amounts, muted-section skips, and play/pause feedback.",
    label: "Playback feedback",
  },
  skipMutedSegments: {
    defaultEnabled: true,
    description: "Automatically skip sections Twitch has muted in VODs.",
    label: "Skip muted sections",
  },
  streamSync: {
    defaultEnabled: true,
    description: "Select Sync on live streams to align playback.",
    label: "Sync live streams",
  },
  streamTime: {
    defaultEnabled: true,
    description: "Show the approximate broadcast time in your timezone.",
    label: "Stream clock",
  },
  watchHistory: {
    defaultEnabled: true,
    description: "Track live and VOD viewing on the VOD timeline.",
    label: "Watch history",
  },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureId = keyof typeof featureDefinitions;

export function getFeatureEnabledSetting(featureId: FeatureId) {
  return storage.defineItem<boolean>(`local:features.${String(featureId)}.enabled`, {
    fallback: featureDefinitions[featureId].defaultEnabled,
  });
}
