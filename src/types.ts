import { readFileSync, existsSync } from "node:fs";

/**
 * Value types harvested from a live RouterOS device at build time.
 *
 * The command tree gives parameter names; this gives what may be assigned to
 * them. Both ship with the server, so nothing is asked of a router at runtime.
 */
export interface ValueType {
  /** The device's own wording, e.g. "auto | Num" — used in messages. */
  spec: string;
  kind?: "integer" | "string" | "ip" | "duration" | "mac";
  min?: number;
  max?: number;
  /** Bare words accepted besides the base type, e.g. ["auto"]. */
  literals?: string[];
}

export class Types {
  private readonly table: Record<string, ValueType>;
  /** Accepted values per parameter, from upstream completion data. */
  private readonly choices: Record<string, string[]>;

  constructor(typesPath: string, choicesPath?: string) {
    this.table = existsSync(typesPath)
      ? (JSON.parse(readFileSync(typesPath, "utf8")) as Record<string, ValueType>)
      : {};
    this.choices =
      choicesPath && existsSync(choicesPath)
        ? (JSON.parse(readFileSync(choicesPath, "utf8")) as Record<string, string[]>)
        : {};
  }

  /**
   * The two sources answer different questions and are merged here rather than
   * at build time, so either can be regenerated alone: ranges come from a
   * device, accepted values from upstream, and a parameter may have both.
   */
  get(path: string[], command: string, property: string): ValueType | null {
    const key = `${[...path, command].join("/")}|${property}`;
    const harvested = this.table[key];
    const accepted = this.choices[key];

    if (!harvested && !accepted) return null;
    if (!accepted) return harvested ?? null;

    if (!harvested) {
      return { spec: accepted.join(" | "), literals: accepted };
    }

    // A harvested literal list is what one device offered; upstream saw every
    // release, so the union is the safer set to accept.
    return {
      ...harvested,
      literals: [...new Set([...(harvested.literals ?? []), ...accepted])],
    };
  }

  get size(): number {
    return new Set([...Object.keys(this.table), ...Object.keys(this.choices)]).size;
  }
}

/**
 * Checks a written value against a harvested type.
 *
 * Returns a message when the value cannot be right, and null when it is fine
 * *or* when the type is not precise enough to judge. Staying quiet on the
 * uncertain cases matters more than catching every mistake: a warning on a
 * working config costs the user far more than a missed typo.
 */
export function checkValue(type: ValueType, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  // Anything computed is only known at run time.
  if (/^[$[(]/.test(value)) return null;
  // A quoted string can hold any of these forms; RouterOS coerces it.
  if (value.startsWith('"')) return null;
  // Lists and ranges are written with the same syntax as single values.
  if (/[,;]/.test(value)) return null;

  if (type.literals?.includes(value)) return null;

  // A parameter with a known set of values and no other form — no range, no
  // free string — accepts nothing outside that set. Where a type is also
  // known, the switch below decides, since "auto | Num" takes both.
  if (type.literals?.length && !type.kind) {
    const shown = type.literals.slice(0, 6).map((l) => `'${l}'`).join(", ");
    const more = type.literals.length > 6 ? `, … (${type.literals.length} total)` : "";
    return `invalid value '${value}' — expected one of ${shown}${more}`;
  }

  switch (type.kind) {
    case "integer": {
      // Hex and unit-suffixed forms are accepted by the console.
      if (/^0x[0-9a-f]+$/i.test(value)) return null;
      if (!/^-?\d+$/.test(value)) {
        return `invalid value '${value}' — expected ${describe(type)}`;
      }
      const numeric = Number(value);
      if (type.min !== undefined && type.max !== undefined) {
        if (numeric < type.min || numeric > type.max) {
          return `invalid value '${value}' — expected ${describe(type)}`;
        }
      }
      return null;
    }

    case "ip": {
      // Prefix lengths and ranges are written alongside plain addresses.
      const address = value.split("/")[0] ?? "";
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
        // IPv6 and interface names appear under the same parameter names.
        if (/^[0-9a-f:]+$/i.test(value) || /^[A-Za-z]/.test(value)) return null;
        return `invalid value '${value}' — expected ${describe(type)}`;
      }
      if (address.split(".").some((part) => Number(part) > 255)) {
        return `invalid value '${value}' — expected ${describe(type)}`;
      }
      return null;
    }

    case "mac": {
      if (/^[0-9a-f]{2}([:.-][0-9a-f]{2}){5}$/i.test(value)) return null;
      if (/^[A-Za-z]/.test(value)) return null;
      return `invalid value '${value}' — expected ${describe(type)}`;
    }

    // Durations and free strings admit too many spellings to judge safely.
    default:
      return null;
  }
}

function describe(type: ValueType): string {
  const parts: string[] = [];
  if (type.literals?.length) parts.push(type.literals.map((l) => `'${l}'`).join(" or "));

  if (type.kind === "integer") {
    parts.push(
      type.min !== undefined && type.max !== undefined
        ? `integer ${type.min}..${type.max}`
        : "an integer",
    );
  } else if (type.kind === "ip") parts.push("an IP address");
  else if (type.kind === "mac") parts.push("a MAC address");

  return parts.join(" or ") || type.spec;
}
