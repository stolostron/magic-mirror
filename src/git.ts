import fs from "fs";
import path from "path";

import simpleGit from "simple-git";
import tmp from "tmp";

// patchLocation represents the head (commit hash of the start of the patch) and the number of commits as part of the
// patch.
export type patchLocation = {
  head: string;
  numCommits: number;
};

/**
 * Apply the input Git patches using `git cherry-pick` and push the changes.
 * @param {string} remoteURL the Git URL to clone from and push to. It should include any required authentication.
 * @param {string} upstreamRemoteURL the upstream Git URL to the repo to cherry-pick from.
 * @param {string} sourceBranch the branch to use as a base for applying the patches.
 * @param {string} targetBranch the branch to push applied patches to.
 * @param {Array<patchLocation>} patchLocations the array of patch locations (i.e. patch commit HEAD and number of
 *   commits) to apply.
 * @return {Promise<void>} a promise that resolves to nothing.
 */
export async function applyPatches(
  remoteURL: string,
  upstreamRemoteURL: string,
  sourceBranch: string,
  targetBranch: string,
  patchLocations: Array<patchLocation>,
) {
  if (!patchLocations.length) {
    throw new Error("One or more patches are required");
  }

  const dirObj = tmp.dirSync({ keep: true, unsafeCleanup: true });
  try {
    // These method calls, when chained together, will run serially. Any failure will cause
    // the chain to stop.
    const git = simpleGit(dirObj.name);
    await git
      .clone(remoteURL, dirObj.name)
      .checkoutBranch(targetBranch, `origin/${sourceBranch}`)
      .remote(["add", "upstream", upstreamRemoteURL])
      .fetch(["upstream", "--prune"]);

    await Promise.all(
      patchLocations.map((p) =>
        git.raw([
          "cherry-pick",
          "-x",
          `${p.head}~${p.numCommits}..${p.head}`,
          "--allow-empty",
          "--keep-redundant-commits",
        ]),
      ),
    );

    await git.push(["origin", "HEAD"]);
  } finally {
    dirObj.removeCallback();
  }
}
