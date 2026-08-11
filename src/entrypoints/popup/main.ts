import {
  featureDefinitions,
  getFeatureEnabledSetting,
  type FeatureDefinition,
} from "../../utils/features";

type FeatureId = keyof typeof featureDefinitions;
type FeatureSetting = ReturnType<typeof getFeatureEnabledSetting>;

const popupDocument = globalThis.document;
const featureList = popupDocument.querySelector<HTMLElement>("#feature-list");
const emptyState = popupDocument.querySelector<HTMLElement>("#empty-state");
const status = popupDocument.querySelector<HTMLElement>("#status");

if (!featureList || !emptyState || !status) {
  throw new Error("Popup markup is missing required elements");
}

const statusElement = status;
const entries = Object.entries(featureDefinitions) as [FeatureId, FeatureDefinition][];

emptyState.hidden = entries.length > 0;

for (const [featureId, definition] of entries) {
  const { checkbox, setting } = createFeatureRow(featureId);

  featureList.append(createFeatureRowElement(featureId, definition, checkbox));
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
  row.append(content, checkbox, visualSwitch);

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
