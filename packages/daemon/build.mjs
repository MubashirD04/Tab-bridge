// Bundles the CLI into one self-contained file with every dependency
// inlined. Self-contained matters: `sharepane setup` copies this single
// file to ~/.sharepane/bin/ and points Firefox and Claude at the copy, so
// it keeps working after npm clears the npx cache it was run from.
//
// Writes it twice: dist/ for the npm package, and the Claude Code plugin's
// bin/ so the plugin needs no install step.
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(path.join(here, "package.json"), "utf-8"));
const outfile = path.join(here, "dist/sharepane.mjs");
const pluginCopy = path.join(here, "../../plugins/sharepane/bin/sharepane.mjs");

// Start clean: dist/ holds only the bundle, never stale per-file output.
await rm(path.join(here, "dist"), { recursive: true, force: true });

await build({
  entryPoints: [path.join(here, "src/cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  legalComments: "none",
  define: { __SHAREPANE_VERSION__: JSON.stringify(pkg.version), __SHAREPANE_PACKAGE__: JSON.stringify(pkg.name) },
  // Some bundled dependencies are CommonJS and call require(); give the ESM
  // bundle one.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __tbCreateRequire } from "node:module";',
      "const require = __tbCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

// Executable, so `npx sharepane` works from inside this repo too (npm marks
// bins executable on install, but the workspace link points at this file).
await chmod(outfile, 0o755);
await mkdir(path.dirname(pluginCopy), { recursive: true });
await copyFile(outfile, pluginCopy);
await chmod(pluginCopy, 0o755);
console.log(`built ${path.relative(process.cwd(), outfile)} and ${path.relative(process.cwd(), pluginCopy)}`);
