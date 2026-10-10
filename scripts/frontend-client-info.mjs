#!/usr/bin/env node
// Writes <out>/misskey-cf-client.json: what upstream HtmlTemplateService computes at
// startup (vite entry/css from the manifest, inlined boot loader js/css, langs, version),
// so the gateway Worker can render the same base HTML without a filesystem.
//
// Usage: node scripts/frontend-client-info.mjs <upstream-tree> <out-dir> [rev] [emoji-assets-version]
import fs from 'node:fs';
import path from 'node:path';

const [tree, out, rev = null, emojiAssetsVersion = null] = process.argv.slice(2);
if (!tree || !out) {
	console.error('usage: frontend-client-info.mjs <upstream-tree> <out-dir> [rev]');
	process.exit(2);
}

const readText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null);
const readJson = (p) => {
	const t = readText(p);
	return t == null ? null : JSON.parse(t);
};

/** Port of upstream HtmlTemplateService.collectViteAssetFiles. */
function collectViteAssetFiles(manifest) {
	if (manifest == null) return null;
	const entryFile = Object.values(manifest).find((chunk) => chunk.isEntry);
	if (!entryFile) return { entryJs: null, css: [], modulePreloads: [] };
	const seen = new Set();
	const css = new Set(entryFile.css ?? []);
	const modulePreloads = new Set();
	const collect = (imports, recursive = false) => {
		for (const id of imports) {
			if (seen.has(id)) continue;
			seen.add(id);
			const chunk = manifest[id];
			if (!chunk) return;
			for (const c of chunk.css ?? []) css.add(c);
			if (Array.isArray(chunk.imports)) collect(chunk.imports, true);
			if (!recursive) modulePreloads.add(chunk.file);
		}
	};
	if (Array.isArray(entryFile.imports)) collect(entryFile.imports);
	return { entryJs: entryFile.file, css: [...css], modulePreloads: [...modulePreloads] };
}

const constTs = readText(path.join(tree, 'packages/i18n/src/const.ts')) ?? '';
const langsBlock = constTs.match(/export const languages = \[([\s\S]*?)\]/);
const langs = langsBlock ? [...langsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

const pkg = readJson(path.join(tree, 'package.json'));
const feBuilt = path.join(tree, 'built/_frontend_vite_');
const embedBuilt = path.join(tree, 'built/_frontend_embed_vite_');

const info = {
	version: pkg.version,
	upstreamRev: rev,
	emojiAssetsVersion,
	builtAt: new Date().toISOString(),
	langs,
	frontend: {
		viteFiles: collectViteAssetFiles(readJson(path.join(feBuilt, 'manifest.json'))),
		bootJs: readText(path.join(feBuilt, 'loader/boot.js')),
		bootCss: readText(path.join(feBuilt, 'loader/style.css')),
	},
	embed: fs.existsSync(embedBuilt)
		? {
			viteFiles: collectViteAssetFiles(readJson(path.join(embedBuilt, 'manifest.json'))),
			bootJs: readText(path.join(embedBuilt, 'loader/boot.js')),
			bootCss: readText(path.join(embedBuilt, 'loader/style.css')),
		}
		: null,
};

if (!info.frontend.viteFiles?.entryJs) {
	console.error('vite manifest has no entry chunk:', path.join(feBuilt, 'manifest.json'));
	process.exit(1);
}

fs.writeFileSync(path.join(out, 'misskey-cf-client.json'), JSON.stringify(info));
console.log(`misskey-cf-client.json: version=${info.version} entry=${info.frontend.viteFiles.entryJs} css=${info.frontend.viteFiles.css.length} langs=${langs.length}`);
