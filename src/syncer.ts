import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import winston from "winston";

import { Config } from "./config";
import { Database, PendingPR, PRAction, Repo } from "./db";
import { applyPatches, patchLocation } from "./git";
import { createFailureIssue, getRequiredChecks, mergePR } from "./github";
import { newLogger } from "./log";

/**
 * Syncer is the backend of Magic Mirror, which monitors upstream and creates PRs on forks.
 */
export class Syncer {
  // appClient is the GitHub client authenticated as the GitHub app itself.
  private appClient?: Octokit;
  // config is the user provided configuration.
  private config: Config;
  // db is the database used to keep track of actions the bot has taken.
  private db?: Database;
  // logger is a Winston logger that logs to the console.
  private logger: winston.Logger;
  // orgs is an object where the keys are GitHub organizations and each value has the associated GitHub client
  // authenticated as the GitHub app installation, the GitHub app installation ID, and the repo names that the GitHub
  // app is installed on.
  private orgs: { [key: string]: { client?: Octokit; installationID?: number; repos?: Set<string> } };
  // upstreamOrgRepos is an object where the keys are upstream organizations that are configured
  // to be monitored and the values are sets of the repo names that are publicly accessible.
  private upstreamOrgRepos: { [key: string]: Set<string> } = {};

  /**
   * Instantiate a Syncer object.
   *
   * @param {Config} config the configuration object of the Syncer.
   */
  constructor(config: Config) {
    this.config = config;
    this.logger = newLogger(config.logLevel);
    this.orgs = {};
  }

  /**
   * Close a pull-request (PR) created by the GitHub app.
   * @param {Octokit} client the GitHub client to use that is authenticated as the GitHub installation.
   * @param {string} org the GitHub organization where the PR exists.
   * @param {string} repo the GitHub repository where the PR exists.
   * @param {number} prID the ID of the PR to close.
   * @return {Promise<bool>} a Promise that resolves to a boolean representing if the PR was closed. This is false if
   *   the PR was closed before the function was called, which can happen if the webhook receiver merged the PR and
   *   hadn't updated the database yet.
   */
  private async closePR(client: Octokit, org: string, repo: string, prID: number): Promise<boolean> {
    // Check if the PR is already closed first
    const pr = await client.pulls.get({ owner: org, repo: repo, pull_number: prID });
    if (pr.data.state === "closed") {
      return false;
    }

    await client.issues.createComment({
      owner: org,
      repo: repo,
      issue_number: prID,
      body:
        "Closing this in favor of a new PR with additional commits.\n\n" +
        '<img src="https://media.giphy.com/media/7yojoQtevjOCI/giphy.gif" width=350px>',
    });

    await client.pulls.update({ owner: org, repo: repo, pull_number: prID, state: "closed" });

    return true;
  }

  /**
   * Get a GitHub client authenticated as the GitHub app and optionally a specific installation.
   * @param {number} installationID the optional GitHub app installation ID to authenticate as. If this is not set,
   *   the client is only authenticated as the GitHub app.
   * @return {Octokit} the authenticated GitHub client.
   */
  private getGitHubClient(installationID?: number): Octokit {
    const auth: any = {
      appId: this.config.appID,
      privateKey: this.config.privateKey,
    };

    if (installationID) {
      auth.installationId = installationID;
    }

    return new Octokit({ authStrategy: createAppAuth, auth: auth });
  }

  /**
   * Get the latest merged PR on any branch.
   * @param {Octokit} client the GitHub client to use that is authenticated as the GitHub installation.
   * @param {string} org the GitHub organization to search.
   * @param {string} repo the GitHub repository to search.
   * @return {Promise<number | null>} a Promise that resolves to the latest PR ID or null if there are no PRs yet.
   */
  private async getLatestPRID(client: Octokit, org: string, repo: string): Promise<number | null> {
    // Can't use pulls.list since you can't filter on if the PR is merged
    const resp = await client.rest.search.issuesAndPullRequests({
      q: `repo:${org}/${repo}+is:pr+is:merged`,
      per_page: 1,
      sort: "created",
      order: "desc",
    });
    if (resp.data.items.length) {
      return resp.data.items[0].number;
    }

    return null;
  }

  /**
   * Get the merged PR IDs since the last handled PR.
   * @param {Octokit} client the GitHub client to use that is authenticated as the GitHub installation.
   * @param {string} org the GitHub organization to search.
   * @param {string} repo the GitHub repository to search.
   * @param {number} lastHandledPR the PR ID to search from.
   * @return {Promise<Array<number>>} a Promise that resolves to an array of PR IDs in ascending order.
   */
  private async getMergedPRIDs(
    client: Octokit,
    org: string,
    repo: string,
    lastHandledPR: number,
  ): Promise<Array<number>> {
    const prIDs = new Set<number>();

    const convertSetToArray = () => {
      // Sort is alphabetical by default, which is why a custom sort function is required.
      return Array.from(prIDs).sort((a, b) => a - b);
    };

    let page = 1;

    while (true) {
      const resp = await client.rest.search.issuesAndPullRequests({
        q: `repo:${org}/${repo}+is:pr+is:merged`,
        page: page,
        per_page: 10,
        sort: "created",
        order: "desc",
      });

      if (!resp.data.items.length) {
        return convertSetToArray();
      }

      for (const pr of resp.data.items) {
        if (pr.number <= lastHandledPR) {
          return convertSetToArray();
        }

        prIDs.add(pr.number);
      }

      page++;
    }
  }

  /**
   * Get the PR patch locations for input in the applyPatches function.
   * @param {Octokit} client the GitHub client to use that is authenticated as the GitHub installation.
   * @param {string} org the GitHub organization where the PR is located.
   * @param {string} repo the GitHub repository where the PR is located.
   * @param {Array<number>} prIDs the PR IDs to get the patch locations from.
   * @return {Promise<Array<patchLocation>>} a Promise that resolves to an array of patchLocation objects.
   */
  private async getPRPatchLocations(
    client: Octokit,
    org: string,
    repo: string,
    prIDs: Array<number>,
  ): Promise<Array<patchLocation>> {
    const rv: Array<patchLocation> = [];

    const prs = await Promise.all(prIDs.map((prID) => client.pulls.get({ owner: org, pull_number: prID, repo: repo })));
    prs.forEach((pr, i) => {
      rv.push({ head: pr.data.merge_commit_sha as string, numCommits: pr.data.commits });
    });

    return rv;
  }

  /**
   * Get the mapping of target branches to their respective PRs.
   * @param {Octokit} client the GitHub client to use that is authenticated as the GitHub installation.
   * @param {string} org the GitHub organization where the PRs are located.
   * @param {string} repo the GitHub repository where the PRs are located.
   * @param {Array<number>} prIDs the PR IDs to get target branches for.
   * @return {Promise<object>} a Promise that resolves to an object where the keys are target branches and the values
   *   are the respective PR IDs.
   */
  private async getBranchToPRIDs(
    client: Octokit,
    org: string,
    repo: string,
    prIDs: Array<number>,
  ): Promise<{ [key: string]: Array<number> }> {
    const rv: { [key: string]: Array<number> } = {};
    const prs = await Promise.all(prIDs.map((prID) => client.pulls.get({ owner: org, repo: repo, pull_number: prID })));
    prs.forEach((pr, i) => {
      if (!rv[pr.data.base.ref]) {
        rv[pr.data.base.ref] = [];
      }
      rv[pr.data.base.ref].push(prIDs[i]);
    });

    return rv;
  }

  /**
   * Get a token authenticated as a Github app installation.
   *
   * This is useful if you need perform an authenticated action outside of the GitHub Octokit client.
   * @param {string} org the GitHub organization of the GitHub app installation.
   * @return {Promise<string>} a Promise that resolves to a token authenticated as a Github app installation.
   */
  private async getToken(org: string): Promise<string> {
    const auth = createAppAuth({
      appId: this.config.appID,
      privateKey: this.config.privateKey,
    });

    // Retrieve installation access token
    const token = await auth({
      type: "installation",
      installationId: this.orgs[org] && this.orgs[org].installationID,
    });

    return token.token;
  }

  /**
   * Get the upstream GitHub repositories that are publicly accessible.
   *
   * This populates this.upstreamOrgRepos.
   */
  private async getUpstreamRepos() {
    for (const installationOrg in this.config.upstreamMappings) {
      // Must use the installation client in order to have access to public repos in the API. The app client does
      // not allow this.
      if (!this.orgs[installationOrg] || !this.orgs[installationOrg].client) {
        throw new Error(`The upstreamOrgs mapping specifies the org ${installationOrg} which is not installed`);
      }

      for (const org in this.config.upstreamMappings[installationOrg]) {
        if (!this.upstreamOrgRepos[org]) {
          this.upstreamOrgRepos[org] = new Set<string>();
        }

        let resp = await this.orgs[installationOrg].client?.repos
          .listForOrg({ org: org, type: "public" })
          .catch((err) => {
            if (err.status === 404) {
              this.logger.debug(`Could not find the org ${org}, assuming it's a user`);
              return;
            }

            throw err;
          });

        if (!resp?.data) {
          resp = await this.orgs[installationOrg].client?.repos.listForUser({ username: org });

          if (!resp?.data) {
            continue;
          }
        }

        for (const repo of resp.data) {
          this.upstreamOrgRepos[org].add(repo.name);
        }
      }
    }
  }

  /**
   * Sync a forked repository's branch with upstream.
   *
   * This checks for new upstream PRs and creates the appropriate pull-requests (PRs) on the fork. If one or more
   * upstream PRs don't apply on the forked repository's branch (i.e. merge conflicts), a GitHub issue is created on the
   * forked repository. No further action will be taken for this forked repository's branch until the GitHub issue is
   * closed, signaling that the issue was manually resolved.
   * @param {string} org the GitHub organization of the forked repository.
   * @param {string} upstreamOrg the GitHub organization of the upstream repository.
   * @param {string} repoName the GitHub repository of the forked/upstream repository.
   * @param {string} branch the branch of the forked repository.
   * @param {string} upstreamBranch the branch of the upstream repository.
   * @param {Array<string>} prLabels the optional labels to add to created PRs.
   */
  private async handleForkedBranch(
    org: string,
    upstreamOrg: string,
    repoName: string,
    branch: string,
    upstreamBranch: string,
    prLabels?: Array<string>,
  ) {
    this.logger.info(`Handling the branch "${branch}" on ${org}/${repoName}`);

    const repo = (await this.db?.getOrCreateRepo(org, repoName)) as Repo;
    const upstreamRepo = (await this.db?.getOrCreateRepo(upstreamOrg, repoName)) as Repo;

    const pendingPR = await this.db?.getPendingPR(repo, upstreamRepo, branch);
    if (pendingPR && pendingPR.action == PRAction.Blocked) {
      this.logger.info(`The "${branch}" branch on ${org}/${repoName} is blocked. Skipping for now.`);
      return;
    }

    const client = this.orgs[org].client as Octokit;
    const lastHandledPR = await this.db?.getLastHandledPR(repo, upstreamRepo, branch);
    if (lastHandledPR === null) {
      this.logger.info(
        `Initializing the "${branch}" branch on ${org}/${repoName} in the database since it hasn't been handled before`,
      );
      // The latest PR may not actually be for this upstream branch, but it doesn't matter since
      // it's just recording that all merged PRs for this branch after this PR should processed.
      let upstreamPRID = await this.getLatestPRID(client, upstreamOrg, repoName);

      if (upstreamPRID === null) {
        upstreamPRID = 0;
      }
      await this.db?.setLastHandledPR(repo, upstreamRepo, branch, upstreamPRID);

      return;
    }

    const prsToHandle = await this.getMergedPRIDs(client, upstreamOrg, repoName, lastHandledPR as number);
    if (!prsToHandle.length) {
      this.logger.info(`No new PRs to handle for the branch "${branch}" on ${org}/${repoName}`);
      return;
    }

    const prTargets = await this.getBranchToPRIDs(client, upstreamOrg, repoName, prsToHandle);
    if (!prTargets[upstreamBranch]) {
      this.logger.info(`No new PRs to handle for the branch "${branch}" on ${org}/${repoName}`);
      return;
    }

    const prIDs = prTargets[upstreamBranch];
    let closedPreviousPR: number | null = null;
    if (pendingPR) {
      if (
        pendingPR.prID &&
        pendingPR.upstreamPRIDs.length == prIDs.length &&
        pendingPR.upstreamPRIDs.every((upstreamPR, i) => upstreamPR === prIDs[i]) &&
        pendingPR.action == PRAction.Created
      ) {
        this.logger.info(
          `The PR #${pendingPR.prID} covers all upstream changes for the branch "${branch}" on ${org}/${repoName}`,
        );
        return;
      }

      this.logger.info(
        `Closing the PR #${pendingPR.prID} to create a new PR with new upstream commits on the branch "${branch}" ` +
          `on ${org}/${repoName}`,
      );
      closedPreviousPR = pendingPR.prID as number;

      const wasClosed = await this.closePR(client, org, repoName, pendingPR.prID as number);
      if (!wasClosed) {
        this.logger.info(
          `The PR #${pendingPR.prID} on the branch "${branch}" on ${org}/${repoName} was already closed. Will skip ` +
            "for now for the webhook handler to make the proper database updates.",
        );

        return;
      }

      await this.db?.deletePendingPR(pendingPR);
    }

    const targetBranch = `${upstreamBranch}-${Date.now()}`;
    this.logger.info(
      `Creating the "${targetBranch}" branch on ${org}/${repoName} from the following PRs from ` +
        `${upstreamOrg}/${repoName}: ${prIDs.join(", ")}`,
    );

    const patchLocations = await this.getPRPatchLocations(client, upstreamOrg, repoName, prIDs);
    const token = await this.getToken(org);
    const gitRemote = `https://x-access-token:${token}@github.com/${org}/${repoName}.git`;
    const upstreamGitRemote = `https://github.com/${upstreamOrg}/${repoName}.git`;

    try {
      await applyPatches(gitRemote, upstreamGitRemote, branch, targetBranch, patchLocations);
    } catch (err) {
      this.logger.error(
        `Failed to apply the patches on the "${branch}" branch on ${org}/${repoName} from the following PRs from ` +
          ` ${upstreamOrg}/${repoName} ${prIDs.join(", ")}: ${err}`,
      );
      const issueID = await createFailureIssue(
        client,
        org,
        repoName,
        upstreamOrg,
        branch,
        prIDs,
        "one or more patches couldn't cleanly apply",
      );

      await this.db?.setPendingPR({
        repo: repo,
        upstreamRepo: upstreamRepo,
        upstreamPRIDs: prIDs,
        action: PRAction.Blocked,
        branch: branch,
        githubIssue: issueID,
        prID: null,
      });

      this.logger.info(
        `Created the GitHub issue #${issueID} on ${repo.organization}/${repo.name} to notify of the failure`,
      );
      return;
    }

    const prPrefix = `\n* ${upstreamOrg}/${repoName}#`;
    let prBody = `Syncing the following PRs:${prPrefix}${prIDs.join(prPrefix)}`;

    if (closedPreviousPR) {
      prBody += `\n\nThis replaces #${closedPreviousPR}.`;
    }

    this.logger.info(`Creating a PR on the branch "${branch}" on ${org}/${repoName} from the branch "${targetBranch}"`);
    const newPR = await client.pulls.create({
      owner: org,
      repo: repoName,
      head: targetBranch,
      base: branch,
      title: `🤖 Sync from ${upstreamOrg}/${repoName}: #${prIDs.join(", #")}`,
      body: prBody,
    });

    if (prLabels?.length) {
      await client.issues.addLabels({ owner: org, repo: repoName, issue_number: newPR.data.number, labels: prLabels });
    }

    this.logger.info(`Created the PR ${newPR.data.html_url}`);

    await this.db?.setPendingPR({
      repo: repo,
      upstreamRepo: upstreamRepo,
      upstreamPRIDs: prIDs,
      action: PRAction.Created,
      branch: branch,
      prID: newPR.data.number,
      githubIssue: null,
    });

    const requiredChecks = await getRequiredChecks(client, org, repoName, branch);
    if (requiredChecks.size === 0) {
      this.logger.info(`No checks are required for the PR ${newPR.data.html_url}. Will merge now.`);

      const merged = await mergePR(client, this.db as Database, pendingPR as PendingPR, newPR.data.head.sha);
      if (!merged) {
        this.logger.info(
          `Created a GitHub issue #${pendingPR?.githubIssue} on ${org}/${repoName} to notify of the failure to merge ` +
            ` the PR (#${newPR.data.number})`,
        );
      }
    }
  }

  /**
   * Initialize the Syncer object by setting up the database and gathering the required prerequisite metadata.
   */
  private async init() {
    if (!this.db) {
      const dbPath = Database.getDbPath(this.config);
      this.db = new Database(dbPath);
      await this.db.init();
    }

    this.appClient = this.getGitHubClient();

    const resp = await this.appClient.apps.listInstallations();
    for (const installation of resp["data"]) {
      const org = installation.account?.login as string;
      if (!this.orgs[org]) {
        this.orgs[org] = {};
      }
      this.orgs[org].installationID = installation["id"];

      const client = this.getGitHubClient(installation["id"]);
      this.orgs[org].client = client;

      const resp = await client.apps.listReposAccessibleToInstallation();
      for (const repo of resp["data"]["repositories"]) {
        if (!this.orgs[org].repos) {
          this.orgs[org].repos = new Set<string>();
        }

        this.orgs[org].repos?.add(repo["name"]);
      }
    }

    await this.getUpstreamRepos();
  }

  /**
   * Run the Syncer.
   *
   * This syncs all forked repository's branches with upstream based on the Syncer configuration and where the GitHub
   * app is installed.
   *
   * On every forked repository's branch, it checks for new upstream PRs and creates the appropriate pull-requests (PRs)
   * on the fork. If one or more upstream PRs don't apply on the forked repository's branch (i.e. merge conflicts), a
   * GitHub issue is created on the forked repository. No further action will be taken for this forked repository's
   * branch until the GitHub issue is closed, signaling that the issue was manually resolved.
   */
  async run() {
    await this.init();

    // For every organization that the GitHub app is installed in
    for (const org in this.orgs) {
      // For every upstream organization to sync to the installed organization
      for (const upstreamOrg in this.config.upstreamMappings[org] || {}) {
        // For every accessible repository from the organization that the GitHub app is installed in
        for (const repo of this.orgs[org].repos || []) {
          if (!this.upstreamOrgRepos[upstreamOrg] || !this.upstreamOrgRepos[upstreamOrg].has(repo)) {
            this.logger.info(
              `The GitHub App is installed on ${org}/${repo} but there is no ${upstreamOrg}/${repo} repo`,
            );
            continue;
          }

          const mapping = this.config.upstreamMappings[org][upstreamOrg];
          for (const [upstreamBranch, branch] of Object.entries(mapping.branchMappings).sort()) {
            try {
              await this.handleForkedBranch(org, upstreamOrg, repo, branch, upstreamBranch, mapping.prLabels);
            } catch (err) {
              this.logger.error(`The ${org}/${repo} ${branch} branch couldn't be handled: ${err}`);
            }
          }
        }
      }
    }
  }
}
