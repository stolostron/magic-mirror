import google from "eslint-config-google";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

/** Rules removed from ESLint core; eslint-config-google still references them. */
const OMIT_GOOGLE_RULES = new Set(["valid-jsdoc", "require-jsdoc"]);

const googleRules = Object.fromEntries(
  Object.entries(google.rules).filter(([name]) => !OMIT_GOOGLE_RULES.has(name)),
);

export default [
  {
    ignores: ["**/node_modules/**", "**/build/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
      parser: tsParser,
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...googleRules,
      "guard-for-in": "off",
      indent: ["error", 2, { MemberExpression: 1 }],
      "max-len": [
        "error",
        120,
        2,
        {
          ignoreUrls: true,
          ignoreComments: false,
          ignoreRegExpLiterals: true,
          ignoreStrings: false,
          ignoreTemplateLiterals: false,
        },
      ],
      "no-invalid-this": "off",
      "no-unused-vars": "off",
      "object-curly-spacing": "off",
      quotes: ["error", "double", { avoidEscape: true }],
      "quote-props": "off",
      "space-before-function-paren": "off",
    },
  },
];
