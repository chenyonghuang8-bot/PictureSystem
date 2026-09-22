import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.expo/**",
      "**/.next/**",
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "scripts/**",
      "skills/**",
      "project-spec/**",
      "vendor/**",
      "packages/storage/vendor/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "packages/**/scripts/**/*.mjs",
      "tests/integration/fixtures/**/*.mjs",
    ],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        queueMicrotask: "readonly",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
