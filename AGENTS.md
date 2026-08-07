# Hyper Twitch Agent Guide

## Repository Purpose

This repository contains Hyper Twitch, a browser extension built with WXT.
Keep the extension focused on improving the Twitch viewing experience.

## Tooling

- Package manager: pnpm only. Do not use npm or yarn.
- Browser-extension framework: WXT.
- Module system: ESM with `"type": "module"`.
- TypeScript extends WXT's generated strict configuration.
- Linting and type checking are primarily handled by Oxlint, with ESLint used
  for TypeScript naming rules and autofix support.
- Formatting is handled by oxfmt.
- Git hooks are configured automatically during `postinstall`.

## Common Commands

Run all commands from the repository root.

| Task                 | Command           |
| -------------------- | ----------------- |
| Install dependencies | `pnpm install`    |
| Develop              | `pnpm run dev`    |
| Build                | `pnpm run build`  |
| Package              | `pnpm run zip`    |
| Lint                 | `pnpm run lint`   |
| Format               | `pnpm run format` |
| Autofix              | `pnpm run fix`    |

There is currently no `test` or separate `typecheck` script. `pnpm run lint`
already runs Oxlint with type-aware type checking. Check `package.json` before
adding or running new lifecycle commands.

## Editing Rules

- Keep external code, comments, commit messages, and repository documentation in
  English.
- Preserve pnpm workspace catalog usage in `pnpm-workspace.yaml` when updating
  dependencies. Keep WXT in `devDependencies`.
- Prefer small, direct changes over new abstractions.
- Put extension entrypoints under `entrypoints/` using WXT's naming rules.
- Do not edit generated files under `.wxt/` or `.output/`.
- Keep user-facing project instructions in `README.md`; keep agent workflow notes
  in this file.

## Validation

For repository changes, run the narrowest relevant checks first. For normal
extension work, use:

```sh
pnpm run format
pnpm run lint
pnpm run build
```
