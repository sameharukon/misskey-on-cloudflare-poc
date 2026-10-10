/**
 * Request-parameter validation with upstream's semantics (endpoint-base.ts: ajv v8,
 * `useDefaults: true`, `allErrors: false`, `misskey:id` format, OpenAPI `nullable`).
 * Workers forbid runtime code generation, so this interprets the subset of JSON Schema the
 * upstream `paramDef`s use (endpoint-params.gen.ts) instead of compiling with ajv.
 * The first error is reported like ajv's `errors[0]`: `{ param: schemaPath, reason: message }`.
 */

export type ParamSchema = {
  type?: string | string[];
  nullable?: boolean;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  items?: ParamSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  properties?: Record<string, ParamSchema>;
  required?: string[];
  additionalProperties?: boolean | ParamSchema;
  anyOf?: ParamSchema[];
  oneOf?: ParamSchema[];
  allOf?: ParamSchema[];
  not?: ParamSchema;
  if?: ParamSchema;
  then?: ParamSchema;
  else?: ParamSchema;
  [k: string]: unknown;
};

export type ParamError = { param: string; reason: string };

const FORMATS: Record<string, RegExp> = {
  "misskey:id": /^[a-zA-Z0-9]+$/,
};

const patternCache = new Map<string, RegExp>();
function re(pattern: string): RegExp {
  let r = patternCache.get(pattern);
  if (!r) {
    try {
      r = new RegExp(pattern, "u"); // ajv `unicodeRegExp: true`
    } catch {
      r = new RegExp(pattern);
    }
    patternCache.set(pattern, r);
  }
  return r;
}

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return typeof v === "number" && Number.isFinite(v) && v % 1 === 0;
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    case "array": return Array.isArray(v);
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    default: return true;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Code-point length (ajv's ucs2length). */
const strLen = (s: string) => [...s].length;

/**
 * Validate `data` against `schema` (applying defaults like ajv `useDefaults` outside anyOf /
 * oneOf / not / if). Returns the first error or null. Errors of failed anyOf / oneOf / then
 * branches come before the combinator's own error, as in ajv's `errors` array.
 */
export function validateParams(schema: ParamSchema, data: unknown): ParamError | null {
  return check(schema, data, "#", false);
}

function check(s: ParamSchema, v: unknown, path: string, composite: boolean): ParamError | null {
  const fail = (kw: string, reason: string): ParamError => ({ param: `${path}/${kw}`, reason });

  // type (+ nullable)
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const ok = types.some((t) => typeOk(t, v)) || (s.nullable === true && v === null);
    if (!ok) return fail("type", `must be ${types.join(",")}`);
  }

  // untyped keywords: const, enum, not, anyOf, oneOf, allOf, if/then/else
  if ("const" in s && !deepEqual(v, s.const)) return fail("const", "must be equal to constant");
  if (s.enum && !(s.nullable === true && v === null) && !s.enum.some((e) => deepEqual(e, v))) {
    return fail("enum", "must be equal to one of the allowed values");
  }
  if (s.not && check(s.not, v, `${path}/not`, true) === null) return fail("not", "must NOT be valid");
  if (s.anyOf) {
    let first: ParamError | null = null;
    let ok = false;
    for (let i = 0; i < s.anyOf.length; i++) {
      const e = check(s.anyOf[i]!, v, `${path}/anyOf/${i}`, true);
      if (!e) { ok = true; break; }
      first ??= e;
    }
    if (!ok) return first ?? fail("anyOf", "must match a schema in anyOf");
  }
  if (s.oneOf) {
    let first: ParamError | null = null;
    let passing = 0;
    for (let i = 0; i < s.oneOf.length; i++) {
      const e = check(s.oneOf[i]!, v, `${path}/oneOf/${i}`, true);
      if (!e) passing++;
      else first ??= e;
    }
    if (passing === 0) return first ?? fail("oneOf", "must match exactly one schema in oneOf");
    if (passing > 1) return fail("oneOf", "must match exactly one schema in oneOf");
  }
  if (s.allOf) {
    for (let i = 0; i < s.allOf.length; i++) {
      const e = check(s.allOf[i]!, v, `${path}/allOf/${i}`, composite);
      if (e) return e;
    }
  }
  if (s.if) {
    const cond = check(s.if, v, `${path}/if`, true) === null;
    const branch = cond ? s.then : s.else;
    if (branch) {
      const e = check(branch, v, `${path}/${cond ? "then" : "else"}`, composite);
      if (e) return e;
    }
  }

  // number
  if (typeof v === "number") {
    if (s.maximum !== undefined && !(v <= s.maximum)) return fail("maximum", `must be <= ${s.maximum}`);
    if (s.minimum !== undefined && !(v >= s.minimum)) return fail("minimum", `must be >= ${s.minimum}`);
    if (s.exclusiveMaximum !== undefined && !(v < s.exclusiveMaximum)) return fail("exclusiveMaximum", `must be < ${s.exclusiveMaximum}`);
    if (s.exclusiveMinimum !== undefined && !(v > s.exclusiveMinimum)) return fail("exclusiveMinimum", `must be > ${s.exclusiveMinimum}`);
  }

  // string
  if (typeof v === "string") {
    if (s.maxLength !== undefined && strLen(v) > s.maxLength) return fail("maxLength", `must NOT have more than ${s.maxLength} characters`);
    if (s.minLength !== undefined && strLen(v) < s.minLength) return fail("minLength", `must NOT have fewer than ${s.minLength} characters`);
    if (s.pattern !== undefined && !re(s.pattern).test(v)) return fail("pattern", `must match pattern "${s.pattern}"`);
  }

  // array
  if (Array.isArray(v)) {
    if (s.maxItems !== undefined && v.length > s.maxItems) return fail("maxItems", `must NOT have more than ${s.maxItems} items`);
    if (s.minItems !== undefined && v.length < s.minItems) return fail("minItems", `must NOT have fewer than ${s.minItems} items`);
    if (s.uniqueItems === true) {
      for (let i = v.length - 1; i > 0; i--) {
        for (let j = i - 1; j >= 0; j--) {
          if (deepEqual(v[i], v[j])) return fail("uniqueItems", `must NOT have duplicate items (items ## ${j} and ${i} are identical)`);
        }
      }
    }
    if (s.items && typeof s.items === "object" && !Array.isArray(s.items)) {
      for (let i = 0; i < v.length; i++) {
        const e = check(s.items, v[i], `${path}/items`, composite);
        if (e) return e;
      }
    }
  }

  // object
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (s.properties && !composite) {
      for (const [k, ps] of Object.entries(s.properties)) {
        if (o[k] === undefined && ps && typeof ps === "object" && "default" in ps) o[k] = structuredClone(ps.default);
      }
    }
    if (s.required) {
      for (const k of s.required) {
        if (o[k] === undefined) return fail("required", `must have required property '${k}'`);
      }
    }
    if (s.additionalProperties !== undefined && s.additionalProperties !== true) {
      for (const k of Object.keys(o)) {
        if (s.properties && k in s.properties) continue;
        if (s.additionalProperties === false) return fail("additionalProperties", "must NOT have additional properties");
        const e = check(s.additionalProperties, o[k], `${path}/additionalProperties`, composite);
        if (e) return e;
      }
    }
    if (s.properties) {
      for (const [k, ps] of Object.entries(s.properties)) {
        if (o[k] === undefined) continue;
        const e = check(ps, o[k], `${path}/properties/${k}`, composite);
        if (e) return e;
      }
    }
  }

  // format (ajv-formats run after the applicators)
  if (typeof v === "string" && s.format !== undefined) {
    const f = FORMATS[s.format];
    if (f && !f.test(v)) return fail("format", `must match format "${s.format}"`);
  }
  return null;
}

/** ApiCallService "Cast non JSON input" (GET query / multipart fields): boolean / number / integer strings → JSON. */
export function castNonJsonInput(schema: ParamSchema, data: Record<string, unknown>): ParamError | null {
  if (!schema.properties) return null;
  for (const [k, p] of Object.entries(schema.properties)) {
    if (["boolean", "number", "integer"].includes(String(p.type ?? "")) && typeof data[k] === "string") {
      try {
        data[k] = JSON.parse(data[k] as string);
      } catch {
        return { param: k, reason: `cannot cast to ${String(p.type)}` };
      }
    }
  }
  return null;
}
