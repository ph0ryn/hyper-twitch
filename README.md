# ts-base

Reusable TypeScript base template for small ESM projects.

This repository is intentionally minimal. It provides strict TypeScript defaults,
pnpm-only dependency management, Oxlint, ESLint, oxfmt, and Git hook integration
without prescribing an application framework.

## What Is Included

- ESM package setup with `"type": "module"`.
- `src/index.ts` as the default source entry point.
- Strict `tsconfig.json` with `noEmit` enabled.
- Oxlint type-aware linting and type checking.
- ESLint rules for TypeScript naming conventions.
- oxfmt formatting configuration.
- Git hook integration through `lint-staged`.
- pnpm workspace catalog for tool versions.

## Requirements

- pnpm `11.1.1` or compatible.
- Node.js supported by the configured pnpm and lint tooling.
- Bun-compatible ESM runtime if you use the default `"module"` entry directly.

This template enforces pnpm during install. Do not use npm or yarn.

## Getting Started

Use this repository as a template, then adjust the package metadata and scripts
for the project you are creating.

```sh
pnpm install
```

After cloning or creating a new repository from this template:

1. Rename the package in `package.json`.
2. Decide whether the generated project should stay private.
3. Replace `src/index.ts` with the new project entry point.
4. Add project-specific `dev`, `build`, `test`, or release scripts as needed.

## Scripts

Run all commands from the repository root.

| Command           | Description                                       |
| ----------------- | ------------------------------------------------- |
| `pnpm install`    | Install dependencies and configure Git hooks.     |
| `pnpm run lint`   | Run ESLint, Oxlint, and Oxlint type checking.     |
| `pnpm run format` | Run oxfmt.                                        |
| `pnpm run fix`    | Run Oxlint type-aware fixes and oxfmt formatting. |

## Project Layout

```text
.
├── src/index.ts          # Default source entry
├── eslint.config.mjs     # ESLint configuration
├── oxlint.config.ts      # Oxlint configuration
├── oxfmt.config.ts       # oxfmt configuration
├── .githooks/            # Git hooks
├── package.json          # Scripts and package metadata
├── pnpm-workspace.yaml   # pnpm workspace and catalog settings
└── tsconfig.json         # TypeScript compiler options
```

## Template Notes

- Keep shared defaults generic. Project-specific behavior should be added after
  creating a repository from the template.
- Prefer adding scripts over changing the meaning of the existing ones.
- Keep tool versions in `pnpm-workspace.yaml` catalog entries unless a consuming
  project has a reason to manage versions differently.
- `package.json` is marked private by default so new repositories do not publish
  accidentally.

## License

You may use this repository as a template to create new projects.

Projects created from this template may choose their own license. They are not
required to use the MIT License or any other license solely because this
template was used.
