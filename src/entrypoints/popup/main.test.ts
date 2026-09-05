// @vitest-environment happy-dom
import { readFileSync } from "node:fs";

import { beforeEach, expect, test, vi } from "vitest";

import { browser } from "#imports";

const markup = readFileSync("src/entrypoints/popup/index.html", "utf8")
  .split("<body>")[1]!
  .split("<script")[0]!;

beforeEach(async () => {
  vi.resetModules();
  await browser.storage.local.clear();
  globalThis.document.body.innerHTML = markup;
});

test("groups all five settings and preserves a saved toggle after reopening", async () => {
  await browser.storage.local.set({ "features.streamTime.enabled": false });
  await import("./main");
  const controls = [...globalThis.document.querySelectorAll<HTMLInputElement>('[role="switch"]')];

  await vi.waitFor(() => expect(controls.every((control) => !control.disabled)).toBe(true));
  expect(controls).toHaveLength(5);

  expect(
    globalThis.document.querySelector("#playback-features")?.querySelectorAll("input"),
  ).toHaveLength(2);

  expect(
    globalThis.document.querySelector("#timeline-features")?.querySelectorAll("input"),
  ).toHaveLength(3);

  const clock = globalThis.document.querySelector<HTMLInputElement>("#feature-streamTime")!;

  expect(clock.checked).toBe(false);
  clock.click();

  await vi.waitFor(async () => {
    expect(await browser.storage.local.get("features.streamTime.enabled")).toEqual({
      "features.streamTime.enabled": true,
    });
  });

  vi.resetModules();
  globalThis.document.body.innerHTML = markup;
  await import("./main");

  await vi.waitFor(() =>
    expect(
      globalThis.document.querySelector<HTMLInputElement>("#feature-streamTime")?.checked,
    ).toBe(true),
  );
});
