import { readFileSync } from "node:fs";

/** A node kind as stored in the bundled schema. */
export type Kind = "d" | "c" | "a";

interface RawNode {
  k?: Kind;
  /** Version spans; absent means "present in every known release". */
  v?: (number | [number, number])[];
  c?: Record<string, RawNode>;
}

interface RawSchema {
  versions: string[];
  tree: Record<string, RawNode>;
}

export interface Node {
  name: string;
  kind: Kind;
  children: Record<string, RawNode>;
  /** Human-readable version range, e.g. "7.21+" or "7.9–7.12.2". */
  availability: string | null;
}

export class Schema {
  private readonly versions: string[];
  private readonly tree: Record<string, RawNode>;

  constructor(path: string) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as RawSchema;
    this.versions = raw.versions;
    this.tree = raw.tree;
  }

  /** Walks a path such as ["interface", "wireguard"]. */
  resolve(segments: string[]): Node | null {
    let level = this.tree;
    let node: RawNode | undefined;

    for (const segment of segments) {
      node = level[segment];
      if (!node) return null;
      level = node.c ?? {};
    }
    if (!node) return null;

    return {
      name: segments[segments.length - 1] ?? "",
      kind: node.k ?? "d",
      children: node.c ?? {},
      availability: this.describeVersions(node.v),
    };
  }

  /** Children of a path, for completion. Root when segments is empty. */
  childrenOf(segments: string[]): Node[] {
    const level =
      segments.length === 0 ? this.tree : this.resolve(segments)?.children;
    if (!level) return [];

    return Object.entries(level).map(([name, node]) => ({
      name,
      kind: node.k ?? "d",
      children: node.c ?? {},
      availability: this.describeVersions(node.v),
    }));
  }

  /**
   * Whether a path exists in any known release. Used for diagnostics, so it
   * deliberately answers for the union rather than one version — flagging a
   * path that is valid on the user's box would be worse than staying quiet.
   */
  has(segments: string[]): boolean {
    return this.resolve(segments) !== null;
  }

  private describeVersions(
    spans: (number | [number, number])[] | undefined,
  ): string | null {
    if (!spans || spans.length === 0) return null;

    const last = this.versions.length - 1;
    const first = spans[0]!;
    const start = typeof first === "number" ? first : first[0];
    const tail = spans[spans.length - 1]!;
    const end = typeof tail === "number" ? tail : tail[1];

    if (start === 0 && end === last) return null;
    if (end === last) return `${this.versions[start]}+`;
    return `${this.versions[start]}–${this.versions[end]}`;
  }
}
