/**
 * Semantic tokens: colour driven by meaning rather than by shape.
 *
 * tree-sitter already knows a `$name` is a variable. What it cannot know is
 * whether that name was ever declared, whether it is a loop counter, or
 * whether it is a function being called — those follow from the scope
 * analysis the diagnostics already perform, so this reuses it.
 *
 * The protocol wants one flat array of integers, five per token, each
 * position expressed as a delta from the token before it. Absolute positions
 * are collected first and encoded at the end, since emitting them in order is
 * far easier to reason about than emitting deltas as we go.
 */

import { tokenize } from "./parse.js";
import { hasOddQuotes } from "./analyze.js";

/** Token types this server emits, in the order the client is told about them. */
export const TOKEN_TYPES = [
  "variable",
  "parameter",
  "function",
  "property",
  "keyword",
] as const;

/** Modifiers, likewise ordered; the wire format indexes into this list. */
export const TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "defaultLibrary",
] as const;

type TokenType = (typeof TOKEN_TYPES)[number];
type Modifier = (typeof TOKEN_MODIFIERS)[number];

interface Token {
  line: number;
  column: number;
  length: number;
  type: TokenType;
  modifiers: Modifier[];
}

/**
 * Finds every variable reference and decides what it means.
 *
 * Scoping follows RouterOS: a block sees the scope enclosing it, loops bind
 * their own counter, and a function body sees only its own scopes, its
 * positional arguments and globals.
 */
export function semanticTokens(lines: string[]): number[] {
  const tokens: Token[] = [];

  const globals = new Set<string>();
  const scopes: Set<string>[] = [new Set()];
  const functionDepth: number[] = [];
  const pending: string[] = [];
  // Names bound to a "do={ }" body, so a later reference to one reads as a
  // call rather than as a plain variable.
  const functions = new Set<string>();
  let inlineBody = false;
  let insideString = false;

  const visible = (name: string) =>
    globals.has(name) ||
    scopes.some((scope, depth) => {
      const boundary = functionDepth[functionDepth.length - 1];
      if (boundary !== undefined && depth < boundary - 1) return false;
      return scope.has(name);
    });

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    const wasInside = insideString;
    insideString = insideString !== hasOddQuotes(raw);

    if (wasInside || !trimmed || trimmed.startsWith("#")) continue;

    const parts = tokenize(trimmed);

    for (let position = 0; position < parts.length; position++) {
      const part = parts[position] ?? "";

      // A declaration names the variable that follows it.
      if (part === ":local" || part === ":global") {
        const name = clean(parts[position + 1] ?? "");
        if (name) {
          const isFunction = parts.some((p) => p.startsWith("do={"));
          if (isFunction) functions.add(name);
          if (part === ":global") globals.add(name);
          else if (isFunction) {
            scopes[scopes.length - 1]?.add(name);
            pending.push(name);
          } else scopes[scopes.length - 1]?.add(name);

          const column = raw.indexOf(name, raw.indexOf(part) + part.length);
          if (column >= 0) {
            tokens.push({
              line: index,
              column,
              length: name.length,
              type: isFunction ? "function" : "variable",
              modifiers: part === ":global" ? ["declaration", "definition"] : ["declaration"],
            });
          }
        }
        continue;
      }

      // A loop binds its counter for the body that follows.
      if (part === ":for" || part === ":foreach") {
        for (const piece of (parts[position + 1] ?? "").split(",")) {
          const name = clean(piece);
          if (!name) continue;
          scopes[scopes.length - 1]?.add(name);
          const column = raw.indexOf(name, raw.indexOf(part) + part.length);
          if (column >= 0) {
            tokens.push({
              line: index,
              column,
              length: name.length,
              type: "variable",
              modifiers: ["declaration", "readonly"],
            });
          }
        }
        continue;
      }

      if (part.startsWith("do={")) {
        const isFunction = parts[0] === ":local" || parts[0] === ":global";
        if (isFunction) {
          functionDepth.push(scopes.length + 1);
          if (countBraces(trimmed, "}") >= countBraces(trimmed, "{")) {
            scopes.push(new Set());
            inlineBody = true;
          }
        }
      }

      // Scripts stored as string values reference names declared elsewhere.
      if (part.includes('"') || part.includes("\\$")) continue;

      for (const { name, offset } of references(part)) {
        const column = raw.indexOf(part) + offset;
        if (column < 0) continue;

        // $1, $2 … are the arguments a function was called with.
        if (/^\d+$/.test(name)) {
          tokens.push({
            line: index,
            column,
            length: name.length + 1,
            type: "parameter",
            modifiers: ["readonly"],
          });
          continue;
        }

        // Calling a function looks exactly like reading a variable; only the
        // declaration says which it is.
        const isCall = functions.has(name);

        tokens.push({
          line: index,
          column,
          length: name.length + 1,
          type: isCall ? "function" : "variable",
          // An undeclared name gets no modifier, which is what lets a theme
          // show it differently from one the file actually declares.
          modifiers: visible(name) ? ["definition"] : [],
        });
      }
    }

    if (inlineBody) {
      scopes.pop();
      functionDepth.pop();
      inlineBody = false;
    }

    const opens = countBraces(trimmed, "{");
    const closes = countBraces(trimmed, "}");
    for (let i = 0; i < opens; i++) scopes.push(new Set());
    for (let i = 0; i < closes; i++) {
      if (scopes.length > 1) scopes.pop();
      const boundary = functionDepth[functionDepth.length - 1];
      if (boundary !== undefined && scopes.length < boundary) functionDepth.pop();
    }
    for (const name of pending) scopes[scopes.length - 1]?.add(name);
    pending.length = 0;
  }

  return encode(tokens);
}

/** Variable references inside one token, with their offset into it. */
function references(part: string): { name: string; offset: number }[] {
  const found: { name: string; offset: number }[] = [];
  const pattern = /\$\{?"?([A-Za-z_][A-Za-z0-9_-]*|\d+)"?\}?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(part)) !== null) {
    if (match[1]) found.push({ name: match[1], offset: match.index });
  }
  return found;
}

function clean(text: string): string {
  const name = text.replace(/^\$/, "").replace(/[;=].*$/, "").trim();
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) ? name : "";
}

function countBraces(text: string, brace: "{" | "}"): number {
  let count = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === '"') { quoted = !quoted; continue; }
    if (!quoted && text[i] === brace) count++;
  }
  return count;
}

/**
 * Encodes to the wire format: five integers per token, positions relative to
 * the token before. Tokens must be sorted, which they are not while a line is
 * scanned out of order.
 */
function encode(tokens: Token[]): number[] {
  const sorted = [...tokens].sort(
    (a, b) => a.line - b.line || a.column - b.column,
  );

  const out: number[] = [];
  let lastLine = 0;
  let lastColumn = 0;

  for (const token of sorted) {
    const deltaLine = token.line - lastLine;
    const deltaColumn = deltaLine === 0 ? token.column - lastColumn : token.column;

    let mask = 0;
    for (const modifier of token.modifiers) {
      mask |= 1 << TOKEN_MODIFIERS.indexOf(modifier);
    }

    out.push(
      deltaLine,
      deltaColumn,
      token.length,
      TOKEN_TYPES.indexOf(token.type),
      mask,
    );

    lastLine = token.line;
    lastColumn = token.column;
  }

  return out;
}
