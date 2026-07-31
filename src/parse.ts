/**
 * Line-level parsing for completion and diagnostics.
 *
 * A full tree-sitter parse is overkill here: completion only needs to know
 * what the cursor sits on, and diagnostics only need the path and property
 * names per line. Both are decidable from the current line plus the section
 * header that precedes it.
 */

export type Context =
  | { kind: "path"; segments: string[]; prefix: string }
  | { kind: "command"; path: string[]; prefix: string }
  | { kind: "property"; path: string[]; command: string; prefix: string }
  | { kind: "value"; path: string[]; command: string; property: string }
  | { kind: "none" };

const COMMAND_VERBS = new Set([
  "add", "set", "remove", "print", "get", "find", "edit", "enable", "disable",
  "comment", "export", "import", "move", "reset", "unset", "monitor", "scan",
  "fetch", "download", "upgrade", "check-installation", "used", "info",
]);

/** Strips a trailing line continuation and normalises whitespace. */
export function joinContinuations(lines: string[], index: number): string {
  let start = index;
  while (start > 0 && /\\\s*$/.test(lines[start - 1] ?? "")) start--;

  let text = "";
  for (let i = start; i <= index; i++) {
    text += (lines[i] ?? "").replace(/\\\s*$/, " ");
  }
  return text;
}

/** Splits a line into tokens, keeping quoted strings whole. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      current += ch + text[i + 1];
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
      continue;
    }
    if (!quoted && /\s/.test(ch ?? "")) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** The section header in effect at a given line, as path segments. */
export function sectionAt(lines: string[], index: number): string[] {
  for (let i = index; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("/")) continue;

    // Only a bare header sets the section; a line that also carries a command
    // ("/tool fetch url=...") leaves the enclosing section unchanged.
    const tokens = tokenize(line);
    if (tokens.some((t) => t.includes("="))) continue;
    if (tokens.slice(1).some((t) => COMMAND_VERBS.has(t))) continue;

    // A space-joined header is one path spread over several tokens, so every
    // token contributes its segments.
    return splitPath(tokens.join(" "));
  }
  return [];
}

export function splitPath(text: string): string[] {
  return text
    .replace(/^\//, "")
    .split(/[/\s]+/)
    .filter(Boolean);
}

/**
 * Works out what the cursor is on. `line` is the text up to the cursor, with
 * continuations already joined.
 */
export function contextAt(before: string, section: string[]): Context {
  const trimmed = before.replace(/^\s+/, "");
  const tokens = tokenize(trimmed);
  const atBoundary = /\s$/.test(before) || trimmed === "";
  const current = atBoundary ? "" : (tokens[tokens.length - 1] ?? "");
  const settled = atBoundary ? tokens : tokens.slice(0, -1);

  // Inside a value: "mtu=14" or "mtu="
  if (current.includes("=")) {
    const key: string = current.split("=")[0] ?? "";
    const { path, command } = classify(settled, section);
    return { kind: "value", path, command, property: key };
  }

  // Typing a path, either a bare header or the start of an inline command.
  if (current.startsWith("/")) {
    const segments = splitPath(current);
    const partial = /[/\s]$/.test(current) ? "" : (segments.pop() ?? "");
    return { kind: "path", segments, prefix: partial };
  }

  // A path token already settled on this line: complete its subcommands.
  const head: string = settled[0] ?? "";
  if (head.startsWith("/")) {
    const segments = splitPath(head);
    const rest = settled.slice(1);
    const verb = rest.find((t) => COMMAND_VERBS.has(t));

    if (!verb) {
      // Could still be extending the path, or naming a command.
      return { kind: "command", path: segments, prefix: current };
    }
    return {
      kind: "property",
      path: segments,
      command: verb,
      prefix: current,
    };
  }

  // No path on this line: we are under a section header.
  if (section.length === 0) return { kind: "none" };

  if (settled.length === 0) {
    return { kind: "command", path: section, prefix: current };
  }

  const verb: string = settled.find((t) => COMMAND_VERBS.has(t)) ?? settled[0] ?? "";
  return { kind: "property", path: section, command: verb, prefix: current };
}

function classify(settled: string[], section: string[]) {
  const head: string = settled[0] ?? "";
  if (head.startsWith("/")) {
    const path = splitPath(head);
    const verb = settled.slice(1).find((t) => COMMAND_VERBS.has(t)) ?? "";
    return { path, command: verb };
  }
  const verb = settled.find((t) => COMMAND_VERBS.has(t)) ?? settled[0] ?? "";
  return { path: section, command: verb };
}

export { COMMAND_VERBS };
