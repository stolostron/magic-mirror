import fs from "fs";
import path from "path";

import simpleGit, { Response } from "simple-git";
import tmp from "tmp";

/**
 * Apply the input Git patches and push the changes.
 * @param {string} remoteURL the Git URL to clone from and push to. It should include any required authentication.
 * @param {string} sourceBranch the branch to use as a base for applying the patches.
 * @param {string} targetBranch the branch to push applied patches to.
 * @param {Array<string>} patches the array of Git patch strings to apply.
 * @return {Promise<void>} a promise that resolves to nothing and rejects when there is a Git error such as a patch
 *   not applying.
 */
export async function applyPatches(
  remoteURL: string,
  sourceBranch: string,
  targetBranch: string,
  patches: Array<string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const dirObj = tmp.dirSync({ keep: true, unsafeCleanup: true });
    const patchFiles: Array<string> = [];

    try {
      patches.map((patch, i) => {
        if (patch) {
          const patchPath = path.join(dirObj.name, `patch${i + 1}.patch`);
          fs.writeFileSync(patchPath, patches[i]);
          patchFiles.push(patchPath);
        }
      });
    } catch (err) /* istanbul ignore next */ {
      dirObj.removeCallback();
      reject(err);
      return;
    }

    const gitPath = path.join(dirObj.name, "repo");
    try {
      fs.mkdirSync(gitPath);
    } catch (err) /* istanbul ignore next */ {
      dirObj.removeCallback();
      reject(err);
      return;
    }

    // These method calls, when chained together, will run serially. Any failure will cause
    // the chain to stop and make it jump to the catch callback.
    let gitCmds: Response<any> = simpleGit(gitPath)
      .clone(remoteURL, gitPath)
      .checkoutBranch(targetBranch, `origin/${sourceBranch}`);

    for (const patchFile of patchFiles) {
      gitCmds = gitCmds.raw(["am", "-3", patchFile]);
    }

    gitCmds
      .push(["origin", "HEAD"])
      .then(() => {
        dirObj.removeCallback();
        resolve();
      })
      .catch((err) => {
        dirObj.removeCallback();
        reject(err);
      });
  });
}
