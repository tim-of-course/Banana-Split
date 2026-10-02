import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("distribution/plugins/banana-split-v1/.codex-plugin/plugin.json", "utf8"));
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("package.json must contain a release version such as 0.1.0 or 0.5.0-beta.1");
}
if (manifest.version.split("+")[0] !== version) {
  throw new Error("Plugin manifest release version must match package.json before packaging");
}

const output = resolve("dist/releases");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const checksums: string[] = [];
for (const target of ["bun-windows-x64", "bun-darwin-arm64", "bun-darwin-x64"]) {
  run([process.execPath, "scripts/build.ts", target]);
  const filename = `banana-split-${version}-${target.slice(4)}.tar.gz`;
  const archive = resolve(output, filename);
  // Archive the platform directory itself: includes hidden marketplace metadata
  // and preserves the executable bit when downloaded through Actions artifacts.
  run(["tar", "-czf", archive, "-C", resolve("dist"), target]);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  checksums.push(`${digest}  ${filename}`);
}
writeFileSync(resolve(output, "SHA256SUMS"), checksums.join("\n") + "\n");
console.log(`Release archives and SHA256SUMS: ${output}\nCross-compilation does not verify live Windows or macOS workflows.`);

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`);
}
