/**
 * The small subset of Transit-JSON the harness needs to talk to Penpot's
 * exporter (which only parses `application/transit+json` bodies) and to read
 * the backend's SSE events (encoded as transit "json-verbose").
 *
 * Encoding: plain objects become transit maps whose keys are keywords;
 * `kw('x')` marks a keyword value and `uuid('…')` a UUID value. Everything else
 * is passed through as JSON.
 *
 * Decoding: keywords become plain strings, UUIDs become strings, `~m` instants
 * become numbers (ms), sets become arrays. Keys keep their kebab-case names.
 */

export class Keyword {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export class Uuid {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export const kw = (name: string): Keyword => new Keyword(name);
export const uuid = (value: string): Uuid => new Uuid(value);

function encodeValue(value: unknown): unknown {
  if (value instanceof Keyword) return `~:${value.name}`;
  if (value instanceof Uuid) return `~u${value.value}`;
  if (typeof value === 'string') return /^[~^`]/.test(value) ? `~${value}` : value;
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === 'object') {
    const out: unknown[] = ['^ '];
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out.push(`~:${k}`, encodeValue(v));
    }
    return out;
  }
  return value;
}

export function encodeTransit(value: unknown): string {
  return JSON.stringify(encodeValue(value));
}

function decodeString(s: string): unknown {
  if (s.length < 2 || s[0] !== '~') return s;
  const tag = s[1];
  const rest = s.slice(2);
  switch (tag) {
    case '~':
    case '^':
    case '`':
      return s.slice(1);
    case ':':
    case '$':
    case 'u':
    case 'r':
    case 'c':
      return rest;
    case 'm':
      return Number(rest);
    case 't':
      return Date.parse(rest);
    case 'i':
    case 'n':
    case 'd':
    case 'f':
      return Number(rest);
    case '?':
      return rest === 't';
    case '_':
      return null;
    case 'z':
      return rest === 'NaN' ? NaN : rest === 'INF' ? Infinity : -Infinity;
    default:
      return s;
  }
}

function decodeKey(k: string): string {
  const v = decodeString(k);
  return typeof v === 'string' ? v : String(v);
}

function decodeValue(value: unknown): unknown {
  if (typeof value === 'string') return decodeString(value);
  if (Array.isArray(value)) {
    if (value[0] === '^ ') {
      const out: Record<string, unknown> = {};
      for (let i = 1; i + 1 < value.length; i += 2) {
        out[decodeKey(String(value[i]))] = decodeValue(value[i + 1]);
      }
      return out;
    }
    // ["~#tag", rep] tagged value (non-verbose form)
    if (value.length === 2 && typeof value[0] === 'string' && value[0].startsWith('~#')) {
      return decodeValue(value[1]);
    }
    return value.map(decodeValue);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    // {"~#tag": rep} tagged value (verbose form): sets, lists, custom records.
    if (entries.length === 1 && entries[0]![0].startsWith('~#')) {
      return decodeValue(entries[0]![1]);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[decodeKey(k)] = decodeValue(v);
    return out;
  }
  return value;
}

export function decodeTransit(text: string): unknown {
  return decodeValue(JSON.parse(text));
}
