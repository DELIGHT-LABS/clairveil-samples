import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

import {
  clairveilJSScriptEnvironment,
  linkConfiguredClairveilJS,
  resolveClairveilJSDirectory
} from "../tools/clairveiljs-worktree.mjs";

async function fakeSdk(directory, version = "0.3.1") {
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "package.json"), JSON.stringify({
    name: "clairveiljs",
    version
  }));
}

test("ClairveilJS worktree selection is environment-driven and replaces symlinks only", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "clairveil-web-sdk-link-"));
  try {
    const dappDirectory = resolve(root, "repo");
    const defaultSdk = resolve(root, "clairveiljs");
    const selectedSdk = resolve(root, "clairveiljs-evm-v0.3.1");
    const dependencyPath = resolve(dappDirectory, "node_modules/clairveiljs");
    await fakeSdk(defaultSdk);
    await fakeSdk(selectedSdk);
    await mkdir(dirname(dependencyPath), { recursive: true });
    await symlink(relative(dirname(dependencyPath), defaultSdk), dependencyPath, "dir");

    const environment = { CLAIRVEILJS_DIR: selectedSdk };
    assert.equal(
      resolveClairveilJSDirectory({ environment, dappDirectory }),
      selectedSdk
    );
    assert.equal(
      await linkConfiguredClairveilJS({ environment, dappDirectory }),
      await realpath(selectedSdk)
    );
    assert.equal(await realpath(dependencyPath), await realpath(selectedSdk));
    assert.equal(JSON.parse(await readFile(resolve(dependencyPath, "package.json"))).version, "0.3.1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ClairveilJS worktree selection refuses a non-symlink dependency directory", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "clairveil-web-sdk-link-"));
  try {
    const dappDirectory = resolve(root, "repo");
    const selectedSdk = resolve(root, "clairveiljs-evm-v0.3.1");
    await fakeSdk(selectedSdk);
    await mkdir(resolve(dappDirectory, "node_modules/clairveiljs"), { recursive: true });

    await assert.rejects(
      () => linkConfiguredClairveilJS({
        environment: { CLAIRVEILJS_DIR: selectedSdk },
        dappDirectory
      }),
      /not a symbolic link; refusing to replace/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required conformance and SDK release scripts remove fixture overrides", () => {
  const dappDirectory = "/tmp/clairveil-samples";
  const required = clairveilJSScriptEnvironment("test:conformance:required", {
    environment: {
      KEEP: "yes",
      CLAIRVEIL_CONFORMANCE_FIXTURE_DIR: "/explicit",
      CLAIRVEIL_WALLET_CONTRACT_SCHEMA: "/wallet-schema.json",
      CLAIRVEIL_PROVER_CONFORMANCE_FIXTURE_DIR: "/prover-fixtures",
      CLAIRVEIL_PROVER_HTTP_API_SCHEMA: "/prover-schema.json"
    },
    dappDirectory
  });
  assert.deepEqual(required, { KEEP: "yes" });

  const development = clairveilJSScriptEnvironment("test:conformance", {
    environment: { KEEP: "yes" },
    dappDirectory
  });
  assert.deepEqual(development, { KEEP: "yes" });
  assert.deepEqual(
    clairveilJSScriptEnvironment("test:conformance", {
      environment: {
        KEEP: "yes",
        CLAIRVEIL_CONFORMANCE_FIXTURE_DIR: "/diagnostic-fixtures"
      },
      dappDirectory
    }),
    {
      KEEP: "yes",
      CLAIRVEIL_CONFORMANCE_FIXTURE_DIR: "/diagnostic-fixtures"
    }
  );

  for (const script of ["verify:release", "verify:release:integration", "prepublishOnly"]) {
    assert.deepEqual(
      clairveilJSScriptEnvironment(script, {
        environment: {
          KEEP: "yes",
          CLAIRVEIL_CONFORMANCE_FIXTURE_DIR: "/explicit",
          CLAIRVEIL_WALLET_CONTRACT_SCHEMA: "/wallet-schema.json",
          CLAIRVEIL_PROVER_CONFORMANCE_FIXTURE_DIR: "/prover-fixtures",
          CLAIRVEIL_PROVER_HTTP_API_SCHEMA: "/prover-schema.json"
        },
        dappDirectory
      }),
      { KEEP: "yes" },
      `${script} must use the SDK's bundled release fixtures`
    );
  }
});

test("release verification uses the SDK's bundled exact-source contracts", async () => {
  const packageMetadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageMetadata.scripts["test:release-contracts"],
    "node tools/clairveiljs-worktree.mjs run verify:clairveil-source && node tools/clairveiljs-worktree.mjs run test:conformance:required"
  );
  assert.match(
    packageMetadata.scripts["verify:production-deployment"],
    /^npm run link:clairveiljs && node tools\/verify-production-deployment\.mjs$/
  );
});
