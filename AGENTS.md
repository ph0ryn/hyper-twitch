# ts-base Agent Guide

## Repository Purpose

This repository is a reusable TypeScript template. Treat changes as template
maintenance unless the user explicitly asks to turn it into a concrete project.

Keep the template small, generic, and easy to fork. Do not add app-specific
frameworks, runtime assumptions, build pipelines, or documentation unless the
request specifically needs them.

## Tooling

- Package manager: pnpm only. Do not use npm or yarn.
- Runtime target: Bun-compatible ESM.
- Module system: ESM with `"type": "module"`.
- TypeScript is configured as strict and `noEmit`.
- Linting and type checking are primarily handled by Oxlint, with ESLint used
  for TypeScript naming rules and autofix support.
- Formatting is handled by oxfmt.
- Git hooks are configured automatically during `postinstall`.

## Common Commands

Run all commands from the repository root.

| Task                 | Command           |
| -------------------- | ----------------- |
| Install dependencies | `pnpm install`    |
| Lint                 | `pnpm run lint`   |
| Format               | `pnpm run format` |
| Autofix              | `pnpm run fix`    |

There is currently no `test`, `build`, or separate `typecheck` script.
`pnpm run lint` already runs Oxlint with `--type-aware --type-check`. Check
`package.json` before adding or running new lifecycle commands.

## Editing Rules

- Keep external code, comments, commit messages, and repository documentation in
  English.
- Preserve pnpm workspace catalog usage in `pnpm-workspace.yaml` when updating
  dependencies.
- Prefer small, direct changes over new abstractions.
- Do not add dependencies for documentation-only or housekeeping changes.
- Do not widen the template into a framework starter unless explicitly asked.
- Keep generated-project instructions in `README.md`; keep agent workflow notes
  in this file.

## Validation

For repository changes, run the narrowest relevant checks first. For normal
template maintenance, use:

```sh
pnpm run format
pnpm run lint
```

If a requested change adds a new script, runtime path, test framework, or build
step, update both `README.md` and this guide so future agents do not rely on
stale commands.
