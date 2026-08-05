import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const packagePath = path.join(workspaceRoot, "packages", "ticketing", "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));

if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  throw new Error(`No package version was found in ${packagePath}.`);
}

const suppliedTag = process.argv[2];
const tag = suppliedTag ?? process.env.GITHUB_REF_NAME;
const expectedTag = `v${packageJson.version}`;

if (!tag) {
  throw new Error(
    "No release tag was provided. Pass it as an argument or set GITHUB_REF_NAME.",
  );
}

if (!suppliedTag && process.env.GITHUB_REF_TYPE && process.env.GITHUB_REF_TYPE !== "tag") {
  throw new Error(`Release verification requires a tag ref, received ${process.env.GITHUB_REF_TYPE}.`);
}

if (tag !== expectedTag) {
  throw new Error(`Release tag ${tag} does not match package version ${expectedTag}.`);
}

console.log(`Verified release tag ${tag} for @quanby/ticketing@${packageJson.version}.`);
