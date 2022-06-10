import { Probot, Server } from "probot";

import { Config, loadConfig } from "./config";
import { Database, PRAction } from "./db";
import { createFailureIssue } from "./github";
import { newLogger } from "./log";

/**
 * Add the handlers to Probot app.
 * @param {Probot} probot the Probot app to configure.
 * @param {Config} config the Magic Mirror configuration.
 * @param {Database} db the Magic Mirror database.
 */
export async function app(probot: Probot, config: Config, db: Database) {
  const logger = newLogger(config.logLevel);

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
   * Handle a completed check suite.
   *
   * This handler checks to see if the completed check suite (PR CI) is associated with a PR that Magic Mirror had
   * previously created. If it is, then Magic Mirror merges the PR if the check suite is successful or if it failed,
   * a GitHub issue is created. The latter case blocks this forked repo's branch from further syncing by Magic Mirror
   * until the GitHub issue is closed.
   */
  probot.on("check_suite.completed", async (context) => {
    const check = context.payload.check_suite;
    const prs = context.payload.check_suite.pull_requests;
    if (!prs.length) {
      logger.debug(`Ignoring the check suite #${check.id} since there's no associated PR`);
      return;
    }

    const organization = context.payload.repository.owner.login;
    const repoName = context.payload.repository.name;
    logger.debug(`Checking the check suite #${check.id} on ${organization}/${repoName}`);
    const repo = await db.getOrCreateRepo(organization, repoName);

    for (const pr of prs) {
      const pendingPR = await db.getPendingPRByPRID(repo, pr.number);
      if (!pendingPR) {
        logger.debug(
          `The PR #${pr.number} on the check suite #${check.id} on ${organization}/${repoName} does not apply`,
        );
        continue;
      }

      if (pendingPR.action === PRAction.Blocked) {
        // This can happen if the CI failed initially and a GitHub issue was created for manual action.
        logger.info(
          `The PR #${pr.number} on ${organization}/${repoName} is blocked. Skipping to allow for manual action.`,
        );
        continue;
      }

      if (check.conclusion === "success") {
        logger.debug(`Merging the PR #${pr.number} on ${organization}/${repoName} for the branch ${pr.base.ref}`);
        await context.octokit.pulls.merge({
          owner: organization,
          repo: repoName,
          pull_number: pr.number,
          merge_method: "rebase",
          sha: pr.head.sha,
        });
        logger.info(`Merged the PR #${pr.number} on ${organization}/${repoName} for the branch ${pr.base.ref}`);
        return;
      }

      logger.info(
        `The check #${check.id} has the conclusion ${check.conclusion} on PR #${pr.number} on ` +
          `${organization}/${repoName} for the branch ${pr.base.ref}. Creating a GitHub issue for manual correction.`,
      );
      const issueID = await createFailureIssue(
        context.octokit,
        organization,
        repoName,
        pendingPR.upstreamRepo.organization,
        pendingPR.branch,
        pendingPR.upstreamPRIDs,
        `the PR check suite concluded with "${check.conclusion}"`,
        pr.number,
      );
      logger.info(`Created the GitHub issue #${issueID} on ${organization}/${repoName} to notify of the failure`);

      pendingPR.githubIssue = issueID;
      pendingPR.action = PRAction.Blocked;
      await db.setPendingPR(pendingPR);

      return;
    }

    logger.debug(`Ignoring the check suite #${check.id} since there's not a relevant PR`);
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
}

/**
 * Run the Magic Mirror GitHub webhook receiver.
 */
export async function run() {
  const config = loadConfig();
  const dbPath = Database.getDbPath(config);
  const db = new Database(dbPath);
  await db.init();

  const server = new Server({
    Probot: Probot.defaults({
      appId: config.appID,
      privateKey: config.privateKey,
      secret: config.webhookSecret,
    }),
  });
  await server.load((probot: Probot) => app(probot, config, db));
  await server.start();
}
