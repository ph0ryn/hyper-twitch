import { storage } from "#imports";

export type FeatureDefinition = Readonly<{
  description: string;
  label: string;
}>;

export const featureDefinitions = {} as const satisfies Record<string, FeatureDefinition>;

export type FeatureId = keyof typeof featureDefinitions;

export function getFeatureEnabledSetting(featureId: FeatureId) {
  return storage.defineItem<boolean>(`local:features.${String(featureId)}.enabled`, {
    fallback: false,
  });
}
