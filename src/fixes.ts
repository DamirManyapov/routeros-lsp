/**
 * Quick fixes offered against the server's own diagnostics.
 *
 * Each fix is derived from the diagnostic's code, so a fix can only ever
 * appear where the server already said something is wrong. Fixes that cannot
 * be made safely — a value with no obvious correction, a variable whose intent
 * is unclear — are simply not offered rather than guessed at.
 */

import type { Diagnostic, Range, TextEdit } from "vscode-languageserver/node.js";

export interface Fix {
  title: string;
  edits: TextEdit[];
  /** Marks the single most likely fix so the editor can apply it directly. */
  preferred?: boolean;
}

/** Levenshtein distance, capped — only near misses are worth suggesting. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 4) return 99;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);

  for (let i = 1; i < rows; i++) {
    const current = [i];
    for (let j = 1; j < cols; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }
  return previous[cols - 1] ?? 99;
}

/**
 * Ranks candidates by closeness to what was written. A shared prefix counts
 * for a lot: someone typing "wi" means "wireguard" or "wireless", not "vlan".
 */
export function suggestions(written: string, candidates: string[], limit = 3): string[] {
  const scored = candidates
    .map((candidate) => {
      const prefix = candidate.startsWith(written);
      const score = prefix ? -1 : distance(written, candidate);
      return { candidate, score };
    })
    .filter((entry) => entry.score <= 3)
    .sort((a, b) => a.score - b.score || a.candidate.length - b.candidate.length);

  return scored.slice(0, limit).map((entry) => entry.candidate);
}

/** Replaces an unknown path segment with a plausible sibling. */
export function fixUnknownSegment(
  uri: string,
  diagnostic: Diagnostic,
  written: string,
  siblings: string[],
): Fix[] {
  return suggestions(written, siblings).map((name, index) => ({
    title: `Replace with '${name}'`,
    preferred: index === 0,
    edits: [{ range: diagnostic.range, newText: name }],
  }));
}

/**
 * Offers the literal alternatives a parameter accepts, and clamps a number
 * that merely fell outside its range.
 */
export function fixInvalidValue(
  diagnostic: Diagnostic,
  written: string,
  type: { min?: number; max?: number; literals?: string[] },
): Fix[] {
  const fixes: Fix[] = [];

  for (const literal of type.literals ?? []) {
    fixes.push({
      title: `Replace with '${literal}'`,
      edits: [{ range: diagnostic.range, newText: literal }],
    });
  }

  // A number outside its bounds has an obvious nearest legal value.
  if (/^-?\d+$/.test(written) && type.min !== undefined && type.max !== undefined) {
    const numeric = Number(written);
    const clamped = numeric < type.min ? type.min : type.max;
    fixes.push({
      title: `Replace with ${clamped}`,
      preferred: true,
      edits: [{ range: diagnostic.range, newText: String(clamped) }],
    });
  }

  return fixes;
}

/** Declares a variable that was used without one. */
export function fixUndeclaredVariable(
  diagnostic: Diagnostic,
  name: string,
  lines: string[],
): Fix[] {
  const line = diagnostic.range.start.line;
  const indent = /^[ \t]*/.exec(lines[line] ?? "")?.[0] ?? "";

  // Declare on the line above, where the reader expects to find it.
  const at: Range = {
    start: { line, character: 0 },
    end: { line, character: 0 },
  };

  return [
    {
      title: `Declare ':local ${name}'`,
      preferred: true,
      edits: [{ range: at, newText: `${indent}:local ${name};\n` }],
    },
    {
      title: `Import ':global ${name}'`,
      edits: [{ range: at, newText: `${indent}:global ${name};\n` }],
    },
  ];
}

/** Drops the earlier of two assignments to the same property. */
export function fixDuplicateProperty(
  diagnostic: Diagnostic,
  property: string,
  lines: string[],
): Fix[] {
  const line = lines[diagnostic.range.start.line] ?? "";

  // The diagnostic points at the second occurrence; the first is the one to
  // remove, since RouterOS keeps the last.
  const pattern = new RegExp(`\\s*\\b${escape(property)}=\\S+`);
  const match = pattern.exec(line);
  if (!match) return [];

  return [
    {
      title: `Remove the earlier '${property}='`,
      preferred: true,
      edits: [
        {
          range: {
            start: { line: diagnostic.range.start.line, character: match.index },
            end: {
              line: diagnostic.range.start.line,
              character: match.index + match[0].length,
            },
          },
          newText: "",
        },
      ],
    },
  ];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
