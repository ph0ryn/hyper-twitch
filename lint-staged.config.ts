export default {
  "**/!(package).json": "pnpm oxfmt",
  "*.{js,mjs}": () => "pnpm run format",
  "entrypoints/**/*.ts": () => "pnpm run precommit",
  "package.json": () => "sort-package-json",
};
