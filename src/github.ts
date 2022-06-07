import { Octokit } from "@octokit/rest";

/**
 * Create a GitHub issue indicating that sync from upstream failed.
 * @param {Octokit} client the GitHub client to use that is authenticated as the GitHub installation.
 * @param {string} org the GitHub organization where the issue is to be created.
 * @param {string} repo the GitHub repository where the issue is to be created.
 * @param {string} upstreamOrg the upstream GitHub organization that sync was from.
 * @param {string} branch the forked repository's branch that had the failed sync.
 * @param {Array<number>} upstreamPRIDs the upstream pull-request IDs that were part of the failed sync.
 * @param {string} reason the reason that the sync failed.
 * @param {number} prID an optional pull-request ID of the forked repository's sync PR. This isn't set if the PR
 *   couldn't be created due to something like a merge conflict.
 * @return {Promise<number>} a Promise that resolves to the created GitHub issue ID.
 */
export async function createFailureIssue(
  client: Octokit,
  org: string,
  repo: string,
  upstreamOrg: string,
  branch: string,
  upstreamPRIDs: Array<number>,
  reason: string,
  prID?: number,
): Promise<number> {
  const title = `😿 Failed to sync the upstream PRs: #${upstreamPRIDs.join(", #")}`;
  const prPrefix = `\n* ${upstreamOrg}/${repo}#`;
  let body =
    `🪞 Magic Mirror 🪞 failed to sync the following upstream pull-requests because ${reason}:` +
    `${prPrefix}${upstreamPRIDs.join(prPrefix)}\n\n` +
    `Syncing is paused for the branch ${branch} on ${org}/${repo} until the issue is manually resolved and this ` +
    "issue is closed.\n\n" +
    "![sad Yoda](https://media.giphy.com/media/3o7qDK5J5Uerg3atJ6/giphy.gif)";

  if (prID) {
    body += `\n\nThe pull-request (#${prID}) can reviewed for more information.`;
  }

  const resp = await client.issues.create({ owner: org, repo: repo, title: title, body: body });
  return resp.data.number;
}
