#!/usr/bin/env node
/**
 * Emit packages/api/src/endpoint-params.gen.ts from the pinned upstream endpoints:
 * every endpoint's `paramDef` JSON schema (evaluated: spreads / imported constants such as
 * `notificationTypes` or `nameSchema` are resolved from the upstream sources) and the
 * remaining ApiCallService gate fields (`prohibitMoved`, `requiredRolePolicy`, `requireFile`).
 * The router validates request bodies against these schemas the way upstream's ajv
 * (`useDefaults: true`) does in endpoint-base.ts. Re-run after bumping upstream.
 *
 * Usage: node scripts/gen-endpoint-params.mjs [--check]
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "upstream/misskey/packages/backend/src");
const backend = resolve(src, "server/api");
const out = resolve(root, "packages/api/src/endpoint-params.gen.ts");
const ts = createRequire(import.meta.url)(resolve(root, "node_modules/typescript"));

const list = readFileSync(resolve(backend, "endpoint-list.ts"), "utf8");
const names = [...list.matchAll(/from '\.\/endpoints\/(.+?)\.js'/g)].map((m) => m[1]);
if (names.length === 0) {
  console.error("gen-endpoint-params: no endpoints found (is the upstream submodule checked out?)");
  process.exit(2);
}

/** Source text of `[export] const NAME ... = <expr>;` (expression only), scanning to the `;` at depth 0. */
function constExpr(text, name) {
  const m = new RegExp(`(?:^|\\n)(?:export )?const ${name}\\b[^=\\n]*=`).exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  const start = i;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch;
      i++;
      while (i < text.length && text[i] !== q) i += text[i] === "\\" ? 2 : 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i) + 1;
    } else if (ch === "/" && /[(,=:[!&|?{};]$/.test(text.slice(start, i).trimEnd() || "=")) {
      // regex literal (`pattern: /…/.source`)
      i++;
      let cls = false;
      while (i < text.length && (cls || text[i] !== "/")) {
        if (text[i] === "\\") i++;
        else if (text[i] === "[") cls = true;
        else if (text[i] === "]") cls = false;
        i++;
      }
    } else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === ";" && depth === 0) return text.slice(start, i);
    i++;
  }
  return null;
}

function resolveImport(fromFile, spec) {
  let p = spec.startsWith("@/") ? resolve(src, spec.slice(2)) : resolve(dirname(fromFile), spec);
  p = p.replace(/\.js$/, ".ts");
  if (existsSync(p) && statSync(p).isFile()) return p;
  if (existsSync(p.replace(/\.ts$/, "/index.ts"))) return p.replace(/\.ts$/, "/index.ts");
  return null;
}

/** Imported binding NAME of `file` → [module file, exported name]. */
function importOf(text, file, name) {
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
    for (const part of m[1].split(",")) {
      const [orig, alias] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if ((alias ?? orig) === name) {
        const target = resolveImport(file, m[2]);
        if (target) return [target, orig];
      }
    }
  }
  return null;
}

const cache = new Map();
/** Evaluate `const NAME` of `file`, resolving free identifiers from the same file or its imports. */
function evalConst(file, name, stack = []) {
  const key = `${file}#${name}`;
  if (cache.has(key)) return cache.get(key);
  if (stack.includes(key)) throw new Error(`gen-endpoint-params: cycle at ${key}`);
  const text = readFileSync(file, "utf8");
  const expr = constExpr(text, name);
  if (expr == null) {
    const imp = importOf(text, file, name);
    if (imp) return evalConst(imp[0], imp[1], [...stack, key]);
    // `export { x } from` / re-exports
    for (const m of text.matchAll(/export\s+\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
      if (m[1].split(",").some((p) => p.trim() === name)) {
        const target = resolveImport(file, m[2]);
        if (target) return evalConst(target, name, [...stack, key]);
      }
    }
    throw new Error(`gen-endpoint-params: cannot resolve '${name}' in ${file}`);
  }
  const js = ts.transpileModule(`const __v = ${expr};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const scope = {};
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const v = Function(...Object.keys(scope), `${js}\nreturn __v;`)(...Object.values(scope));
      cache.set(key, v);
      return v;
    } catch (e) {
      const ref = e instanceof ReferenceError && /^(\w+) is not defined/.exec(e.message)?.[1];
      if (!ref || ref in scope) throw new Error(`gen-endpoint-params: evaluating ${name} in ${file}: ${e.message}`);
      scope[ref] = evalConst(file, ref, [...stack, key]);
    }
  }
  throw new Error(`gen-endpoint-params: too many free identifiers in ${key}`);
}

const params = {};
const extra = {};
for (const name of names) {
  const file = resolve(backend, "endpoints", `${name}.ts`);
  if (!existsSync(file)) continue;
  params[name] = JSON.parse(JSON.stringify(evalConst(file, "paramDef")));
  const text = readFileSync(file, "utf8");
  const metaStart = text.indexOf("export const meta = {");
  const block = metaStart >= 0 ? text.slice(metaStart, text.indexOf("\n} as const;", metaStart)) : "";
  const x = {};
  if (/\n\tprohibitMoved: true,/.test(block)) x.prohibitMoved = true;
  if (/\n\trequireFile: true,/.test(block)) x.requireFile = true;
  const policy = /\n\trequiredRolePolicy: ['"]([^'"]+)['"],/.exec(block)?.[1];
  if (policy) x.requiredRolePolicy = policy;
  if (Object.keys(x).length) extra[name] = x;
}

const lines = Object.entries(params).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
const body = `// Generated by scripts/gen-endpoint-params.mjs from upstream/misskey — do not edit.
/* eslint-disable */
import type { ParamSchema } from "./param-validate.js";

/** upstream \`paramDef\` of every endpoint (validated like endpoint-base.ts: ajv with \`useDefaults\`). */
export const ENDPOINT_PARAM_DEFS: Readonly<Record<string, ParamSchema>> = {
${lines.join("\n")}
};

/** upstream meta gate fields not in endpoint-meta.gen.ts. */
export const ENDPOINT_EXTRA_META: Readonly<Record<string, { prohibitMoved?: true; requireFile?: true; requiredRolePolicy?: string }>> = ${JSON.stringify(extra, null, 2)};
`;

if (process.argv.includes("--check")) {
  const cur = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (cur !== body) {
    console.error("gen-endpoint-params: packages/api/src/endpoint-params.gen.ts is stale; run node scripts/gen-endpoint-params.mjs");
    process.exit(1);
  }
  console.log(`gen-endpoint-params: up to date (${Object.keys(params).length} endpoints)`);
} else {
  writeFileSync(out, body);
  console.log(`gen-endpoint-params: wrote ${Object.keys(params).length} endpoints`);
}
