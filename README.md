# Hyper Twitch

A browser extension for enhancing the Twitch viewing experience, built with
[WXT](https://wxt.dev/).

## Requirements

- Node.js supported by the configured pnpm and WXT versions
- pnpm 11.1.1 or compatible

This project enforces pnpm during installation. Do not use npm or yarn.

## Getting Started

Install dependencies and generate WXT's TypeScript configuration:

```sh
pnpm install
```

Start the development browser:

```sh
pnpm run dev
```

## Scripts

| Command           | Description                                   |
| ----------------- | --------------------------------------------- |
| `pnpm run dev`    | Start WXT in development mode.                |
| `pnpm run build`  | Build the extension into `.output/`.          |
| `pnpm run zip`    | Create a distributable extension archive.     |
| `pnpm run lint`   | Run ESLint and Oxlint with type checking.     |
| `pnpm run test`   | Run dependency-free logic tests with Node.js. |
| `pnpm run format` | Format the repository with oxfmt.             |
| `pnpm run fix`    | Apply Oxlint fixes, then format the project.  |

## Feature toggles

The registry in `src/features.ts` is the source of truth for feature metadata,
popup controls, and stored settings. Keep feature IDs stable and camelCase.

Each feature setting uses `local:features.<featureId>.enabled`. The metadata
`defaultEnabled` value is only the fallback for a missing key; a stored value,
including an explicit `false`, always wins. To add a feature, register its
metadata and matching content runtime in `src/features.ts` and
`src/featureRuntime.ts`. A runtime must implement `mount(ctx, signal)` and
return a cleanup function. The shared runner applies the initial state, watches
changes, and cleans up on disable, Twitch SPA navigation, or extension
invalidation.

The popup renders registered metadata automatically. Keep Twitch-side feature
code out of the popup bundle; feature toggles use local storage directly rather
than a general background message bus.

## Stream time

Stream time shows the approximate wall-clock timestamp of the current live
video or archive beside Twitch's stream controls. Live streams use HLS
`EXT-X-PROGRAM-DATE-TIME` metadata. Archives use the Twitch VOD start metadata
from the same-origin HTML plus the player's current position. The visible
value includes `≈` and may temporarily show `syncing…` while metadata or a
player timeline is not ready.

Stream time is enabled by default when no setting has been saved. A popup
choice always takes precedence. Twitch highlights and uploaded videos are not
treated as stream archives.

This feature has a narrowly scoped background worker because Twitch fetches HLS
media outside the content script. The worker is used only for live HLS capture;
archive timestamps do not require additional host permissions or an API.

## Stream sync

Stream sync adds a `Sync` button to the left of the live viewer count. Select it
on two or more live streams to keep them at the same moment. Hyper Twitch never
seeks the players. It checks drift every 100 ms and temporarily adjusts playback
speed between 0.5× and 1.5× until streams are within 100 ms, then returns them to
1×. The 100 ms threshold applies to Hyper Twitch's estimated wall-clock times.
A single participating stream waits for another one.
The wall-clock mapping remains approximate because Twitch does not expose an
exact public live-player timeline.

The popup setting is on by default, but each stream starts outside sync mode
until its button is selected. Sync mode does not apply to archives. Turning the
popup setting off or closing a participating stream leaves the remaining
playback position alone. It includes the live clock it needs, so it also works
when Stream time is off.

## Project Layout

```text
.
├── src/
│   ├── streamTime/       # Stream timestamp capture and display
│   ├── featureRuntime.ts # Content feature lifecycle
│   └── features.ts       # Shared feature metadata and settings
├── entrypoints/
│   ├── background/     # HLS timestamp capture
│   ├── content/        # Twitch content script
│   └── popup/          # Extension popup
├── wxt.config.ts       # WXT and manifest configuration
├── package.json        # Project metadata and scripts
└── tsconfig.json       # WXT-generated TypeScript configuration bridge
```

WXT generates browser-specific manifests and bundles in `.output/`. Generated
TypeScript support files live in `.wxt/`; neither directory is committed.
