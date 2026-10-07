import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".cache/**",
      "**/.expo/**",
      "apps/mobile/android/**",
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
      "apps/web/public/vendor/**",
      "packages/storage/vendor/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "packages/**/scripts/**/*.mjs",
      "tests/integration/fixtures/**/*.mjs",
      "tests/e2e-web/**/*.mjs",
      "apps/web/scripts/**/*.mjs",
      "apps/mobile/plugins/**/*.cjs",
      "apps/mobile/*.cjs",
    ],
    languageOptions: {
      globals: {
        __dirname: "readonly",
        require: "readonly",
        module: "readonly",
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
    files: ["apps/mobile/plugins/**/*.cjs", "apps/mobile/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
