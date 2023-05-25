import { Octokit } from "@octokit/rest";
import { CheckRunPullRequest, PullRequest } from "@octokit/webhooks-types";
import { ApplicationFunctionOptions, Probot, Server } from "probot";

import { Config, loadConfig } from "./config";
import { Database, PRAction } from "./db";
import { appendPRDescription, createFailureIssue, getRequiredChecks, mergePR } from "./github";
import { newLogger } from "./log";

const okayCheckRunConclusions = new Set(["success", "neutral", "skipped"]);

/**
 * Add the handlers to Probot app.
 * @param {Probot} probot the Probot app to configure.
 * @param {ApplicationFunctionOptions} probotOptions the Probot options that give access to the getRouter method.
 * @param {Config} config the Magic Mirror configuration.
 * @param {Database} db the Magic Mirror database.
 */
export async function app(probot: Probot, probotOptions: ApplicationFunctionOptions, config: Config, db: Database) {
  const logger = newLogger(config.logLevel);

  // Add a status endpoint for liveness probes
  if (probotOptions.getRouter) {
    const router = probotOptions.getRouter();
    router.get("/status", (_, res) => {
      res.contentType("text/plain; charset=utf-8");
      res.send("OK");
    });
  }

  /**
   * Handle a closed GitHub issue.
   *
   * This handler checks to see if the closed GitHub issue is associated with a row in the "pending_prs" database table.
   * If it is, then this means this GitHub issue was created by Magic Mirror either because Magic Mirror could not
   * create a PR (e.g. merge conflict) or the created PR had a CI failure. When the GitHub issue is closed, Magic Mirror
   * assumes that the cherry pick was manually applied or the failure can be ignored. This unblocks the forked repo's
   * branch for additional syncing by Magic Mirror.
   */
  probot.on("issues.closed", async (context) => {
    const issueID = context.payload.issue.number;
    const organization = context.payload.repository.owner.login;
    const repoName = context.payload.repository.name;

    logger.debug(`Checking if the issue #${issueID} on ${organization}/${repoName} is relevant`);
    const repo = await db.getOrCreateRepo(organization, repoName);
    const pendingPR = await db.getPendingPRByIssue(repo, issueID);
    if (!pendingPR) {
      logger.debug(`The issue #${issueID} on ${organization}/${repoName} is not relevant`);
      return;
    }

    logger.info(
      `The issue #${issueID} on ${organization}/${repoName} was closed. Resuming syncing of ` +
        `${organization}/${repoName} for the forked branch of "${pendingPR.branch}".`,
    );

    if (pendingPR.prID) {
      logger.debug(`Closing the PR #${pendingPR.prID} on ${organization}/${repoName} since the issue was closed`);
      await context.octokit.pulls.update({
        owner: organization,
        repo: repoName,
        pull_number: pendingPR.prID,
        state: "closed",
      });
    }
    // Set the last handled PR to be the last upstream PR that was manually synced.
    await db.setLastHandledPR(
      pendingPR.repo,
      pendingPR.upstreamRepo,
      pendingPR.branch,
      pendingPR.upstreamPRIDs[pendingPR.upstreamPRIDs.length - 1],
    );
    // Delete the pending PR since it was manually synced.
    await db.deletePendingPR(pendingPR);
  });

  /**
   * Handle a completed check run.
   *
   * This handler checks to see if the completed check run is associated with a PR that Magic Mirror had
   * previously created. If it is, then Magic Mirror merges the PR if all the check runs and statuses on the PR are
   * successful or if it failed, a GitHub issue is created. The latter case blocks this forked repo's branch from
   * further syncing by Magic Mirror until the GitHub issue is closed.
   */
  probot.on("check_run.completed", async (context) => {
    const check = context.payload.check_run;
    const prs = context.payload.check_run.pull_requests;
    if (!prs.length) {
      logger.debug(`Ignoring the check run ${check.name} (#${check.id}) since there's no associated PR`);
      return;
    }

    const organization = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    logger.debug(`Checking the check run ${check.name} (#${check.id}) on ${organization}/${repo}`);

    // It's unlikely that there are multiple PRs with the check run, but stranger things have happened.
    for (const pr of prs) {
      const handled = await handlePRCIUpdate(
        context.octokit,
        organization,
        repo,
        pr,
        check.name,
        okayCheckRunConclusions.has(check.conclusion as string),
      );
      if (handled) {
        return;
      }
    }

    logger.debug(`Ignoring the check suite ${check.name} (#${check.id}) since there's not a relevant PR`);
  });

  /**
   * Handle a commit status.
   *
   * This handler checks to see if the commit status is associated with a PR that Magic Mirror had
   * previously created. If it is, then Magic Mirror merges the PR if all the check runs and statuses on the PR are
   * successful or if it failed, a GitHub issue is created. The latter case blocks this forked repo's branch from
   * further syncing by Magic Mirror until the GitHub issue is closed.
   */
  probot.on("status", async (context) => {
    const status = context.payload;
    logger.debug(`Checking the commit status ${status.context} on ${status.sha}`);

    if (status.state === "pending") {
      logger.debug(`Ignoring the commit status ${status.context} on ${status.sha} since it's pending`);
      return;
    }

    const organization = status.repository.owner.login;
    const repo = status.repository.name;
    const prs = await context.octokit.pulls.list({
      owner: status.repository.owner.login,
      repo: status.repository.name,
      head: status.sha,
    });

    // It's unlikely that there are multiple PRs with the same commit head, but stranger things have happened.
    for (const pr of prs.data) {
      const handled = await handlePRCIUpdate(
        context.octokit,
        organization,
        repo,
        pr,
        status.context,
        status.state === "success",
      );
      if (handled) {
        return;
      }
    }
  });

  /**
   * Handle a closed PR event.
   *
   * This handler checks to see if the closed PR is associated with a PR that Magic Mirror had previously created.
   * If the PR previously had its CI pass and was merged/closed, then Magic Mirror updates its database to indicate
   * that syncing from upstream should start from the last upstream PR that this PR included as a cherry pick. If the
   * PR previously had its CI fail, then there is a GitHub issue associated with this PR and no action is taken since
   * the GitHub issue is the mechanism for communicating that an issue is resolved.
   */
  probot.on("pull_request.closed", async (context) => {
    const pr = context.payload.pull_request;
    const organization = context.payload.repository.owner.login;
    const repoName = context.payload.repository.name;

    logger.debug(`Checking the PR #${pr.number} on ${organization}/${repoName}`);
    const repo = await db.getOrCreateRepo(organization, repoName);
    const pendingPR = await db.getPendingPRByPRID(repo, pr.number);
    if (!pendingPR) {
      logger.debug(`The PR #${pr.number} on ${organization}/${repoName} does not apply`);
      return;
    }

    if (pendingPR.githubIssue) {
      logger.info(
        `The PR #${pr.number} on ${organization}/${repoName} closed but there is still the open GitHub issue ` +
          `#${pendingPR.githubIssue}. Skipping any action for now.`,
      );
      return;
    }

    // Set the last handled PR to be the last upstream PR that was merged in the fork.
    await db.setLastHandledPR(
      pendingPR.repo,
      pendingPR.upstreamRepo,
      pendingPR.branch,
      pendingPR.upstreamPRIDs[pendingPR.upstreamPRIDs.length - 1],
    );
    await db.deletePendingPR(pendingPR);

    logger.info(`Marked the PR #${pr.number} as closed on ${organization}/${repoName} for the branch ${pr.base.ref}`);
  });

  /**
   * Handle a commit status or check run completing for a PR.
   *
   * This will merge the PR if this is the last required successful commit status or check run. This will create a
   * GitHub issue if the commit status or check run failed.
   *
   * Note that a PR could get stuck if the required checks on the branch change while the PR CI is still running.
   *
   * @param {Octokit} client the GitHub client to use that is authenticated as the GitHub installation.
   * @param {string} organization the GitHub organization of the repository that the PR belongs to.
   * @param {string} repoName the GitHub repository name of the repository that the PR belongs to.
   * @param {PullRequest | CheckRunPullRequest} pr the pull-request that the CI update is for.
   * @param {string} checkName the name of the commit status or check run that just completed.
   * @param {boolean} success determines if the commit status or check run was successful.
   * @return {Promise<boolean>} a Promise that resolves to a boolean indicating if the PR was handled. This is false if
   *   if the PR is blocked or isn't known to Magic Mirror.
   */
  const handlePRCIUpdate = async (
    client: Octokit,
    organization: string,
    repoName: string,
    pr: PullRequest | CheckRunPullRequest,
    checkName: string,
    success: boolean,
  ): Promise<boolean> => {
    const repo = await db.getOrCreateRepo(organization, repoName);
    const pendingPR = await db.getPendingPRByPRID(repo, pr.number);
    if (!pendingPR) {
      logger.debug(`The PR #${pr.number} on ${organization}/${repoName} does not apply`);
      return false;
    }

    if (pendingPR.action === PRAction.Blocked) {
      // This can happen if the CI failed initially and a GitHub issue was created for manual action.
      logger.info(
        `The PR #${pr.number} on ${organization}/${repoName} is blocked. Skipping to allow for manual action.`,
      );
      return false;
    }

    const requiredChecks = await getRequiredChecks(client, organization, repoName, pr.base.ref);
    if (!requiredChecks.has(checkName)) {
      logger.debug(
        `The check ${checkName} for PR #${pr.number} on ${organization}/${repoName} is not required. Skipping check.`,
      );
      return true;
    }

    // If the check run or status failed, the other check runs and status associated with the PR don't need to be
    // checked.
    if (success !== true) {
      const issueID = await createFailureIssue(
        client,
        organization,
        repoName,
        pendingPR.upstreamRepo.organization,
        pendingPR.branch,
        pendingPR.upstreamPRIDs,
        "the PR CI failed",
        pr.number,
      );
      logger.info(`Created the GitHub issue #${issueID} on ${organization}/${repoName} to notify of the failure`);

      pendingPR.githubIssue = issueID;
      pendingPR.action = PRAction.Blocked;
      await db.setPendingPR(pendingPR);

      // Append to description on PR to attach the issue to the pending PR
      const closesMsg = `Closes #${issueID}`;
      const appendErr = await appendPRDescription(
        client,
        organization,
        repoName,
        pr.number,
        closesMsg,
      );

      if (appendErr) {
        logger.info(`Error appending "${closesMsg}" to PR ${pr.number} on ${organization}/${repoName}: ${appendErr}`);
      }

      return true;
    }

    const remainingChecks = new Set(requiredChecks);

    // Verify that this is the last required check run/status that we were waiting on.
    let page = 1;
    while (true) {
      const checks = await client.checks.listForRef({
        owner: organization,
        repo: repoName,
        ref: pr.head.ref,
        page: page,
      });
      if (checks.data.check_runs.length === 0) {
        break;
      }

      for (const checkRun of checks.data.check_runs) {
        if (!remainingChecks.has(checkRun.name)) {
          continue;
        }

        if (!okayCheckRunConclusions.has(checkRun.conclusion as string)) {
          logger.debug(
            `The check run #${checkRun.id} on the PR #${pr.number} on ${organization}/${repoName} has a conclusion ` +
              `of ${checkRun.conclusion}. Ignoring for now since another webhook event will handle this.`,
          );
          return true;
        }

        remainingChecks.delete(checkRun.name);
      }

      page += 1;
    }

    // Skip the commit status API call if the PR CI only uses check runs
    if (remainingChecks.size) {
      page = 1;
      while (true) {
        const statuses = await client.repos.listCommitStatusesForRef({
          owner: organization,
          repo: repoName,
          ref: pr.head.ref,
          page: page,
        });
        if (statuses.data.length === 0) {
          break;
        }

        for (const status of statuses.data) {
          if (!remainingChecks.has(status.context)) {
            continue;
          }

          if (status.state !== "success") {
            logger.debug(
              `The commit status #${status.id} on the PR #${pr.number} on ${organization}/${repoName} has a state ` +
                `of ${status.state}. Ignoring for now since another webhook event will handle this.`,
            );
            return true;
          }

          remainingChecks.delete(status.context);
        }

        page += 1;
      }
    }

    if (remainingChecks.size) {
      logger.info(
        `There are still remaining check runs/statuses that aren't registered on the PR #${pr.number} on ` +
          `${organization}/${repoName}.`,
      );
      return true;
    }

    logger.debug(
      `All PR CI has passed. Merging the PR #${pr.number} on ${organization}/${repoName} for the branch ${pr.base.ref}`,
    );

    const merged = await mergePR(client, db, pendingPR, pr.head.sha);
    if (merged) {
      logger.info(`Merged the PR #${pr.number} on ${organization}/${repoName} for the branch ${pr.base.ref}`);
    } else {
      // The GitHub issue is created in the mergePR function. The log message is here to provide more context.
      logger.info(
        `Created a GitHub issue on ${organization}/${repoName} to notify of the failure to merge the PR ` +
          `(#${pr.number})`,
      );
    }

    return true;
  };
}

/**
 * Get the configured Probot Server instance.
 * @param {Config} config the configuration object to configure Probot with.
 * @param {Database} db the Database object to use in the Probot event handlers.
 * @return {Promise<Server>} a Promise that resolves to a configured Probot Server instance.
 */
export async function getProbotServer(config: Config, db: Database): Promise<Server> {
  const server = new Server({
    Probot: Probot.defaults({
      appId: config.appID,
      privateKey: config.privateKey,
      secret: config.webhookSecret,
    }),
  });
  await server.load((probot: Probot, probotOptions: ApplicationFunctionOptions) =>
    app(probot, probotOptions, config, db),
  );

  return server;
}

/**
 * Run the Magic Mirror GitHub webhook receiver.
 */
export async function run() {
  const config = loadConfig();

  const dbPath = Database.getDbPath(config);
  const db = new Database(dbPath);
  await db.init();

  const server = await getProbotServer(config, db);
  await server.start();
}
