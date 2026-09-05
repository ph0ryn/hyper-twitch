import {
  featureDefinitions,
  getFeatureEnabledSetting,
  type FeatureDefinition,
} from "../../utils/features";

type FeatureId = keyof typeof featureDefinitions;
type FeatureSetting = ReturnType<typeof getFeatureEnabledSetting>;

const popupDocument = globalThis.document;
const featureList = popupDocument.querySelector<HTMLElement>("#feature-list");
const playbackFeatures = popupDocument.querySelector<HTMLElement>("#playback-features");
const timelineFeatures = popupDocument.querySelector<HTMLElement>("#timeline-features");
const emptyState = popupDocument.querySelector<HTMLElement>("#empty-state");
const status = popupDocument.querySelector<HTMLElement>("#status");

if (!featureList || !playbackFeatures || !timelineFeatures || !emptyState || !status) {
  throw new Error("Popup markup is missing required elements");
}

const statusElement = status;
const entries = Object.entries(featureDefinitions) as [FeatureId, FeatureDefinition][];

emptyState.hidden = entries.length > 0;

for (const [featureId, definition] of entries) {
  const { checkbox, setting } = createFeatureRow(featureId);

  let group = timelineFeatures;

  if (featureId === "keyboardShortcuts" || featureId === "overlayFeedback") {
    group = playbackFeatures;
  }

  group.append(createFeatureRowElement(featureId, definition, checkbox));
  void loadFeatureValue(checkbox, setting);
}

function createFeatureRow(featureId: FeatureId): {
  checkbox: HTMLInputElement;
  setting: FeatureSetting;
} {
  const checkbox = popupDocument.createElement("input");

  checkbox.type = "checkbox";
  checkbox.className = "feature-control";
  checkbox.id = `feature-${String(featureId)}`;
  checkbox.disabled = true;
  checkbox.setAttribute("role", "switch");

  const setting = getFeatureEnabledSetting(featureId);

  checkbox.addEventListener("change", () => {
    void saveFeatureValue(checkbox, setting);
  });

  return { checkbox, setting };
}

function createFeatureRowElement(
  featureId: FeatureId,
  definition: FeatureDefinition,
  checkbox: HTMLInputElement,
): HTMLElement {
  const row = popupDocument.createElement("label");

  row.className = "feature-row";
  row.htmlFor = checkbox.id;

  const content = popupDocument.createElement("span");

  content.className = "feature-content";

  const label = popupDocument.createElement("span");

  label.className = "feature-label";
  label.id = `feature-${String(featureId)}-label`;
  label.textContent = definition.label;

  const description = popupDocument.createElement("span");

  description.className = "feature-description";
  description.id = `feature-${String(featureId)}-description`;
  description.textContent = definition.description;

  const visualSwitch = popupDocument.createElement("span");

  visualSwitch.className = "feature-switch";
  visualSwitch.setAttribute("aria-hidden", "true");

  const switchKnob = popupDocument.createElement("span");

  switchKnob.className = "feature-switch-knob";
  visualSwitch.append(switchKnob);

  checkbox.setAttribute("aria-describedby", description.id);
  checkbox.setAttribute("aria-labelledby", label.id);
  content.append(label, description);
  const icons: Record<FeatureId, string> = {
    keyboardShortcuts: "M4 6h16v12H4z M7 10h1m3 0h1m3 0h1M8 14h8",
    overlayFeedback: "M4 5h16v12H9l-5 3z M8 9h8m-8 4h5",
    streamSync: "M4 8h14l-3-3m3 3-3 3M20 16H6l3-3m-3 3 3 3",
    streamTime: "M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    watchHistory: "M3 12a9 9 0 1 0 9-9c-2.7 0-5.1 1.2-6.7 3L3 8 M3 3v5h5 M12 7v5l4 2",
  };
  const icon = popupDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = popupDocument.createElementNS("http://www.w3.org/2000/svg", "path");

  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("class", "feature-icon");
  icon.setAttribute("aria-hidden", "true");
  path.setAttribute("d", icons[featureId]);
  icon.append(path);
  row.append(icon, content, checkbox, visualSwitch);

  return row;
}

async function loadFeatureValue(checkbox: HTMLInputElement, setting: FeatureSetting) {
  try {
    checkbox.checked = (await setting.getValue()) === true;
    checkbox.disabled = false;
  } catch {
    showError("Unable to load feature settings. Reopen the popup to try again.");
  }
}

async function saveFeatureValue(checkbox: HTMLInputElement, setting: FeatureSetting) {
  const nextValue = checkbox.checked;

  checkbox.disabled = true;
  clearStatus();

  try {
    await setting.setValue(nextValue);
  } catch {
    checkbox.checked = !nextValue;
    showError("Unable to save this setting. Try again.");
  } finally {
    checkbox.disabled = false;
  }
}

function clearStatus() {
  statusElement.textContent = "Changes apply instantly in this browser.";
  statusElement.dataset.state = "";
}

function showError(message: string) {
  statusElement.textContent = message;
  statusElement.dataset.state = "error";
}
