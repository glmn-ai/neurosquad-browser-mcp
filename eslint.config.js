// ESLint flat config: catches real bugs (undefined names, unused code, unreachable code).
// Formatting is not enforced here.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["**/node_modules/**", "dist/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "off" } },
  js.configs.recommended,
  {
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // The MV3 extension: service worker, content scripts and popup run in the browser.
    files: ["extension/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser, ...globals.serviceworker, ...globals.webextensions },
    },
  },
  {
    // The MCP server, its tests and repository scripts run on Node.js (ES modules).
    files: ["server/**/*.js", "scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
];
