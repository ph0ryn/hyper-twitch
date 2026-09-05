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

| Command           | Description                                  |
| ----------------- | -------------------------------------------- |
| `pnpm run dev`    | Start WXT in development mode.               |
| `pnpm run build`  | Build the extension into `.output/`.         |
| `pnpm run zip`    | Create a distributable extension archive.    |
| `pnpm run lint`   | Run ESLint and Oxlint with type checking.    |
| `pnpm run test`   | Run unit tests with Vitest.                  |
| `pnpm run format` | Format the repository with oxfmt.            |
| `pnpm run fix`    | Apply Oxlint fixes, then format the project. |

## Feature toggles

The registry in `src/utils/features.ts` is the source of truth for feature metadata,
popup controls, and stored settings. Keep feature IDs stable and camelCase.

Each feature setting uses `local:features.<featureId>.enabled`. The metadata
`defaultEnabled` value is only the fallback for a missing key; a stored value,
including an explicit `false`, always wins. To add a feature, register its
metadata and matching content runtime in `src/utils/features.ts` and
`src/entrypoints/content/featureRuntime.ts`. A runtime must implement `mount(ctx, signal)` and
return a cleanup function. The shared runner applies the initial state, watches
changes, and cleans up on disable, Twitch SPA navigation, or extension
invalidation.

The popup renders registered metadata automatically. Keep Twitch-side feature
code out of the popup bundle; feature toggles use local storage directly rather
than a general background message bus.

## Playback shortcuts and feedback

Both features are enabled by default and have separate popup switches.
On Twitch videos, Left/Right skip by 10 seconds, J/L by 30 seconds, and K
immediately toggles playback. Typing, modified shortcuts, and controls such as
menus and sliders keep their normal keyboard behavior. Live streams and clips
are not included.

Repeated skip presses add up, including presses in the opposite direction.
The player seeks once, 300 ms after all skip keys are released. Holding a key
keeps the batch open. Playback continues while the batch is pending; the final
offset is applied to the current playback position and clamped to the video's
start and end. Losing window focus, navigating away, or seeking elsewhere
cancels the pending skip.

Playback feedback shows the combined offset immediately over the player and
keeps the final amount visible briefly after seeking. It also shows play/pause
feedback for K. Disabling feedback hides these overlays without changing the
shortcuts. Disabling shortcuts restores Twitch's native keys; feedback does not
replace native controls or observe native shortcuts.

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
on two or more live streams to keep them at the same moment. When the target is
still buffered, a stream more than 2 seconds ahead seeks backward once for the
current shared timeline. Smaller differences and any remaining drift are
corrected with playback speed between 0.5× and 1.5× toward zero drift. The UI
reports synced once the estimated wall-clock times are within 100 ms, while
correction continues toward zero. A single participating stream waits for
another one.
The wall-clock mapping remains approximate because Twitch does not expose an
exact public live-player timeline.

The popup setting is on by default, but each stream starts outside sync mode
until its button is selected. Sync mode does not apply to archives. Turning the
popup setting off or closing a participating stream leaves the remaining
playback position alone. It includes the live clock it needs, so it also works
when Stream time is off.

## Watch history

Watch history records the parts that actually play in live streams and past
broadcasts. It is enabled by default. Seeking over a section does not mark it as
watched, and turning the feature off stops recording without deleting existing
history.

On a past broadcast, watched sections replace those portions of Twitch's seek
bar with bright cyan. Direct archive history is combined with matching live
history when Twitch's internal metadata identifies the same broadcaster and
broadcast time. Hover previews use the same cyan outline when the selected
moment has been watched. Highlights, uploads, and clips are excluded.

History stays in this browser's local extension storage and is not synced or
expired automatically. Live-to-archive matching uses Twitch's private GraphQL
API and safely falls back to direct archive history if that API changes or is
unavailable.

## Project Layout

```text
.
├── src/
│   ├── entrypoints/
│   │   ├── background/ # HLS capture and watch-history metadata
│   │   ├── content/    # Twitch content script and feature runtimes
│   │   └── popup/      # Extension popup
│   └── utils/          # Shared feature definitions, protocols, and models
├── vitest.config.ts    # Vitest and WXT test configuration
├── wxt.config.ts       # WXT and manifest configuration
├── package.json        # Project metadata and scripts
└── tsconfig.json       # WXT-generated TypeScript configuration bridge
```

WXT generates browser-specific manifests and bundles in `.output/`. Generated
TypeScript support files live in `.wxt/`; neither directory is committed.
