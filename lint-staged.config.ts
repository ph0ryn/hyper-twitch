export default {
  "**/!(package).json": "pnpm oxfmt",
  "**/*.ts": () => "pnpm run precommit",
  "*.{js,mjs}": () => "pnpm run format",
  "package.json": () => "sort-package-json",
};
