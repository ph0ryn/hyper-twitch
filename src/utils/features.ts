import { storage } from "#imports";

export type FeatureDefinition = Readonly<{
  defaultEnabled: boolean;
  description: string;
  label: string;
}>;

export const featureDefinitions = {
  keyboardShortcuts: {
    defaultEnabled: true,
    description:
      "Use arrows for 10-second skips, J/L for 30 seconds, and K to pause or play videos.",
    label: "Use playback shortcuts",
  },
  overlayFeedback: {
    defaultEnabled: true,
    description: "Show combined skip amounts and play/pause feedback for playback shortcuts.",
    label: "Show playback feedback",
  },
  streamSync: {
    defaultEnabled: true,
    description: "Line up live streams you select on Twitch at the same moment.",
    label: "Keep live streams in sync",
  },
  streamTime: {
    defaultEnabled: true,
    description: "See the approximate clock time beside Twitch’s player controls.",
    label: "Show stream time",
  },
  watchHistory: {
    defaultEnabled: true,
    description: "Track watched parts in live streams and past broadcasts.",
    label: "Remember watched sections",
  },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureId = keyof typeof featureDefinitions;

export function getFeatureEnabledSetting(featureId: FeatureId) {
  return storage.defineItem<boolean>(`local:features.${String(featureId)}.enabled`, {
    fallback: featureDefinitions[featureId].defaultEnabled,
  });
}
