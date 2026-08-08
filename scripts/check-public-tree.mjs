import { execFileSync } from "node:child_process";

const tracked = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
}).split("\0").filter(Boolean);

const forbiddenFiles = new Set([
  "AGENTS.md",
  "start-spec.md",
  "docs/launch-plan.md",
  "docs/research/2026-08-next-features.md",
]);

const violations = tracked.filter((path) =>
  path === "private" ||
  path.startsWith("private/") ||
  forbiddenFiles.has(path)
);

if (violations.length > 0) {
  console.error("Internal files are tracked and must not be published:");
  for (const path of violations) console.error(`- ${path}`);
  process.exit(1);
}

console.log("Public-tree check passed: no internal paths are tracked.");
