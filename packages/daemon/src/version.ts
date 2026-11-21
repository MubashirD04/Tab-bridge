// Replaced at bundle time by build.mjs (esbuild `define`). The fallbacks
// apply when running from source, e.g. under vitest.
declare const __SHAREPANE_VERSION__: string | undefined;
declare const __SHAREPANE_PACKAGE__: string | undefined;

export const VERSION: string = typeof __SHAREPANE_VERSION__ === "string" ? __SHAREPANE_VERSION__ : "0.0.0-dev";

/** The npm package name, used in the commands we print (`npx <name> setup`).
 * The command itself is always `sharepane`. */
export const PACKAGE_NAME: string =
  typeof __SHAREPANE_PACKAGE__ === "string" ? __SHAREPANE_PACKAGE__ : "sharepane";
