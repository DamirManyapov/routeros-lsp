import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  CompletionItemKind,
  DiagnosticSeverity,
  type CompletionItem,
  type Diagnostic,
  type InitializeResult,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Schema, type Node } from "./schema.js";
import {
  findDuplicateProperties,
  findUndeclaredVariables,
  type Finding,
} from "./analyze.js";
import { Types, checkValue } from "./types.js";
import {
  contextAt,
  joinContinuations,
  sectionAt,
  splitPath,
  tokenize,
  COMMAND_VERBS,
} from "./parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = new Schema(join(here, "..", "schema", "schema.json"));
const types = new Types(join(here, "..", "schema", "types.json"));

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize((): InitializeResult => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: {
      // "-" and "." are word characters in RouterOS property names, and "/"
      // walks the command tree, so all three must retrigger completion.
      triggerCharacters: ["/", " ", "=", "-", "."],
      resolveProvider: false,
    },
    hoverProvider: true,
  },
  serverInfo: { name: "routeros-lsp", version: "0.1.0" },
}));

function iconFor(kind: Node["kind"]): CompletionItemKind {
  switch (kind) {
    case "d":
      return CompletionItemKind.Folder;
    case "c":
      return CompletionItemKind.Method;
    default:
      return CompletionItemKind.Property;
  }
}

function detailFor(node: Node): string {
  const parts: string[] = [];
  if (node.kind === "d") parts.push("menu");
  else if (node.kind === "c") parts.push("command");
  else parts.push("parameter");
  if (node.availability) parts.push(node.availability);
  return parts.join(" · ");
}

connection.onCompletion((params): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const lines = doc.getText().split(/\r?\n/);
  const lineIndex = params.position.line;
  const rawLine = lines[lineIndex] ?? "";
  const before =
    joinContinuations(lines, lineIndex).slice(
      0,
      Math.max(0, joinContinuations(lines, lineIndex).length - rawLine.length) +
        params.position.character,
    ) || rawLine.slice(0, params.position.character);

  const section = sectionAt(lines, Math.max(0, lineIndex - 1));
  const ctx = contextAt(before, section);

  switch (ctx.kind) {
    case "path": {
      const children = schema.childrenOf(ctx.segments);
      return children
        .filter((c) => c.kind !== "a")
        .map((c) => ({
          label: c.name,
          kind: iconFor(c.kind),
          detail: detailFor(c),
          // Menus keep completing, so offer the next separator right away.
          insertText: c.kind === "d" ? `${c.name}/` : c.name,
        }));
    }

    case "command": {
      // The path may already name a command — "/interface/wireguard/add" — in
      // which case its parameters are what should be offered, not siblings.
      const here = schema.resolve(ctx.path);
      if (here?.kind === "c") {
        return schema.childrenOf(ctx.path).map((c) => ({
          label: c.name,
          kind: CompletionItemKind.Property,
          detail: detailFor(c),
          insertText: `${c.name}=`,
        }));
      }

      return schema
        .childrenOf(ctx.path)
        .filter((c) => c.kind !== "a")
        .map((c) => ({
          label: c.name,
          kind: iconFor(c.kind),
          detail: detailFor(c),
        }));
    }

    case "property": {
      const target = [...ctx.path, ctx.command];
      const children = schema.childrenOf(target);
      return children
        .filter((c) => c.kind === "a")
        .map((c) => ({
          label: c.name,
          kind: CompletionItemKind.Property,
          detail: detailFor(c),
          insertText: `${c.name}=`,
        }));
    }

    default:
      // Values are not in the schema — it carries no types or ranges.
      return [];
  }
});

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const lines = doc.getText().split(/\r?\n/);
  const line = lines[params.position.line] ?? "";
  const word = wordAt(line, params.position.character);
  if (!word) return null;

  const section = sectionAt(lines, params.position.line);

  // A path segment under the cursor. A space-joined header spreads one path
  // over several tokens, so the whole line up to the first property is taken.
  if (line.trimStart().startsWith("/")) {
    const tokens = tokenize(line.trim());
    const head: string[] = [];
    for (const token of tokens) {
      if (token.includes("=") || COMMAND_VERBS.has(token)) break;
      head.push(token);
    }
    const segments = splitPath(head.join(" "));
    const index = segments.indexOf(word);
    if (index >= 0) {
      const node = schema.resolve(segments.slice(0, index + 1));
      if (node) {
        return {
          contents: {
            kind: "markdown" as const,
            value: `\`/${segments.slice(0, index + 1).join("/")}\`\n\n${detailFor(node)}`,
          },
        };
      }
    }
  }

  // A property name.
  const tokens = tokenize(line.trim());
  const verb = tokens.find((t) => COMMAND_VERBS.has(t));
  if (verb && section.length) {
    const node = schema.resolve([...section, verb, word]);
    if (node) {
      return {
        contents: {
          kind: "markdown" as const,
          value: `\`${word}\`\n\n${detailFor(node)}`,
        },
      };
    }
  }
  return null;
});

/**
 * Flags path segments that exist in no known RouterOS release.
 *
 * The check is deliberately conservative: it only reports a segment whose
 * parent is a known menu, so an unrecognised top-level package stays silent
 * rather than lighting up a valid config.
 */
function diagnose(doc: TextDocument): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = doc.getText().split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) return;

    const head = tokenize(trimmed)[0] ?? "";
    const segments = splitPath(head);
    if (segments.length === 0) return;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment) continue;
      if (schema.has(segments.slice(0, i + 1))) continue;

      // Only complain when the parent is known; otherwise the whole subtree is
      // outside the schema (a package CHR never ships) and silence is right.
      if (i === 0 || !schema.has(segments.slice(0, i))) return;

      const previous = segments[i - 1] ?? "";
      const after = head.indexOf(previous) + previous.length;
      const column = head.indexOf(segment, after);
      if (column < 0) return;

      const start = line.indexOf(head) + column;
      out.push({
        severity: DiagnosticSeverity.Warning,
        range: {
          start: { line: index, character: start },
          end: { line: index, character: start + segment.length },
        },
        message: `unknown path segment '${segment}' under /${segments
          .slice(0, i)
          .join("/")}`,
        source: "routeros",
        code: "unknown-path",
      });
      return;
    }
  });

  for (const finding of [
    ...findDuplicateProperties(lines),
    ...findUndeclaredVariables(lines),
    ...findBadValues(lines),
  ]) {
    out.push(toDiagnostic(finding));
  }

  return out;
}

/** Reports values that contradict the type harvested for their parameter. */
function findBadValues(lines: string[]): Finding[] {
  const out: Finding[] = [];
  let insideString = false;

  lines.forEach((raw, index) => {
    const wasInside = insideString;
    insideString = insideString !== hasOddQuotes(raw);
    if (wasInside) return;

    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    // A continuation carries the tail of the command above it.
    if (/\\\s*$/.test(lines[index - 1] ?? "")) return;

    const text = joinContinuations(lines, index);
    const tokens = tokenize(text.trim());
    const head = tokens[0] ?? "";

    let path: string[];
    let command: string;
    if (head.startsWith("/")) {
      path = splitPath(head);
      command = tokens.slice(1).find((t) => COMMAND_VERBS.has(t)) ?? "";
      // "/ip/firewall/filter/add" puts the verb in the path itself.
      if (!command && path.length > 1 && COMMAND_VERBS.has(path[path.length - 1]!)) {
        command = path.pop()!;
      }
    } else {
      path = sectionAt(lines, index - 1);
      command = tokens.find((t) => COMMAND_VERBS.has(t)) ?? "";
    }
    if (!command || path.length === 0) return;

    for (const token of tokens) {
      const eq = token.indexOf("=");
      if (eq <= 0) continue;

      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (key.startsWith(".") || key.includes(".") || key.startsWith("!")) continue;

      const type = types.get(path, command, key);
      if (!type) continue;

      const message = checkValue(type, value);
      if (!message) continue;

      // Report against the written line, which may be a continuation.
      const column = raw.indexOf(`${key}=`);
      if (column < 0) continue;

      out.push({
        line: index,
        column: column + key.length + 1,
        length: value.length,
        message,
        severity: "warning",
        code: "invalid-value",
      });
    }
  });

  return out;
}

function hasOddQuotes(text: string): boolean {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === '"') count++;
  }
  return count % 2 === 1;
}

function toDiagnostic(finding: Finding): Diagnostic {
  return {
    severity:
      finding.severity === "error"
        ? DiagnosticSeverity.Error
        : DiagnosticSeverity.Warning,
    range: {
      start: { line: finding.line, character: finding.column },
      end: { line: finding.line, character: finding.column + finding.length },
    },
    message: finding.message,
    source: "routeros",
    code: finding.code,
  };
}

documents.onDidChangeContent((change) => {
  connection.sendDiagnostics({
    uri: change.document.uri,
    diagnostics: diagnose(change.document),
  });
});

function wordAt(line: string, character: number): string | null {
  const isWord = (c: string) => /[A-Za-z0-9_-]/.test(c);
  let start = character;
  let end = character;
  while (start > 0 && isWord(line[start - 1] ?? "")) start--;
  while (end < line.length && isWord(line[end] ?? "")) end++;
  const word = line.slice(start, end);
  return word || null;
}

documents.listen(connection);
connection.listen();
