/**
 * Runtime-load check: load the extension the way pi actually loads it.
 *
 * pi loads extension .ts files through jiti with a FIXED alias map - only the
 * pi-ai root (mapped to dist/compat.js), /compat, /oauth, /providers/all,
 * and the roots of the other pi packages. An installed extension has no
 * node_modules next to it, so any import outside that map resolves in the dev
 * repo (bun installs peer deps) but fails at user startup. 0.3.0 shipped that
 * bug with green CI and typecheck; this check reproduces the real loader so
 * it cannot happen again.
 *
 * Run: node scripts/runtime-load-check.mjs   (exits non-zero on failure)
 */

import { createJiti } from "jiti";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ai = fileURLToPath(new URL("../node_modules/@earendil-works/pi-ai/", import.meta.url));
const ca = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/", import.meta.url));

for (const entry of [
  `${ai}dist/compat.js`,
  `${ai}dist/providers/all.js`,
  `${ai}dist/oauth.js`,
  `${ca}dist/index.js`,
]) {
  if (!existsSync(entry)) {
    console.error(`runtime-load-check: missing ${entry} - run bun install first`);
    process.exit(1);
  }
}

// The alias map mirrors pi 1.2.0's core/extensions/loader.js.
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-ai/providers/all": `${ai}dist/providers/all.js`,
    "@earendil-works/pi-ai/compat": `${ai}dist/compat.js`,
    "@earendil-works/pi-ai/oauth": `${ai}dist/oauth.js`,
    "@earendil-works/pi-ai": `${ai}dist/compat.js`,
    "@earendil-works/pi-coding-agent": `${ca}dist/index.js`,
  },
});

try {
  const mod = await jiti.import(new URL("../extensions/index.ts", import.meta.url).pathname);
  if (typeof mod.default !== "function") {
    console.error("runtime-load-check: FAIL - default export is not a factory function");
    process.exit(1);
  }
  console.log("runtime-load-check: OK - extension loads through pi's alias map");
} catch (e) {
  console.error(`runtime-load-check: FAIL - ${String(e.message).split("\n")[0]}`);
  console.error(
    "An import above the pi alias map? Installed extensions resolve @earendil-works/* only through pi's aliases - check core/extensions/loader.js in pi-coding-agent."
  );
  process.exit(1);
}
