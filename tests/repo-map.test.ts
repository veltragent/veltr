import test from "node:test";
import assert from "node:assert/strict";

import { classifyPath, classifyPaths, detectStack, isIgnored, resolvePath } from "../lib/repo-map";

/**
 * Repository intelligence.
 *
 * The fixture is this repository's own layout, so the assertions describe a real
 * project rather than an idealised one.
 */
const VELTR_PATHS = [
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  ".env.example",
  "README.md",
  "instrumentation.ts",
  "app/layout.tsx",
  "app/page.tsx",
  "app/api/agent/route.ts",
  "app/api/mission/route.ts",
  "app/api/telegram/sync/route.ts",
  "components/radar-table.tsx",
  "components/primitives.tsx",
  "lib/telegram.ts",
  "lib/agent-loop.ts",
  "lib/tools.ts",
  "lib/store.ts",
  "lib/chain.ts",
  "lib/agent/mission.ts",
  "lib/watch/engine.ts",
  "tests/agent-core.test.ts",
  "node_modules/next/dist/index.js",
  "package-lock.json",
  ".next/static/chunk.js",
  "public/favicon.ico",
];

test("build output and binaries are ignored", () => {
  assert.equal(isIgnored("node_modules/next/dist/index.js"), true);
  assert.equal(isIgnored("package-lock.json"), true);
  assert.equal(isIgnored(".next/static/chunk.js"), true);
  assert.equal(isIgnored("public/favicon.ico"), true);
  assert.equal(isIgnored("lib/telegram.ts"), false);
});

test("files land in the bucket someone would look for them in", () => {
  assert.equal(classifyPath("package.json"), "config");
  assert.equal(classifyPath("next.config.ts"), "config");
  assert.equal(classifyPath("app/api/agent/route.ts"), "api");
  assert.equal(classifyPath("components/radar-table.tsx"), "ui");
  assert.equal(classifyPath("lib/telegram.ts"), "services");
  assert.equal(classifyPath("tests/agent-core.test.ts"), "tests");
  assert.equal(classifyPath("README.md"), "docs");
  assert.equal(classifyPath("prisma/schema.prisma"), "data");
});

test("auth outranks the directory it happens to sit in", () => {
  // "where is authentication handled" must find these, and both would otherwise
  // be swallowed by the api and services buckets.
  assert.equal(classifyPath("app/api/auth/[...nextauth]/route.ts"), "auth");
  assert.equal(classifyPath("lib/session.ts"), "auth");
  assert.equal(classifyPath("src/middleware.ts"), "auth");
  assert.equal(classifyPath("internal/jwt/verify.go"), "auth");
});

test("entry points are found and barrel files are not mistaken for them", () => {
  const { entryPoints } = classifyPaths([
    ...VELTR_PATHS,
    "src/lib/widgets/internal/deep/index.ts",
  ]);

  assert.ok(entryPoints.includes("instrumentation.ts"));
  assert.ok(entryPoints.includes("app/page.tsx"));
  assert.ok(
    !entryPoints.includes("src/lib/widgets/internal/deep/index.ts"),
    "depth is the signal that separates an entry point from a barrel"
  );
});

test("classification reports what it skipped", () => {
  const { considered, ignored, buckets } = classifyPaths(VELTR_PATHS);

  assert.equal(ignored, 4);
  assert.equal(considered, VELTR_PATHS.length - 4);
  assert.ok(buckets.api.includes("app/api/mission/route.ts"));
  assert.ok(!buckets.services.includes("node_modules/next/dist/index.js"));
});

test("the stack is read from the files that declare it", () => {
  const veltr = detectStack(VELTR_PATHS);
  assert.equal(veltr.type, "javascript/typescript");
  assert.ok(veltr.markers.includes("next.js"));

  assert.equal(detectStack(["go.mod", "cmd/server/main.go"]).type, "go");
  assert.equal(detectStack(["pyproject.toml", "app/main.py"]).type, "python");
  assert.equal(detectStack(["Cargo.toml", "src/main.rs"]).type, "rust");
  assert.equal(detectStack(["index.html"]).type, "unknown");
});

/* ------------------------------------------------------ Path recovery */

test("an exact path is returned unchanged", () => {
  assert.equal(resolvePath("lib/telegram.ts", VELTR_PATHS), "lib/telegram.ts");
});

test("a wrong directory is corrected by filename", () => {
  // The classic model guess: right file, invented folder.
  assert.equal(resolvePath("src/telegram.ts", VELTR_PATHS), "lib/telegram.ts");
  assert.equal(resolvePath("app/store.ts", VELTR_PATHS), "lib/store.ts");
});

test("the shallowest match wins when a name repeats", () => {
  const paths = ["index.ts", "src/deep/nested/index.ts"];
  assert.equal(resolvePath("index.ts", paths), "index.ts");
});

test("a wrong extension resolves to the file that exists", () => {
  assert.equal(resolvePath("app/page.ts", VELTR_PATHS), "app/page.tsx");
});

test("a leading slash or dot does not defeat resolution", () => {
  assert.equal(resolvePath("./lib/store.ts", VELTR_PATHS), "lib/store.ts");
  assert.equal(resolvePath("/lib/store.ts", VELTR_PATHS), "lib/store.ts");
});

test("a genuinely absent file resolves to nothing rather than to something close", () => {
  assert.equal(resolvePath("lib/payments.ts", VELTR_PATHS), null);
  assert.equal(resolvePath("", VELTR_PATHS), null);
  assert.equal(resolvePath("lib/store.ts", []), null);
});

test("a short stem does not match half the repository", () => {
  // "a.ts" must not resolve to "app/api/agent/route.ts" by loose stem matching.
  assert.equal(resolvePath("a.ts", VELTR_PATHS), null);
});
