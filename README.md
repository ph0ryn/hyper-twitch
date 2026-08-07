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

## Project Layout

```text
.
├── entrypoints/
│   ├── background/     # Extension background service worker
│   ├── content/        # Twitch content script
│   └── popup/          # Extension popup
├── wxt.config.ts       # WXT and manifest configuration
├── package.json        # Project metadata and scripts
└── tsconfig.json       # WXT-generated TypeScript configuration bridge
```

WXT generates browser-specific manifests and bundles in `.output/`. Generated
TypeScript support files live in `.wxt/`; neither directory is committed.
