/**
 * JSON as the Python fleet reads and writes it: parsing that never throws, and `dumps`, which writes the
 * exact bytes Python's `json.dumps` writes (its separators, its escapes, `ensure_ascii`), so a ledger,
 * a chat line or a registry entry written here is the one the Python page and server expect.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Any JSON value, as parsed. */
export type Json = Schema.Json;

/** A JSON object. */
export type JsonObject = Schema.JsonObject;

/** A JSON value a writer builds: the same as {@link Json}, with mutable containers. */
export type JsonOut = null | boolean | number | string | readonly JsonOut[] | { readonly [key: string]: JsonOut | undefined };

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

const isJsonArray = Schema.is(Schema.Array(Schema.Json));

const isString = Schema.is(Schema.String);

const isNumber = Schema.is(Schema.Number);

const isBoolean = Schema.is(Schema.Boolean);

function isOutList(value: JsonOut): value is readonly JsonOut[] {
  return Array.isArray(value);
}

/** The JSON value `text` holds, or none when it does not parse. */
export function parseJson(text: string): Option.Option<Json> {
  return decodeJson(text);
}

/** The object `text` holds, or none when it does not parse or is not an object. */
export function parseObject(text: string): Option.Option<JsonObject> {
  return Option.filter(parseJson(text), isJsonObject);
}

/** `value` when it is a JSON object. */
export function asObject(value: Json | undefined): JsonObject | undefined {
  return value !== undefined && isJsonObject(value) ? value : undefined;
}

/** `value` when it is a JSON array. */
export function asArray(value: Json | undefined): readonly Json[] | undefined {
  return value !== undefined && isJsonArray(value) ? value : undefined;
}

/** `value` when it is a string. */
export function asString(value: Json | undefined): string | undefined {
  return value !== undefined && isString(value) ? value : undefined;
}

/** `value` when it is a number. */
export function asNumber(value: Json | undefined): number | undefined {
  return value !== undefined && isNumber(value) ? value : undefined;
}

/** `value` when it is a boolean. */
export function asBoolean(value: Json | undefined): boolean | undefined {
  return value !== undefined && isBoolean(value) ? value : undefined;
}

/** Python's truthiness of a JSON value: null, false, 0, "", [] and {} are false. */
export function truthy(value: Json | undefined): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === "") return false;
  const list = asArray(value);

  if (list !== undefined) return list.length > 0;
  const object = asObject(value);

  return object === undefined || Object.keys(object).length > 0;
}

function hex4(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

const SHORT = new Map(Object.entries({
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
}));

function quote(text: string, ensureAscii: boolean): string {
  let out = '"';

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const short = SHORT.get(char);

    if (short !== undefined) {
      out += short;
    } else if (code < 0x20 || (ensureAscii && code > 0x7e)) {
      if (code > 0xffff) {
        const offset = code - 0x10000;
        out += hex4(0xd800 + (offset >> 10)) + hex4(0xdc00 + (offset & 0x3ff));
      } else {
        out += hex4(code);
      }
    } else {
      out += char;
    }
  }

  return `${out}"`;
}

/** A number as Python writes it: integers bare, floats as `repr` gives them. */
function pyNumber(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : value < 0 ? "-Infinity" : "NaN";

  if (Number.isInteger(value) && Math.abs(value) < 1e16) return String(value);
  const exponent = Math.floor(Math.log10(Math.abs(value)));

  if (exponent >= 16 || exponent < -4) {
    const [mantissa = "", power = "0"] = value.toExponential().split("e");
    const sign = power.startsWith("-") ? "-" : "+";

    return `${mantissa}e${sign}${power.replace(/^[+-]/, "").padStart(2, "0")}`;
  }

  return String(value);
}

/** How `dumps` writes: Python's `indent` and `ensure_ascii`. */
export interface DumpOptions {
  readonly indent?: number;
  readonly ensureAscii?: boolean;
}

function write(value: JsonOut, options: DumpOptions, depth: number): string {
  const ensureAscii = options.ensureAscii ?? true;

  if (value === null) return "null";

  if (value === true) return "true";

  if (value === false) return "false";

  if (isString(value)) return quote(value, ensureAscii);

  if (isNumber(value)) return pyNumber(value);
  const indent = options.indent;

  const open = (inner: readonly string[], left: string, right: string): string => {
    if (inner.length === 0) return left + right;

    if (indent === undefined) return left + inner.join(", ") + right;
    const pad = " ".repeat(indent * (depth + 1));

    return `${left}\n${pad}${inner.join(`,\n${pad}`)}\n${" ".repeat(indent * depth)}${right}`;
  };

  if (isOutList(value)) return open(value.map((item) => write(item, options, depth + 1)), "[", "]");
  const entries: string[] = [];

  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    entries.push(`${quote(key, ensureAscii)}: ${write(item, options, depth + 1)}`);
  }

  return open(entries, "{", "}");
}

/** `value` as Python's `json.dumps(value, indent=..., ensure_ascii=...)` writes it (undefined keys left out). */
export function dumps(value: JsonOut, options: DumpOptions = {}): string {
  return write(value, options, 0);
}

/** A string as Python's `repr` writes it. */
export function pyStr(text: string): string {
  const q = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = q;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;

    if (char === q || char === "\\") out += `\\${char}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code >= 0x80 && code < 0xa0) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += char;
  }

  return out + q;
}

/** A JSON value as Python's `repr` writes the dict, list or scalar it parses to. */
export function pyRepr(value: JsonOut | undefined): string {
  if (value === undefined || value === null) return "None";

  if (value === true) return "True";

  if (value === false) return "False";

  if (isString(value)) return pyStr(value);

  if (isNumber(value)) return pyNumber(value);

  if (isOutList(value)) return `[${value.map((item) => pyRepr(item)).join(", ")}]`;
  const entries: string[] = [];

  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) entries.push(`${pyStr(key)}: ${pyRepr(item)}`);
  }

  return `{${entries.join(", ")}}`;
}
