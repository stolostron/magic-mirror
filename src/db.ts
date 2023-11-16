import fs from "fs";

import sqlite3 from "sqlite3";

const DEFAULT_DB_PATH = "/etc/magic-mirror/magic-mirror.db";

const createSQLStatements = [
  // A table to store an upstream or fork repo. It's only useful as a foreign key in an effort of data deduplication.
  `
    CREATE TABLE IF NOT EXISTS repos
        (
            id INTEGER PRIMARY KEY autoincrement,
            organization TEXT NOT NULL,
            name TEXT NOT NULL
        )
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repos ON repos (organization, name);
  `,
  // A table with a row per upstream repo, fork repo, and fork branch. When such a combination is first encountered
  // based on where the GitHub app is installed and app's configuration, a "dummy" row is added to the table using the
  // last PR that was merged for that upstream repo's branch. All future upstream merged PRs for that branch are updated
  // in that row when properly handled.
  `
    CREATE TABLE IF NOT EXISTS last_handled_prs
        (
            id INTEGER PRIMARY KEY autoincrement,
            repo_id INTEGER NOT NULL,
            branch TEXT NOT NULL,
            upstream_repo_id INTEGER NOT NULL,
            upstream_pr_id INTEGER NOT NULL,
            FOREIGN KEY(repo_id) REFERENCES repos(id)
            FOREIGN KEY(upstream_repo_id) REFERENCES repos(id)
        )
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_last_handled_prs ON last_handled_prs (repo_id, upstream_repo_id, branch);
  `,
  // A table with a row per upstream repo, fork repo, and fork branch. When a PR is succesfully created on the
  // fork repo, an entry is added with the "action" column set to "Created". When a PR can't be created on the fork repo
  // (e.g. merge conflict), an entry is added with the action column set to "Blocked" and the "github_issue" column set
  // to the GitHub issue ID that is pending human action. Note that there is at most one PR per forked repo branch. If a
  // new upstream PR is merged while there is a pending PR, the app should replace the pending PR with a new PR to also
  // include the commits from the new upstream PR.
  `
    CREATE TABLE IF NOT EXISTS pending_prs
      (
          id INTEGER PRIMARY KEY autoincrement,
          repo_id INTEGER NOT NULL,
          branch TEXT NOT NULL,
          upstream_authors TEXT NOT NULL,
          upstream_repo_id INTEGER NOT NULL,
          upstream_pr_ids TEXT NOT NULL,
          action TEXT NOT NULL,
          pr_id INTEGER,
          github_issue INTEGER,
          FOREIGN KEY(repo_id) REFERENCES repos(id)
          FOREIGN KEY(upstream_repo_id) REFERENCES repos(id)
      )
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_prs ON pending_prs (repo_id, upstream_repo_id, branch);
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_prs_github ON pending_prs (repo_id, pr_id, github_issue);
  `,
];

/**
 * Represents a "repos" table row.
 */
export type Repo = {
  id: number;
  organization: string;
  name: string;
};

/**
 * Represents a "pending_prs" table row.
 */
export type PendingPR = {
  repo: Repo;
  branch: string;
  upstreamRepo: Repo;
  upstreamPRIDs: Array<number>;
  upstreamAuthors: Array<string>;
  action: PRAction;
  prID: number | null;
  githubIssue: number | null;
};

/**
 * The actions that can be set on a pending PR.
 */
export enum PRAction {
  // Waiting on a user to resolve the issue.
  Blocked = "Blocked",
  // The PR was created but hasn't been merged yet.
  Created = "Created",
}

/**
 * Abstracts database operations for the application.
 */
export class Database {
  private db?: sqlite3.Database;
  private dbPath: string;

  /**
   * Instantiate the Database class.
   * @param {string} dbPath the path to the SQLite3 database. If it doesn't exist, it will be created by the "init"
   *   method.
   */
  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Delete a pending PR row from the pending_prs table after it has been acted upon (merged or fixed manually).
   * @param {PendingPR} pendingPR the object representing the pending_prs table row.
   * @return {Promise<void>} a promise which resolves to nothing and rejects if the SQL statement failed to run.
   */
  async deletePendingPR(pendingPR: PendingPR): Promise<void> {
    return new Promise((resolve, reject) => {
      const sql = `
          DELETE FROM pending_prs
            WHERE repo_id=? AND branch=? AND upstream_repo_id=?
      `;
      this.run(sql, [pendingPR.repo.id, pendingPR.branch, pendingPR.upstreamRepo.id])
        .then(() => {
          resolve();
        })
        .catch((err) => {
          reject(err);
        });
    });
  }

  /**
   * Wrap the sqlite3.Database get method as a promise.
   * @param {string} sql the SQL statement.
   * @param {Array<any>} params an array of parameters for prepared statements.
   * @return {Promise<any>} a promise which resolves to nothing and rejects if the SQL statement failed to run.
   */
  private get(sql: string, params: Array<any> = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db?.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(row);
      });
    });
  }

  /**
   * Find the database path.
   *
   * This prioritizes dbPath set in the configuration followed by an existing ./magic-mirror.db file and a production
   * database set in DEFAULTDB_PATH.
   * @param {object} config the configuration object with dbPath optionally set.
   * @return {string} the database path to use when instantiating the Database class.
   */
  static getDbPath(config: { [key: string]: any }): string {
    if (config.dbPath) {
      return config.dbPath;
    } else if (fs.existsSync("magic-mirror.db")) {
      return "magic-mirror.db";
    } else {
      return DEFAULT_DB_PATH;
    }
  }

  /**
   * Get the GitHub ID of the last handled pull-request (PR) for the repo, branch, and upstream repo.
   * @param {Repo} repo the Repo object representing the forked repo.
   * @param {Repo} upstreamRepo the Repo object representing the upstream repo.
   * @param {string} branch the forked repo's branch.
   * @return {Promise<number | null>} a Promise that resolves to a PR ID or null if it hasn't been handled before.
   *   It rejects if the database query fails.
   */
  async getLastHandledPR(repo: Repo, upstreamRepo: Repo, branch: string): Promise<number | null> {
    const sql = `
      SELECT upstream_pr_id
      FROM last_handled_prs
      WHERE repo_id=? AND upstream_repo_id=? AND branch=?
    `;
    const result = await this.get(sql, [repo.id, upstreamRepo.id, branch]);
    if (!result) {
      return null;
    }

    return result.upstream_pr_id;
  }

  /**
   * Get or create the GitHub repo representation in the database.
   * @param {string} organization the GitHub organization/user owner of the repo.
   * @param {string} name the GitHub repo name.
   * @return {Promise<Repo>} A promise that resolves to a Repo object and rejects if the database statements fail.
   */
  async getOrCreateRepo(organization: string, name: string): Promise<Repo> {
    const sql = "INSERT OR IGNORE INTO repos (organization, name) VALUES(?, ?)";
    // Can't rely on the returned last ID because when the "OR IGNORE" is executed,
    // the last ID is inaccurate.
    await this.run(sql, [organization, name]);

    const getIDSql = "SELECT id FROM repos WHERE organization=? AND name=?";
    const row = await this.get(getIDSql, [organization, name]);

    return {
      id: row.id,
      organization: organization,
      name: name,
    };
  }

  /**
   * Get a pending pull-request (PR) from the repo, repo's branch, and upstream repo.
   * @param {Repo} repo the Repo object representing the forked repo.
   * @param {Repo} upstreamRepo the Repo object representing the upstream repo.
   * @param {string} branch the forked repo's branch.
   * @return {Promise<PendingPR | null>} A promise that resolves to a PendingPR object or null when there isn't a
   *   pending PR. It rejects to if the database query fails.
   */
  async getPendingPR(repo: Repo, upstreamRepo: Repo, branch: string): Promise<PendingPR | null> {
    const sql = `
      SELECT upstream_pr_ids, action, pr_id, github_issue, upstream_authors
      FROM pending_prs
      WHERE repo_id=? AND upstream_repo_id=? AND branch=?
    `;
    const result = await this.get(sql, [repo.id, upstreamRepo.id, branch]);
    if (!result) {
      return null;
    }

    return {
      repo: repo,
      branch: branch,
      upstreamRepo: upstreamRepo,
      upstreamPRIDs: (result.upstream_pr_ids as string).split(",").map((idStr) => parseInt(idStr)),
      upstreamAuthors: (result.upstream_authors as string).split(","),
      action: result.action,
      prID: result.pr_id,
      githubIssue: result.github_issue,
    };
  }

  /**
   * Get a pending pull-request (PR) with the input GitHub issue ID.
   *
   * The returned pending PR either represents a PR that could not be created by Magic Mirror (e.g. merge conflict) or
   * a PR created by Magic Mirror that had its CI failed.
   * @param {Repo} repo the repo that the GitHub issue belongs to.
   * @param {number} issueID the GitHub issue ID (technically the "number") to search for.
   * @return {Promise<PendingPR | null>} a Promise that resolves to the PendingPR object or null if it's not found.
   */
  async getPendingPRByIssue(repo: Repo, issueID: number): Promise<PendingPR | null> {
    const sql = `
      SELECT upstream_pr_ids, upstream_authors, action, branch, pr_id, upstream_repo_id
      FROM pending_prs
      WHERE repo_id=? AND github_issue=?
    `;
    const result = await this.get(sql, [repo.id, issueID]);
    if (!result) {
      return null;
    }

    const upstreamRepo = await this.getRepoByID(result.upstream_repo_id);

    return {
      repo: repo,
      branch: result.branch,
      // @ts-expect-error since there are foreign key restrictions that prevent upstreamRepo from being null.
      upstreamRepo: upstreamRepo,
      upstreamPRIDs: (result.upstream_pr_ids as string).split(",").map((idStr) => parseInt(idStr)),
      upstreamAuthors: (result.upstream_authors as string).split(","),
      action: result.action,
      prID: result.pr_id,
      githubIssue: issueID,
    };
  }

  /**
   * Get a pending pull-request (PR) with the input GitHub PR ID.
   *
   * The returned pending PR represents a PR that Magic Mirror created. This could optionally have
   * the githubIssue property set indicating that the PR CI previously failed.
   * @param {Repo} repo the repo that the GitHub issue belongs to.
   * @param {number} prID the GitHub PR ID (technically the "number") to search for.
   * @return {Promise<PendingPR | null>} a Promise that resolves to the PendingPR object or null if it's not found.
   */
  async getPendingPRByPRID(repo: Repo, prID: number): Promise<PendingPR | null> {
    const sql = `
      SELECT upstream_pr_ids, upstream_authors, action, branch, github_issue, upstream_repo_id
      FROM pending_prs
      WHERE repo_id=? AND pr_id=?
    `;
    const result = await this.get(sql, [repo.id, prID]);
    if (!result) {
      return null;
    }

    const upstreamRepo = await this.getRepoByID(result.upstream_repo_id);

    return {
      repo: repo,
      branch: result.branch,
      // @ts-expect-error since there are foreign key restrictions that prevent upstreamRepo from being null.
      upstreamRepo: upstreamRepo,
      upstreamPRIDs: (result.upstream_pr_ids as string).split(",").map((idStr) => parseInt(idStr)),
      upstreamAuthors: (result.upstream_authors as string).split(","),
      action: result.action,
      prID: prID,
      githubIssue: result.github_issue,
    };
  }

  /**
   * Get repository by the database id column.
   * @param {number} repoID the database id column of the repo.
   * @return {Promise<Repo | null>} a Promise that resolves to the repository or null if it's not found.
   */
  async getRepoByID(repoID: number): Promise<Repo | null> {
    const result = await this.get("SELECT organization, name FROM repos WHERE id=?", [repoID]);
    if (!result) {
      return null;
    }

    return {
      id: repoID,
      organization: result.organization,
      name: result.name,
    };
  }

  /**
   * Initialize the database by enabling foreign keys and creating all necessary tables and indices if not present.
   * @return {Promise<void>} a promise that resolves to nothing and rejects if the database couldn't be initialized.
   */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, async (err) => {
        if (err) {
          reject(err);
          return;
        }

        const statements = ["PRAGMA foreign_keys = ON"].concat(createSQLStatements);

        let errEncountered = false;
        for (const statement of statements) {
          await this.run(statement).catch((err) => {
            reject(err);
            errEncountered = true;
          });

          // @ts-expect-error TypeScript doesn't detect that errEncountered is set in the catch function.
          if (errEncountered === true) {
            return;
          }
        }

        // Add upstream_authors if there's a table that doesn't have this new column yet
        // (this logic could be removed in a future release once the table is established
        // over a number of releases)
        const upstreamAuthors = await this.get(
          "SELECT * FROM pragma_table_info('pending_prs') WHERE name='upstream_authors'",
        );
        if (!upstreamAuthors) {
          await this.run(
            "ALTER TABLE pending_prs ADD upstream_authors TEXT NULL",
            [],
          ).catch((err) => {
            reject(err);
            return;
          });

          await this.run(
            "UPDATE pending_prs SET upstream_authors = 'not-applicable' WHERE upstream_authors IS NULL",
            [],
          ).catch((err) => {
            reject(err);
            return;
          });

          await this.run(
            "ALTER TABLE pending_prs ALTER COLUMN upstream_authors SET NOT NULL",
            [],
          ).catch((err) => {
            reject(err);
            return;
          });
        }

        resolve();
      });
    });
  }

  /**
   * Wrap the sqlite3.Database.run method as a promise.
   * @param {string} sql the SQL statement.
   * @param {Array<any>} params an array of parameters for prepared statements.
   * @return {Promise<sqlite3.RunResult>} a promise of a sqlite3.RunResult and rejects if the run method failed.
   */
  private async run(sql: string, params: Array<any> = []): Promise<sqlite3.RunResult> {
    const db = this.db;
    return new Promise((resolve, reject) => {
      db?.run(sql, params, function (err) {
        if (err) {
          reject(err);
          return;
        }

        resolve(this);
      });
    });
  }

  /**
   * Set the last handled pull-request (PR) for the forked repo, forked repo branch, and upstream repo.
   *
   * This signifies the starting point for discovering new merged upstream PRs.
   * @param {Repo} repo the Repo object representing the forked repo.
   * @param {Repo} upstreamRepo the Repo object representing the upstream repo.
   * @param {string} branch the forked repo's branch.
   * @param {number} upstreamPRID the upstream GitHub PR ID.
   * @return {Promise<void>} a promise that resolves to nothing and rejects if the database statement failed.
   */
  async setLastHandledPR(repo: Repo, upstreamRepo: Repo, branch: string, upstreamPRID: number): Promise<void> {
    const sql = `
      INSERT INTO last_handled_prs (
        repo_id, branch, upstream_repo_id, upstream_pr_id
      )
      VALUES(?, ?, ?, ?)
      ON CONFLICT(repo_id, upstream_repo_id, branch)
      DO UPDATE SET upstream_pr_id=excluded.upstream_pr_id
    `;
    await this.run(sql, [repo.id, branch, upstreamRepo.id, upstreamPRID]);
  }

  /**
   * Set a pending pull-request (PR) that is awaiting to be merged or manually fixed.
   *
   * This determines if a PR is awaiting CI to be merged or if activity is blocked on a forked repo, forked repo branch,
   * and upstream repo if a failure occurred (e.g. merge conflict). In the failure case, a GitHub issue ID is set on
   * the PendingPR object and will unblock activity once it is closed by a human.
   * @param {PendingPR} pendingPR the PendingPR object to set.
   * @return {Promise<void>} a promise that resolves to nothing and rejects if the database statement failed.
   */
  async setPendingPR(pendingPR: PendingPR): Promise<void> {
    const sql = `
      INSERT INTO pending_prs (
        repo_id, branch, upstream_repo_id, upstream_pr_ids, upstream_authors, action, pr_id, github_issue
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, upstream_repo_id, branch)
      DO UPDATE SET
        upstream_pr_ids=excluded.upstream_pr_ids,
        upstream_authors=excluded.upstream_authors,
        action=excluded.action,
        pr_id=excluded.pr_id,
        github_issue=excluded.github_issue
    `;
    await this.run(sql, [
      pendingPR.repo.id,
      pendingPR.branch,
      pendingPR.upstreamRepo.id,
      pendingPR.upstreamPRIDs.join(","),
      pendingPR.upstreamAuthors.join(","),
      pendingPR.action,
      pendingPR.prID,
      pendingPR.githubIssue,
    ]);
  }
}
