import { storage } from "#imports";

export type FeatureDefinition = Readonly<{
  defaultEnabled: boolean;
  description: string;
  label: string;
}>;

export const featureDefinitions = {
  streamSync: {
    defaultEnabled: true,
    description: "Keep multiple live streams at the same moment.",
    label: "Enable stream sync",
  },
  streamTime: {
    defaultEnabled: true,
    description: "Show the time of day in the stream.",
    label: "Show stream time",
  },
  watchHistory: {
    defaultEnabled: true,
    description: "Show watched parts on archive seek bars.",
    label: "Track watched sections",
  },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureId = keyof typeof featureDefinitions;

export function getFeatureEnabledSetting(featureId: FeatureId) {
  return storage.defineItem<boolean>(`local:features.${String(featureId)}.enabled`, {
    fallback: featureDefinitions[featureId].defaultEnabled,
  });
}
