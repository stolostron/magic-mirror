import fs from "fs";
import path from "path";

import simpleGit from "simple-git";
import tmp from "tmp";

/**
 * Apply the input Git patches and push the changes.
 * @param {string} remoteURL the Git URL to clone from and push to. It should include any required authentication.
 * @param {string} sourceBranch the branch to use as a base for applying the patches.
 * @param {string} targetBranch the branch to push applied patches to.
 * @param {Array<string>} patches the array of Git patch strings to apply.
 * @return {Promise<boolean>} a promise that resolves to a boolean determining if the patches actually affected the Git
 *   history and were pushed. This will be false if the patches are diffs that are already applied on the target branch.
 *   This rejects when there is a Git error such as a patch not applying.
 */
export async function applyPatches(
  remoteURL: string,
  sourceBranch: string,
  targetBranch: string,
  patches: Array<string>,
): Promise<boolean> {
  if (!patches.length) {
    throw new Error("One or more patches are required");
  }

  const dirObj = tmp.dirSync({ keep: true, unsafeCleanup: true });
  try {
    const patchFiles: Array<string> = [];
    patches.map((patch, i) => {
      if (patch) {
        const patchPath = path.join(dirObj.name, `patch${i + 1}.patch`);
        fs.writeFileSync(patchPath, patches[i]);
        patchFiles.push(patchPath);
      }
    });

    const gitPath = path.join(dirObj.name, "repo");
    fs.mkdirSync(gitPath);
    // These method calls, when chained together, will run serially. Any failure will cause
    // the chain to stop.
    const git = simpleGit(gitPath);
    await git.clone(remoteURL, gitPath).checkoutBranch(targetBranch, `origin/${sourceBranch}`);

    const originalHead = await git.revparse(["HEAD"]);

    await Promise.all(patchFiles.map((patchFile) => git.raw(["am", "-3", patchFile])));

    const newHead = await git.revparse(["HEAD"]);
    if (originalHead === newHead) {
      return false;
    }

    await git.push(["origin", "HEAD"]);

    return true;
  } finally {
    dirObj.removeCallback();
  }
}
