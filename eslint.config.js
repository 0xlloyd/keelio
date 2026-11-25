import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules", "factory", ".cache", "dist", "**/dist", "videos"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Type-aware rules for the async code: a promise nobody awaits loses its
    // error, and the monitor, the dashboard and the MCP server are all async.
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",
    },
  },
);
