module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: "./tsconfig.json",
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  rules: {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/strict-boolean-expressions": "off",
    "@typescript-eslint/no-non-null-assertion": "warn",
    "no-console": "warn",
    "no-var": "error",
    "prefer-const": "error",
  },
  ignorePatterns: ["dist/", "node_modules/", "*.test.ts"],
};
