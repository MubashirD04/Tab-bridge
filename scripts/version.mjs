#!/usr/bin/env node
// One version for everything that ships: the Firefox extension, the npm
// package and the Claude Code plugin. They talk to each other, so releasing
// them at the same version keeps "which helper goes with which extension"
// a non-question.
//
//   node scripts/version.mjs check            all three agree
//   node scripts/version.mjs check v0.3.0     ...and match this release tag
//   node scripts/version.mjs set 0.3.0        bump all three
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["extension/manifest.json", "packages/daemon/package.json", "plugins/sharepane/.claude-plugin/plugin.json"];
const SEMVER = /^\d+\.\d+\.\d+$/; // Firefox rejects prerelease suffixes like -beta.1

const read = (file) => JSON.parse(readFileSync(path.join(root, file), "utf-8"));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const [command, arg] = process.argv.slice(2);

if (command === "check") {
  const versions = FILES.map((file) => [file, read(file).version]);
  const distinct = new Set(versions.map(([, v]) => v));
  if (distinct.size !== 1) {
    fail(`Versions differ:\n${versions.map(([f, v]) => `    ${v}  ${f}`).join("\n")}\n  Run: node scripts/version.mjs set <version>`);
  }
  const [version] = distinct;
  if (arg !== undefined && arg.replace(/^v/, "") !== version) {
    fail(`Tag ${arg} doesn't match the version in the files (${version}). Run: node scripts/version.mjs set ${arg.replace(/^v/, "")}`);
  }
  console.log(`✓ Everything is at ${version}${arg ? `, matching ${arg}` : ""}.`);
} else if (command === "set") {
  if (!arg || !SEMVER.test(arg)) fail("Usage: node scripts/version.mjs set <major.minor.patch>");
  for (const file of FILES) {
    const full = path.join(root, file);
    const text = readFileSync(full, "utf-8");
    // Replace in place rather than re-serialise, to keep each file's formatting.
    const next = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${arg}"`);
    if (next === text && read(file).version !== arg) fail(`No "version" field found in ${file}`);
    writeFileSync(full, next);
    console.log(`  ${file} → ${arg}`);
  }
  console.log("Then run `npm install` (to update package-lock.json) and `npm run build` (to rebuild the plugin bundle).");
} else {
  fail("Usage: node scripts/version.mjs check [tag] | set <version>");
}
