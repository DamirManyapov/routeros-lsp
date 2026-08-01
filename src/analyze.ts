/**
 * Checks that need no schema — they follow from the text alone.
 *
 * Both work off the same line scan the rest of the server uses. A full
 * tree-sitter parse would be more principled, but it would mean shipping a
 * parser binary or wasm blob with the server, and neither check needs the
 * extra structure: duplicates are siblings within one command, and RouterOS
 * scoping is coarse enough to track with a stack of declaration sets.
 */

import { COMMAND_VERBS, joinContinuations, tokenize } from "./parse.js";

export interface Finding {
  line: number;
  column: number;
  length: number;
  message: string;
  /** Distinguishes a certain error from a mere suspicion. */
  severity: "error" | "warning";
  code: string;
}

/** Properties RouterOS genuinely accepts more than once on one command. */
const REPEATABLE = new Set(["address-list", "comment"]);

/**
 * Reports a property given twice in the same command: "distance=1 distance=2".
 * RouterOS silently keeps the last one, which is exactly the sort of thing a
 * reader misses.
 */
export function findDuplicateProperties(lines: string[]): Finding[] {
  const out: Finding[] = [];

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    // A continued command belongs to the line that starts it.
    if (/\\\s*$/.test(lines[index - 1] ?? "")) continue;

    const text = joinContinuations(lines, lastContinuedLine(lines, index));
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const tokens = tokenize(trimmed);
    if (!tokens.some((t) => COMMAND_VERBS.has(t) || t.includes("="))) continue;

    const seen = new Map<string, number>();
    let depth = 0;

    for (const token of tokens) {
      // Only the command's own properties count. A "do={ ... }" body holds a
      // separate command, whose properties are unrelated to this one.
      const before = depth;
      depth += countBraces(token, "{") - countBraces(token, "}");
      if (before > 0 || depth > 0) continue;

      const eq = token.indexOf("=");
      if (eq <= 0) continue;

      const key = token.slice(0, eq);
      // Nested groups address different sub-objects; a bare leading dot
      // continues the previous group and is likewise not a repeat.
      if (key.startsWith(".") || key.includes(".")) continue;
      if (REPEATABLE.has(key)) continue;

      const previous = seen.get(key);
      if (previous === undefined) {
        seen.set(key, 1);
        continue;
      }
      seen.set(key, previous + 1);

      const column = columnOf(raw, key, previous);
      if (column < 0) continue;

      out.push({
        line: index,
        column,
        length: key.length,
        message: `'${key}' is set more than once — RouterOS keeps the last value`,
        severity: "warning",
        code: "duplicate-property",
      });
    }
  }

  return out;
}

/**
 * Reports `$name` where nothing declared `name`.
 *
 * RouterOS scoping, as it matters here:
 *  - `:local` declares inside the current block, `:global` everywhere
 *  - `do={ ... }` opens a block; locals declared inside do not escape it
 *  - a function body never sees the caller's locals, so `do={ }` bound to a
 *    variable is treated as a boundary rather than a nested scope
 *  - `:for i from=..` and `:foreach i in=..` bind their loop variable
 */
export function findUndeclaredVariables(lines: string[]): Finding[] {
  const out: Finding[] = [];
  const globals = new Set<string>();
  // A stack of scopes; index 0 holds file-level locals.
  const scopes: Set<string>[] = [new Set()];
  // Depth at which the current function body began, if any.
  const functionDepth: number[] = [];
  // Function names declared on a line that also opens their body; they must
  // survive the closing brace, since the name belongs to the outer scope.
  const pendingDeclarations: string[] = [];

  const declared = (name: string) =>
    globals.has(name) ||
    scopes.some((scope, depth) => {
      const boundary = functionDepth[functionDepth.length - 1];
      // Inside a function body, only its own scopes and globals are visible.
      if (boundary !== undefined && depth < boundary) return false;
      return scope.has(name);
    });

  // True while inside a quoted value that spans several lines — RouterOS
  // stores whole scripts that way, and their variables live in another scope.
  let insideString = false;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    const wasInsideString = insideString;
    insideString = insideString !== hasOddQuotes(raw);

    if (wasInsideString) continue;
    if (!trimmed || trimmed.startsWith("#")) continue;

    const tokens = tokenize(trimmed);

    for (let position = 0; position < tokens.length; position++) {
      const token = tokens[position] ?? "";

      if (token === ":local" || token === ":global") {
        const name = stripName(tokens[position + 1] ?? "");
        if (name) {
          if (token === ":global") globals.add(name);
          // A function is declared in the scope that encloses its body, so it
          // stays visible after the body's braces close.
          else if (tokens.some((t) => t.startsWith("do={"))) {
            scopes[Math.max(0, scopes.length - 1)]?.add(name);
            pendingDeclarations.push(name);
          } else scopes[scopes.length - 1]?.add(name);
        }
        continue;
      }

      // :for i from=1 to=3   /   :foreach k,v in=$array
      if (token === ":for" || token === ":foreach") {
        for (const name of (tokens[position + 1] ?? "").split(",")) {
          const clean = stripName(name);
          if (clean) scopes[scopes.length - 1]?.add(clean);
        }
        continue;
      }

      // "do={" bound to a variable starts a function body: ":local f do={ }".
      // Braces are counted at end of line, so the body's scope will sit one
      // level deeper than the current one.
      if (token.startsWith("do={")) {
        const isFunction = tokens[0] === ":local" || tokens[0] === ":global";
        if (isFunction) functionDepth.push(scopes.length + 1);
      }

      // Scripts stored as string values — "on-event=\"...\"", /system/script
      // source — reference variables declared elsewhere, often in another
      // script entirely. Their scope is not knowable from this file.
      if (token.includes('"') || token.includes("\\$")) continue;

      for (const name of referencedNames(token)) {
        // $1, $2 … are positional arguments inside a function body.
        if (/^\d+$/.test(name)) continue;
        if (declared(name)) continue;

        const column = raw.indexOf(`$${name}`);
        if (column < 0) continue;

        out.push({
          line: index,
          column,
          length: name.length + 1,
          message: `undeclared variable '$${name}' — declare ':local ${name}' or import ':global ${name}'`,
          severity: "warning",
          code: "undeclared-variable",
        });
      }
    }

    // Brace depth drives scope push/pop. Braces inside strings do not count.
    const opens = countBraces(trimmed, "{");
    const closes = countBraces(trimmed, "}");
    for (let i = 0; i < opens; i++) scopes.push(new Set());
    for (let i = 0; i < closes; i++) {
      if (scopes.length > 1) scopes.pop();
      const boundary = functionDepth[functionDepth.length - 1];
      if (boundary !== undefined && scopes.length < boundary) functionDepth.pop();
    }

    // A function's name belongs to the scope that survives its body, which may
    // have opened and closed on this very line.
    for (const name of pendingDeclarations) {
      scopes[scopes.length - 1]?.add(name);
    }
    pendingDeclarations.length = 0;
  }

  return out;
}

/**
 * Reports paths that cannot parse at all.
 *
 * Only shapes with no legitimate reading are reported — an empty segment or a
 * doubled separator. Anything merely unusual is left to the schema check,
 * which knows what actually exists.
 */
export function findMalformedPaths(lines: string[]): Finding[] {
  const out: Finding[] = [];
  let insideString = false;

  lines.forEach((raw, index) => {
    const wasInside = insideString;
    insideString = insideString !== hasOddQuotes(raw);
    if (wasInside) return;

    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    for (const token of tokenize(trimmed)) {
      if (!token.startsWith("/")) continue;
      // Values legitimately contain slashes: address=0.0.0.0/8
      if (token.includes("=")) continue;

      const doubled = token.indexOf("//");
      if (doubled >= 0) {
        const column = raw.indexOf(token) + doubled;
        out.push({
          line: index,
          column,
          length: 2,
          message: "empty path segment — '//' has nothing between the separators",
          severity: "error",
          code: "malformed-path",
        });
        continue;
      }

      // A path made only of separators, or one starting with a non-name.
      if (/^\/+$/.test(token) || /^\/[^A-Za-z]/.test(token)) {
        const column = raw.indexOf(token);
        out.push({
          line: index,
          column,
          length: token.length,
          message: `'${token}' is not a valid path`,
          severity: "error",
          code: "malformed-path",
        });
      }
    }

    // "chain=" with nothing after it, and "key==value".
    for (const token of tokenize(trimmed)) {
      if (token.startsWith("=")) {
        const column = raw.indexOf(token);
        out.push({
          line: index,
          column,
          length: token.length,
          message: "missing property name before '='",
          severity: "error",
          code: "malformed-property",
        });
        continue;
      }
      const doubleEquals = token.indexOf("==");
      if (doubleEquals > 0) {
        const column = raw.indexOf(token) + doubleEquals;
        out.push({
          line: index,
          column,
          length: 2,
          message: "'==' is not an assignment — RouterOS uses a single '='",
          severity: "error",
          code: "malformed-property",
        });
      }
    }
  });

  return out;
}

/** Names referenced as $name or $"name" within a token. */
function referencedNames(token: string): string[] {
  const names: string[] = [];
  const pattern = /\$\{?"?([A-Za-z_][A-Za-z0-9_-]*|\d+)"?\}?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(token)) !== null) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

function stripName(token: string): string {
  const clean = token.replace(/^\$/, "").replace(/[;=].*$/, "").trim();
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(clean) ? clean : "";
}

/** Whether a line leaves a quoted value open, ignoring escaped quotes. */
export function hasOddQuotes(text: string): boolean {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === '"') count++;
  }
  return count % 2 === 1;
}

function countBraces(text: string, brace: "{" | "}"): number {
  let count = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && ch === brace) count++;
  }
  return count;
}

/** Walks back to the line that started a continued command. */
function lastContinuedLine(lines: string[], index: number): number {
  let end = index;
  while (/\\\s*$/.test(lines[end] ?? "")) end++;
  return end;
}

/** Column of the nth occurrence of `key=` in a line. */
function columnOf(line: string, key: string, skip: number): number {
  const pattern = new RegExp(`(?:^|[\\s\\[])(${escapeRegExp(key)})=`, "g");
  let match: RegExpExecArray | null;
  let seen = 0;
  while ((match = pattern.exec(line)) !== null) {
    if (seen === skip) return match.index + match[0].indexOf(key);
    seen++;
  }
  return -1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
