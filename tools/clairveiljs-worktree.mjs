import { spawn } from "node:child_process";
import {
  lstat,
  readFile,
  realpath,
  symlink,
  unlink
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
export const defaultDappDirectory = resolve(toolDirectory, "..");

function withoutConformanceFixtureOverride(environment) {
  const childEnvironment = { ...environment };
  for (const name of [
    "CLAIRVEIL_CONFORMANCE_FIXTURE_DIR",
    "CLAIRVEIL_WALLET_CONTRACT_SCHEMA",
    "CLAIRVEIL_PROVER_CONFORMANCE_FIXTURE_DIR",
    "CLAIRVEIL_PROVER_HTTP_API_SCHEMA"
  ]) {
    delete childEnvironment[name];
  }
  return childEnvironment;
}

export function resolveClairveilJSDirectory({
  environment = process.env,
  dappDirectory = defaultDappDirectory
} = {}) {
  const configured = String(environment.CLAIRVEILJS_DIR || "").trim();
  if (!configured) return resolve(dappDirectory, "../clairveiljs");
  return isAbsolute(configured) ? resolve(configured) : resolve(dappDirectory, configured);
}

async function validatedClairveilJSDirectory(options = {}) {
  const sdkDirectory = resolveClairveilJSDirectory(options);
  let packageMetadata;
  try {
    packageMetadata = JSON.parse(await readFile(resolve(sdkDirectory, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`CLAIRVEILJS_DIR does not contain a readable package.json: ${sdkDirectory}`, {
      cause: error
    });
  }
  if (packageMetadata?.name !== "clairveiljs" || packageMetadata?.version !== "0.3.1") {
    throw new Error(
      `CLAIRVEILJS_DIR must contain clairveiljs v0.3.1, got ${packageMetadata?.name || "unknown"}@${packageMetadata?.version || "unknown"}`
    );
  }
  return realpath(sdkDirectory);
}

export async function linkConfiguredClairveilJS({
  environment = process.env,
  dappDirectory = defaultDappDirectory
} = {}) {
  const sdkDirectory = await validatedClairveilJSDirectory({ environment, dappDirectory });
  const dependencyPath = resolve(dappDirectory, "node_modules/clairveiljs");
  let dependencyStat;
  try {
    dependencyStat = await lstat(dependencyPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (dependencyStat && !dependencyStat.isSymbolicLink()) {
    throw new Error(
      `${dependencyPath} is not a symbolic link; refusing to replace it. Run npm ci before selecting CLAIRVEILJS_DIR.`
    );
  }
  if (dependencyStat) {
    let linkedDirectory = "";
    try {
      linkedDirectory = await realpath(dependencyPath);
    } catch {
      // A broken SDK symlink is safe to replace after lstat proved that only the
      // link itself, rather than a dependency directory, will be removed.
    }
    if (linkedDirectory === sdkDirectory) return sdkDirectory;
    await unlink(dependencyPath);
  }

  // node_modules is generated state, so an absolute link is preferable here:
  // it also avoids macOS /var -> /private/var path aliasing producing a broken
  // relative target. No absolute path is written to source or the lockfile.
  await symlink(sdkDirectory, dependencyPath, "dir");
  const linkedDirectory = await realpath(dependencyPath);
  if (linkedDirectory !== sdkDirectory) {
    throw new Error(`failed to link ClairveilJS worktree: expected ${sdkDirectory}, got ${linkedDirectory}`);
  }
  return sdkDirectory;
}

export async function runClairveilJSScript(script, args = [], {
  environment = process.env,
  dappDirectory = defaultDappDirectory
} = {}) {
  if (!script) throw new Error("ClairveilJS npm script name is required");
  const sdkDirectory = await validatedClairveilJSDirectory({ environment, dappDirectory });
  const childEnvironment = clairveilJSScriptEnvironment(script, {
    environment,
    dappDirectory
  });
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCommand, ["run", script, ...args], {
    cwd: sdkDirectory,
    stdio: "inherit",
    env: childEnvironment
  });
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`ClairveilJS npm script ${script} terminated by ${signal}`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

export function clairveilJSScriptEnvironment(script, {
  environment = process.env
} = {}) {
  const usesBundledReleaseFixtures = script === "test:conformance:required" ||
    script === "verify:release" ||
    script === "verify:release:integration" ||
    script === "prepublishOnly";
  return usesBundledReleaseFixtures
    ? withoutConformanceFixtureOverride(environment)
    : { ...environment };
}

async function main() {
  const [command, script, ...args] = process.argv.slice(2);
  if (command === "link") {
    const linked = await linkConfiguredClairveilJS();
    process.stdout.write(`ClairveilJS worktree: ${linked}\n`);
    return;
  }
  if (command === "run") {
    process.exitCode = await runClairveilJSScript(script, args);
    return;
  }
  throw new Error("usage: clairveiljs-worktree.mjs <link|run SCRIPT [ARGS...]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
