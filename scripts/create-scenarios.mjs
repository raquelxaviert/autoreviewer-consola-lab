#!/usr/bin/env node
// Creates the 15 experimental scenario branches, each one derived directly
// from the same base commit (default: experiment-base), and exports each
// scenario diff to experiments/scenarios/<id>.patch.
//
// Usage: node scripts/create-scenarios.mjs [--base <ref>] [--only pr01,pr02]
// Each edit must match exactly once in the base version, otherwise the script aborts.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const BASE = arg("--base", "experiment-base");
const ONLY = arg("--only", "")?.split(",").filter(Boolean);
const WORK = path.join(ROOT, "experiments/work/gen");
const CHECK = argv.includes("--check");

export const SCENARIOS = [
  {
    id: "pr01",
    branch: "scenario/pr01-type-error",
    message: "feat(fancy): show current time instead of log date",
    edits: [
      {
        file: "src/reporters/fancy.ts",
        find: "    const date = this.formatDate(logObj.date, opts);",
        replace: "    const date = this.formatDate(Date.now(), opts);",
      },
    ],
  },
  {
    id: "pr02",
    branch: "scenario/pr02-incompatible-return",
    message: "refactor(tree): avoid joining tree chunks twice",
    edits: [
      {
        file: "src/utils/tree.ts",
        find: `  const tree = _buildTree(items, options).join("");
  if (options && options.color) {
    return colorize(options.color, tree);
  }

  return tree;`,
        replace: `  const tree = _buildTree(items, options);
  if (options && options.color) {
    return colorize(options.color, tree.join(""));
  }

  return tree;`,
      },
    ],
  },
  {
    id: "pr03",
    branch: "scenario/pr03-lint-prefer-const",
    message: "refactor(format): name the compiled format before formatting",
    edits: [
      {
        file: "src/utils/format.ts",
        find: `export function formatString(format: string, argv: any) {
  return vsprintf(compileFormat(format), argv);
}`,
        replace: `export function formatString(format: string, argv: any) {
  let compiled = compileFormat(format);
  return vsprintf(compiled, argv);
}`,
      },
    ],
  },
  {
    id: "pr04",
    branch: "scenario/pr04-lint-array-foreach",
    message: "refactor(core): dispatch logs to reporters with forEach",
    edits: [
      {
        file: "src/consola.ts",
        find: `  _log(logObj: LogObject) {
    for (const reporter of this.options.reporters) {
      reporter.log(logObj, {
        options: this.options,
      });
    }
  }`,
        replace: `  _log(logObj: LogObject) {
    this.options.reporters.forEach((reporter) => {
      reporter.log(logObj, {
        options: this.options,
      });
    });
  }`,
      },
    ],
  },
  {
    id: "pr05",
    branch: "scenario/pr05-duplication",
    message: "feat(fancy): format box titles with their own helper",
    edits: [
      {
        file: "src/reporters/fancy.ts",
        find: `          title: logObj.title
            ? characterFormat(logObj.title as string)
            : undefined,`,
        replace: `          title: logObj.title
            ? formatBoxTitle(logObj.title as string)
            : undefined,`,
      },
      {
        file: "src/reporters/fancy.ts",
        find: `function getColor(color = "white") {`,
        replace: `function formatBoxTitle(title: string) {
  return (
    title
      // highlight backticks
      .replace(/\`([^\`]+)\`/gm, (_, m) => colors.cyan(m))
      // underline underscores
      .replace(/\\s+_([^_]+)_\\s+/gm, (_, m) => \` \${colors.underline(m)} \`)
  );
}

function getColor(color = "white") {`,
      },
    ],
  },
  {
    id: "pr06",
    branch: "scenario/pr06-complexity",
    message: "feat(fancy): explicit badge decision for log objects",
    edits: [
      {
        file: "src/reporters/fancy.ts",
        find: "    const isBadge = (logObj.badge as boolean) ?? logObj.level < 2;",
        replace: "    const isBadge = this.shouldUseBadge(logObj, opts);",
      },
      {
        file: "src/reporters/fancy.ts",
        find: `  formatLogObj(logObj: LogObject, opts: FormatOptions) {
    const [message, ...additional]`,
        replace: `  shouldUseBadge(logObj: LogObject, opts: FormatOptions): boolean {
    if (logObj.badge !== undefined && logObj.badge !== null) {
      if (logObj.badge === true) {
        return true;
      } else {
        if (logObj.badge === false) {
          return false;
        } else {
          if (logObj.level < 2) {
            return true;
          }
        }
      }
    } else {
      if (logObj.level !== undefined) {
        if (logObj.level < 2) {
          if (logObj.level === 0 || logObj.level === 1 || logObj.level < 0) {
            return true;
          }
        } else {
          if (opts.columns !== undefined && opts.columns >= 0) {
            return false;
          }
        }
      }
    }
    return false;
  }

  formatLogObj(logObj: LogObject, opts: FormatOptions) {
    const [message, ...additional]`,
      },
    ],
  },
  {
    id: "pr07",
    branch: "scenario/pr07-naming",
    message: "refactor(core): shorten throttle variable names",
    edits: [
      {
        file: "src/consola.ts",
        find: `    const resolveLog = (newLog = false) => {
      const repeated = (this._lastLog.count || 0) - this.options.throttleMin;
      if (this._lastLog.object && repeated > 0) {
        const args = [...this._lastLog.object.args];
        if (repeated > 1) {
          args.push(\`(repeated \${repeated} times)\`);
        }`,
        replace: `    const fn = (flag = false) => {
      const n = (this._lastLog.count || 0) - this.options.throttleMin;
      if (this._lastLog.object && n > 0) {
        const tmp = [...this._lastLog.object.args];
        if (n > 1) {
          tmp.push(\`(repeated \${n} times)\`);
        }`,
      },
      {
        file: "src/consola.ts",
        find: `        this._log({ ...this._lastLog.object, args });
        this._lastLog.count = 1;
      }

      // Log
      if (newLog) {`,
        replace: `        this._log({ ...this._lastLog.object, args: tmp });
        this._lastLog.count = 1;
      }

      // Log
      if (flag) {`,
      },
      {
        file: "src/consola.ts",
        find: `    const diffTime =
      this._lastLog.time && logObj.date
        ? logObj.date.getTime() - this._lastLog.time.getTime()
        : 0;
    this._lastLog.time = logObj.date;
    if (diffTime < this.options.throttle) {
      try {
        const serializedLog = JSON.stringify([
          logObj.type,
          logObj.tag,
          logObj.args,
        ]);
        const isSameLog = this._lastLog.serialized === serializedLog;
        this._lastLog.serialized = serializedLog;
        if (isSameLog) {`,
        replace: `    const d =
      this._lastLog.time && logObj.date
        ? logObj.date.getTime() - this._lastLog.time.getTime()
        : 0;
    this._lastLog.time = logObj.date;
    if (d < this.options.throttle) {
      try {
        const s = JSON.stringify([logObj.type, logObj.tag, logObj.args]);
        const x = this._lastLog.serialized === s;
        this._lastLog.serialized = s;
        if (x) {`,
      },
      {
        file: "src/consola.ts",
        find: `            this._lastLog.timeout = setTimeout(
              resolveLog,
              this.options.throttle,
            );`,
        replace: `            this._lastLog.timeout = setTimeout(fn, this.options.throttle);`,
      },
      {
        file: "src/consola.ts",
        find: `    resolveLog(true);
  }`,
        replace: `    fn(true);
  }`,
      },
    ],
  },
  {
    id: "pr08",
    branch: "scenario/pr08-low-cohesion",
    message: "feat(core): print logs directly when no reporter is registered",
    edits: [
      {
        file: "src/consola.ts",
        find: `    // Throttle
    clearTimeout(this._lastLog.timeout);`,
        replace: `    // Fallback output when no reporter is registered
    if (this.options.reporters.length === 0) {
      const time = (logObj.date || new Date()).toLocaleTimeString();
      const prefix = logObj.tag ? \`[\${logObj.tag}] \` : "";
      const text = (logObj.args || [])
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      const stream =
        (logObj.level || 0) < 2 ? process.stderr : process.stdout;
      stream.write(\`\${time} \${prefix}\${logObj.type.toUpperCase()} \${text}\\n\`);
      return;
    }

    // Throttle
    clearTimeout(this._lastLog.timeout);`,
      },
    ],
  },
  {
    id: "pr09",
    branch: "scenario/pr09-high-coupling",
    message: "fix(core): normalize box titles for the fancy reporter",
    edits: [
      {
        file: "src/consola.ts",
        find: `import type { PromptOptions } from "./prompt";`,
        replace: `import type { PromptOptions } from "./prompt";
import { FancyReporter } from "./reporters/fancy";`,
      },
      {
        file: "src/consola.ts",
        find: `    for (const reporter of this.options.reporters) {
      reporter.log(logObj, {`,
        replace: `    for (const reporter of this.options.reporters) {
      if (reporter instanceof FancyReporter && logObj.type === "box") {
        // FancyReporter expects box titles to be strings
        logObj.title = String(logObj.title ?? "");
      }
      reporter.log(logObj, {`,
      },
    ],
  },
  {
    id: "pr10",
    branch: "scenario/pr10-redundant-logic",
    message: "fix(utils): harden log object detection",
    edits: [
      {
        file: "src/utils/log.ts",
        find: `  // Should be plain object
  if (!isPlainObject(arg)) {
    return false;
  }

  // Should contains either 'message' or 'args' field
  if (!arg.message && !arg.args) {
    return false;
  }

  // Handle non-standard error objects
  if (arg.stack) {
    return false;
  }`,
        replace: `  // Should be plain object
  if (!isPlainObject(arg)) {
    return false;
  }
  if (arg === null || arg === undefined || typeof arg !== "object") {
    return false;
  }

  // Should contains either 'message' or 'args' field
  if (!arg.message && !arg.args) {
    return false;
  }
  if (arg.message === undefined && arg.args === undefined) {
    return false;
  }

  // Handle non-standard error objects
  if (arg.stack) {
    return false;
  }
  if ("stack" in arg && arg.stack) {
    return false;
  }`,
      },
    ],
  },
  {
    id: "pr11",
    branch: "scenario/pr11-repeated-processing",
    message: "refactor(core): inline throttle serialization",
    edits: [
      {
        file: "src/consola.ts",
        find: `        const serializedLog = JSON.stringify([
          logObj.type,
          logObj.tag,
          logObj.args,
        ]);
        const isSameLog = this._lastLog.serialized === serializedLog;
        this._lastLog.serialized = serializedLog;`,
        replace: `        const isSameLog =
          this._lastLog.serialized ===
          JSON.stringify([logObj.type, logObj.tag, logObj.args]);
        this._lastLog.serialized = JSON.stringify([
          logObj.type,
          logObj.tag,
          logObj.args,
        ]);`,
      },
    ],
  },
  {
    id: "pr12",
    branch: "scenario/pr12-silent-catch",
    message: "fix(core): keep logging when a reporter throws",
    edits: [
      {
        file: "src/consola.ts",
        find: `    for (const reporter of this.options.reporters) {
      reporter.log(logObj, {
        options: this.options,
      });
    }`,
        replace: `    for (const reporter of this.options.reporters) {
      try {
        reporter.log(logObj, {
          options: this.options,
        });
      } catch {
        // ignore reporter failures
      }
    }`,
      },
    ],
  },
  {
    id: "pr13",
    branch: "scenario/pr13-correct-refactor",
    message: "refactor(fancy): extract type color resolution into a helper",
    edits: [
      {
        file: "src/reporters/fancy.ts",
        find: `    const typeColor =
      (TYPE_COLOR_MAP as any)[logObj.type] ||
      (LEVEL_COLOR_MAP as any)[logObj.level] ||
      "gray";
`,
        replace: `    const typeColor = getTypeColor(logObj);
`,
      },
      {
        file: "src/reporters/fancy.ts",
        find: `function characterFormat(str: string) {`,
        replace: `function getTypeColor(logObj: LogObject): string {
  return (
    (TYPE_COLOR_MAP as any)[logObj.type] ||
    (LEVEL_COLOR_MAP as any)[logObj.level] ||
    "gray"
  );
}

function characterFormat(str: string) {`,
      },
    ],
  },
  {
    id: "pr14",
    branch: "scenario/pr14-typing-improvement",
    message: "types(fancy): drop unnecessary any casts on typed maps",
    edits: [
      {
        file: "src/reporters/fancy.ts",
        find: `    const typeColor =
      (TYPE_COLOR_MAP as any)[logObj.type] ||
      (LEVEL_COLOR_MAP as any)[logObj.level] ||
      "gray";`,
        replace: `    const typeColor =
      TYPE_COLOR_MAP[logObj.type] || LEVEL_COLOR_MAP[logObj.level] || "gray";`,
      },
      {
        file: "src/reporters/fancy.ts",
        find: `    const _type =
      typeof (TYPE_ICONS as any)[logObj.type] === "string"
        ? (TYPE_ICONS as any)[logObj.type]
        : (logObj as any).icon || logObj.type;`,
        replace: `    const icon = TYPE_ICONS[logObj.type];
    const _type: string =
      typeof icon === "string" ? icon : (logObj.icon as string) || logObj.type;`,
      },
    ],
  },
  {
    id: "pr15",
    branch: "scenario/pr15-simple-fix",
    message: "fix(utils): leftAlign returns long strings unchanged, as documented",
    edits: [
      {
        file: "src/utils/string.ts",
        find: `export function leftAlign(str: string, len: number, space = " ") {
  let _str = "";`,
        replace: `export function leftAlign(str: string, len: number, space = " ") {
  if (str.length >= len) {
    return str;
  }
  let _str = "";`,
      },
    ],
  },
];

function git(args, cwd = WORK) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function check(baseSha) {
  let ok = true;
  for (const s of SCENARIOS) {
    const files = {};
    for (const e of s.edits) {
      files[e.file] ??= git(["show", `${baseSha}:${e.file}`], ROOT);
      const count = files[e.file].split(e.find).length - 1;
      if (count !== 1) {
        ok = false;
        console.log(`${s.id}: edit target found ${count} times in ${e.file}: ${JSON.stringify(e.find.slice(0, 80))}`);
      }
      files[e.file] = files[e.file].replace(e.find, () => e.replace);
    }
  }
  console.log(ok ? "all edits apply cleanly" : "some edits do not apply");
  process.exitCode = ok ? 0 : 1;
}

function main() {
  const baseSha = git(["rev-parse", BASE], ROOT);
  if (CHECK) return check(baseSha);
  if (fs.existsSync(WORK)) git(["worktree", "remove", "--force", WORK], ROOT);
  git(["worktree", "add", "--detach", WORK, baseSha], ROOT);
  const outDir = path.join(ROOT, "experiments/scenarios");
  fs.mkdirSync(outDir, { recursive: true });
  try {
    for (const s of SCENARIOS) {
      if (ONLY?.length && !ONLY.includes(s.id)) continue;
      git(["checkout", "--quiet", "-B", s.branch, baseSha]);
      for (const e of s.edits) {
        const file = path.join(WORK, e.file);
        const src = fs.readFileSync(file, "utf8");
        const count = src.split(e.find).length - 1;
        if (count !== 1) throw new Error(`${s.id}: edit target found ${count} times in ${e.file}`);
        fs.writeFileSync(file, src.replace(e.find, () => e.replace));
      }
      git(["add", "-A", "src"]);
      git(["commit", "--quiet", "-m", `${s.message}\n\nAutoReviewer experimental scenario ${s.id}.`]);
      const patch = git(["format-patch", "--stdout", "--no-signature", `${baseSha}..HEAD`]);
      fs.writeFileSync(path.join(outDir, `${s.id}.patch`), patch + "\n");
      console.log(`${s.id}: ${s.branch} -> ${git(["rev-parse", "--short", "HEAD"])}`);
    }
  } finally {
    git(["worktree", "remove", "--force", WORK], ROOT);
  }
  console.log(`base: ${BASE} = ${baseSha}`);
}

main();
