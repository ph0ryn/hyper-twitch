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
| `pnpm run format` | Format the repository with oxfmt.            |
| `pnpm run fix`    | Apply Oxlint fixes, then format the project. |

## Feature toggles

The registry in `src/features.ts` is the source of truth for feature metadata,
popup controls, and stored settings. Keep feature IDs stable and camelCase.

Each feature setting uses `local:features.<featureId>.enabled` and defaults to
`false`. To add a feature, register its metadata and matching content runtime
in `src/features.ts` and `src/featureRuntime.ts`. A runtime must implement
`mount(ctx, signal)` and return a cleanup function. The shared runner applies
the initial state, watches changes, and cleans up on disable, Twitch SPA
navigation, or extension invalidation.

The popup renders registered metadata automatically. Keep Twitch-side feature
code out of the popup bundle; feature toggles use local storage directly, with
no background service worker or message bus.

## Project Layout

```text
.
├── src/
│   ├── featureRuntime.ts # Content feature lifecycle
│   └── features.ts       # Shared feature metadata and settings
├── entrypoints/
│   ├── content/        # Twitch content script
│   └── popup/          # Extension popup
├── wxt.config.ts       # WXT and manifest configuration
├── package.json        # Project metadata and scripts
└── tsconfig.json       # WXT-generated TypeScript configuration bridge
```

WXT generates browser-specific manifests and bundles in `.output/`. Generated
TypeScript support files live in `.wxt/`; neither directory is committed.
