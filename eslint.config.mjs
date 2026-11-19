import unjs from "eslint-config-unjs";

// https://github.com/unjs/eslint-config
export default unjs({
  // AutoReviewer lab: tooling/experiment files are not part of the Consola code under study.
  ignores: ["tools/**", "scripts/**", "experiments/**"],
  rules: {
    "no-undef": 0,
    "unicorn/prefer-module": 0,
    "unicorn/prefer-top-level-await": 0,
    "unicorn/no-null": 0,
    "@typescript-eslint/no-unused-vars": 0,
    "unicorn/expiring-todo-comments": 0,
  },
  markdown: {
    rules: {
      'unicorn/no-process-exit': 0,
    }
  }
});
