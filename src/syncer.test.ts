// @ts-nocheck this is required for all the mocking and accessing of private methods.
import path from "path";

import tmp from "tmp";

import { Database, PendingPR, PRAction } from "./db";
import { getRequiredChecks, mergePR } from "./github";
import { applyPatches } from "./git";

// This must be before importing from syncer.ts for the mock to take effect
jest.mock("@octokit/auth-app", () => ({
  ...jest.requireActual("@octokit/auth-app"),
  createAppAuth: () => {
    const mockAuth = jest.fn();
    mockAuth.mockResolvedValue({ token: "secret token" });
    return mockAuth;
  },
}));
jest.mock("./git");
jest.mock("./github", () => ({
  ...jest.requireActual("./github"),
  createFailureIssue: () => {
    return new Promise<number>((resolve) => {
      resolve(8);
    });
  },
  getRequiredChecks: jest.fn(async () => new Set<string>(["dco"])),
  mergePR: jest.fn(async () => true),
}));

import { Config, Syncer } from "./syncer";

let config: Config;
let dirObj: tmp.DirResult;
let syncer: Syncer;

beforeEach(async () => {
  jest.restoreAllMocks();
  (applyPatches as jest.Mock).mockImplementation(async () => true);
  (getRequiredChecks as jest.Mock).mockImplementation(async () => new Set<string>(["dco"]));

  config = {
    appID: 2,
    logLevel: "debug",
    privateKey: "some private key",
    upstreamMappings: {
      stolostron: {
        "open-cluster-management-io": {
          branchMappings: {
            main: "release-2.5",
            "release-0.6": "release-2.4",
          },
        },
      },
    },
  };

  dirObj = tmp.dirSync({ keep: true, unsafeCleanup: true });
  syncer = new Syncer(config);
  const db = new Database(path.join(dirObj.name, "magic-mirror.db"));
  await db.init();
  syncer.db = db;
});

afterEach(() => {
  dirObj.removeCallback();
});

test("Syncer.closePR", async () => {
  const mockClient = jest.fn();
  mockClient.pulls = jest.fn();
  mockClient.pulls.get = jest.fn().mockResolvedValue({ data: { state: "open" } });

  mockClient.issues = jest.fn();
  mockClient.issues.createComment = jest.fn().mockResolvedValue({});

  mockClient.pulls.update = jest.fn().mockResolvedValue({});

  await expect(syncer.closePR(mockClient, "org", "repo", 123)).resolves.toBe(true);
  expect(mockClient.pulls.update.mock.calls.length).toBe(1);
});

test("Syncer.closePR already closed", async () => {
  const mockClient = jest.fn();
  mockClient.pulls = jest.fn();
  mockClient.pulls.get = jest.fn().mockResolvedValue({ data: { state: "closed" } });

  mockClient.issues = jest.fn();
  mockClient.issues.createComment = jest.fn();

  mockClient.pulls.update = jest.fn();

  await expect(syncer.closePR(mockClient, "org", "repo", 123)).resolves.toBe(false);
  expect(mockClient.issues.createComment.mock.calls.length).toBe(0);
  expect(mockClient.pulls.update.mock.calls.length).toBe(0);
});

test("Syncer.getLatestPRID", async () => {
  const mockClient = jest.fn();
  mockClient.rest = jest.fn();
  mockClient.rest.search = jest.fn();
  mockClient.rest.search.issuesAndPullRequests = jest.fn().mockResolvedValue({ data: { items: [{ number: 3 }] } });

  await expect(syncer.getLatestPRID(mockClient, "org", "repo", 123)).resolves.toBe(3);
});

test("Syncer.getLatestPRID no PR", async () => {
  const mockClient = jest.fn();
  mockClient.rest = jest.fn();
  mockClient.rest.search = jest.fn();
  mockClient.rest.search.issuesAndPullRequests = jest.fn().mockResolvedValue({ data: { items: [] } });

  await expect(syncer.getLatestPRID(mockClient, "org", "repo", 123)).resolves.toBeNull();
});

test("Syncer.getToken", async () => {
  await expect(syncer.getToken("org")).resolves.toBe("secret token");
});

test("Syncer.getMergedPRIDs", async () => {
  const mockClient = jest.fn();
  mockClient.pulls = jest.fn();
  mockClient.pulls.get = jest.fn().mockResolvedValueOnce(
    new Promise((resolve) =>
      resolve({
        data: { merged_at: "2022-06-29T19:51:52Z", number: 2 },
      }),
    ),
  );
  mockClient.rest = jest.fn();
  mockClient.rest.search = jest.fn();
  mockClient.rest.search.issuesAndPullRequests = jest.fn().mockResolvedValueOnce(
    new Promise((resolve) =>
      resolve({
        data: {
          items: [
            { number: 4, pull_request: { merged_at: "2022-06-30T14:42:11Z" }, updated_at: "2022-06-30T14:42:11Z" },
            { number: 3, pull_request: { merged_at: "2022-06-30T15:45:25Z" }, updated_at: "2022-06-30T13:45:25Z" },
            { number: 5, pull_request: { merged_at: "2022-06-29T19:55:34Z" }, updated_at: "2022-06-29T19:55:34Z" },
          ],
        },
      }),
    ),
  );
  mockClient.rest.search.issuesAndPullRequests.mockResolvedValueOnce(
    new Promise((resolve) =>
      resolve({
        data: {
          items: [
            { number: 2, pull_request: { merged_at: "2022-06-29T19:51:52Z" }, updated_at: "2022-06-29T19:55:34Z" },
            { number: 1, pull_request: { merged_at: "2022-06-28T14:31:44Z" }, updated_at: "2022-06-28T14:31:44Z" },
          ],
        },
      }),
    ),
  );

  await expect(syncer.getMergedPRIDs(mockClient, "org", "repo", 1)).resolves.toEqual([5, 4, 3]);
});

test("Syncer.getMergedPRIDs no PRs", async () => {
  const mockClient = jest.fn();
  mockClient.pulls = jest.fn();
  mockClient.pulls.get = jest.fn().mockResolvedValueOnce(
    new Promise((resolve) =>
      resolve({
        data: { merged_at: "2022-06-29T19:51:52Z", number: 2 },
      }),
    ),
  );
  mockClient.rest = jest.fn();
  mockClient.rest.search = jest.fn();
  mockClient.rest.search.issuesAndPullRequests = jest.fn().mockResolvedValueOnce(
    new Promise((resolve) =>
      resolve({
        data: {
          items: [
            { number: 2, pull_request: { merged_at: "2022-06-29T19:51:52Z" }, updated_at: "2022-06-29T19:55:34Z" },
          ],
        },
      }),
    ),
  );
  mockClient.rest.search.issuesAndPullRequests = jest.fn().mockResolvedValueOnce(
    new Promise((resolve) =>
      resolve({
        data: { items: [] },
      }),
    ),
  );

  await expect(syncer.getMergedPRIDs(mockClient, "org", "repo", 1)).resolves.toEqual([]);
});

test("Syncer.getGitHubClient", () => {
  const client = syncer.getGitHubClient(523);
  expect(client).not.toBeNull();
});

test("Syncer.getPRPatchLocations", async () => {
  const mockClient = jest.fn();
  mockClient.pulls = jest.fn();
  mockClient.pulls.get = jest.fn().mockResolvedValueOnce(
    new Promise((resolve) =>
      resolve({
        data: { merge_commit_sha: "79bf6a3d414f4ff08fb726fc60f641e9bd60a025", commits: 2 },
      }),
    ),
  );
  mockClient.pulls.get.mockResolvedValueOnce(
    new Promise((resolve) =>
      resolve({
        data: { merge_commit_sha: "b6d3319c0383b929bb05da90add55a07f3f75660", commits: 1 },
      }),
    ),
  );

  const syncer = new Syncer(config);
  await expect(syncer.getPRPatchLocations(mockClient, "org", "repo", [3, 5])).resolves.toEqual([
    { head: "79bf6a3d414f4ff08fb726fc60f641e9bd60a025", numCommits: 2 },
    { head: "b6d3319c0383b929bb05da90add55a07f3f75660", numCommits: 1 },
  ]);
});

test("Syncer.getBranchToPRIDs", async () => {
  const mockClient = jest.fn();
  mockClient.pulls = jest.fn();
  mockClient.pulls.get = jest.fn().mockResolvedValueOnce(
    new Promise((resolve) =>
      resolve({
        data: {
          base: {
            ref: "main",
          },
        },
      }),
    ),
  );
  mockClient.pulls.get.mockResolvedValueOnce(
    new Promise((resolve) =>
      resolve({
        data: {
          base: {
            ref: "release-0.7",
          },
        },
      }),
    ),
  );
  mockClient.pulls.get.mockResolvedValueOnce(
    new Promise((resolve) =>
      resolve({
        data: {
          base: {
            ref: "main",
          },
        },
      }),
    ),
  );

  await expect(syncer.getBranchToPRIDs(mockClient, "org", "repo", [3, 5, 6])).resolves.toEqual({
    main: [3, 6],
    "release-0.7": [5],
  });
});

test("Syncer.getUpstreamRepos", async () => {
  const mockClient = jest.fn();
  mockClient.repos = jest.fn();
  mockClient.repos.listForOrg = jest.fn().mockResolvedValueOnce(
    new Promise((resolve) =>
      resolve({
        data: [{ name: "config-policy-controller" }, { name: "governance-policy-propagator" }],
      }),
    ),
  ).mockResolvedValue(
    new Promise((resolve) =>
      resolve({
        data: [],
      }),
    ),
  );

  syncer.orgs = { stolostron: { client: mockClient } };

  await syncer.getUpstreamRepos();
  expect(syncer.upstreamOrgRepos["open-cluster-management-io"]).toEqual(
    new Set(["config-policy-controller", "governance-policy-propagator"]),
  );
});

test("Syncer.getUpstreamRepos user's repos", async () => {
  const mockClient = jest.fn();
  mockClient.repos = jest.fn();
  mockClient.repos.listForOrg = jest.fn().mockResolvedValue(
    new Promise((_, reject) => {
      const err = new Error();
      err.status = 404;
      reject(err);
    }),
  );
  mockClient.repos.listForUser = jest.fn().mockResolvedValueOnce(
    new Promise((resolve) =>
      resolve({
        data: [{ name: "config-policy-controller" }, { name: "governance-policy-propagator" }],
      }),
    ),
  ).mockResolvedValue(
    new Promise((resolve) =>
      resolve({
        data: [],
      }),
    ),
  );

  syncer.orgs = { stolostron: { client: mockClient } };

  await syncer.getUpstreamRepos();
  expect(syncer.upstreamOrgRepos["open-cluster-management-io"]).toEqual(
    new Set(["config-policy-controller", "governance-policy-propagator"]),
  );
});

test("Syncer.handleForkedBranch blocked PR", async () => {
  const db = syncer.db as Database;

  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  const pendingPR: PendingPR = {
    repo: repo,
    upstreamRepo: upstreamRepo,
    branch: "release-2.5",
    action: PRAction.Blocked,
    githubIssue: 3,
    upstreamPRIDs: [7, 8, 9],
    prID: null,
  };
  await db.setPendingPR(pendingPR);

  await expect(
    syncer.handleForkedBranch(
      "stolostron",
      "open-cluster-management-io",
      "config-policy-controller",
      "release-2.5",
      "main",
    ),
  ).resolves.not.toThrow();
});

test("Syncer.handleForkedBranch not handled before", async () => {
  syncer.orgs = { stolostron: {} };
  syncer.getLatestPRID = jest.fn().mockResolvedValue(3);

  await expect(
    syncer.handleForkedBranch(
      "stolostron",
      "open-cluster-management-io",
      "config-policy-controller",
      "release-2.5",
      "main",
    ),
  ).resolves.not.toThrow();

  const db = syncer.db as Database;
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");

  await expect(db.getLastHandledPR(repo, upstreamRepo, "release-2.5")).resolves.toEqual(3);
});

test("Syncer.handleForkedBranch not handled before and no PRs yet in upstream", async () => {
  syncer.orgs = { stolostron: {} };
  syncer.getLatestPRID = jest.fn().mockResolvedValue(null);

  await expect(
    syncer.handleForkedBranch(
      "stolostron",
      "open-cluster-management-io",
      "config-policy-controller",
      "release-2.5",
      "main",
    ),
  ).resolves.not.toThrow();

  const db = syncer.db as Database;
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");

  await expect(db.getLastHandledPR(repo, upstreamRepo, "release-2.5")).resolves.toEqual(0);
});

test("Syncer.handleForkedBranch no new PRs", async () => {
  syncer.orgs = { stolostron: {} };
  syncer.getMergedPRIDs = jest.fn().mockResolvedValue([]);

  const db = syncer.db as Database;
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setLastHandledPR(repo, upstreamRepo, "release-2.5", 3);

  await expect(
    syncer.handleForkedBranch(
      "stolostron",
      "open-cluster-management-io",
      "config-policy-controller",
      "release-2.5",
      "main",
    ),
  ).resolves.not.toThrow();

  await expect(db.getPendingPR(repo, upstreamRepo, "release-2.5")).resolves.toBeNull();
});

test("Syncer.handleForkedBranch no new PRs for the stolostron branch", async () => {
  syncer.orgs = { stolostron: {} };
  syncer.getMergedPRIDs = jest.fn().mockResolvedValue([4, 5]);
  syncer.getBranchToPRIDs = jest.fn().mockResolvedValue({ dev: [4, 5] });

  const db = syncer.db as Database;
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setLastHandledPR(repo, upstreamRepo, "release-2.5", 3);

  await expect(
    syncer.handleForkedBranch(
      "stolostron",
      "open-cluster-management-io",
      "config-policy-controller",
      "release-2.5",
      "main",
    ),
  ).resolves.not.toThrow();

  await expect(db.getPendingPR(repo, upstreamRepo, "release-2.5")).resolves.toBeNull();
});

test("Syncer.handleForkedBranch existing unmerged PR already covers all merged upstream PRs", async () => {
  syncer.orgs = { stolostron: {} };
  syncer.getMergedPRIDs = jest.fn().mockResolvedValue([4, 5]);
  syncer.getBranchToPRIDs = jest.fn().mockResolvedValue({ main: [4, 5] });

  const db = syncer.db as Database;
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setLastHandledPR(repo, upstreamRepo, "release-2.5", 3);

  const pendingPR: PendingPR = {
    repo: repo,
    upstreamRepo: upstreamRepo,
    branch: "release-2.5",
    action: PRAction.Created,
    githubIssue: null,
    upstreamPRIDs: [4, 5],
    prID: 4,
  };
  await db.setPendingPR(pendingPR);

  await expect(
    syncer.handleForkedBranch(
      "stolostron",
      "open-cluster-management-io",
      "config-policy-controller",
      "release-2.5",
      "main",
    ),
  ).resolves.not.toThrow();
});

test("Syncer.handleForkedBranch close existing PR but already closed", async () => {
  syncer.orgs = { stolostron: {} };
  syncer.getMergedPRIDs = jest.fn().mockResolvedValue([4, 5]);
  syncer.getBranchToPRIDs = jest.fn().mockResolvedValue({ main: [4, 5] });
  syncer.closePR = jest.fn().mockResolvedValue(false);

  const db = syncer.db as Database;
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setLastHandledPR(repo, upstreamRepo, "release-2.5", 3);

  const pendingPR: PendingPR = {
    repo: repo,
    upstreamRepo: upstreamRepo,
    branch: "release-2.5",
    action: PRAction.Created,
    githubIssue: null,
    upstreamPRIDs: [4],
    prID: 4,
  };
  await db.setPendingPR(pendingPR);

  await expect(
    syncer.handleForkedBranch(
      "stolostron",
      "open-cluster-management-io",
      "config-policy-controller",
      "release-2.5",
      "main",
    ),
  ).resolves.not.toThrow();
  await expect(db.getPendingPR(repo, upstreamRepo, "release-2.5")).resolves.toBeTruthy();
});

test("Syncer.handleForkedBranch close existing PR and open new PR", async () => {
  syncer.orgs = { stolostron: { client: jest.fn() } };
  syncer.orgs.stolostron.client = jest.fn();
  syncer.orgs.stolostron.client.pulls = jest.fn();
  syncer.orgs.stolostron.client.pulls.create = jest.fn().mockReturnValue({ data: { number: 8 } });
  syncer.getMergedPRIDs = jest.fn().mockResolvedValue([4, 5]);
  syncer.getBranchToPRIDs = jest.fn().mockResolvedValue({ main: [4, 5] });
  syncer.closePR = jest.fn().mockResolvedValue(true);
  syncer.getPRPatchLocations = jest.fn().mockResolvedValue([
    { head: "79bf6a3d414f4ff08fb726fc60f641e9bd60a025", numCommits: 2 },
    { head: "b6d3319c0383b929bb05da90add55a07f3f75660", numCommits: 1 },
  ]);
  syncer.getToken = jest.fn().mockResolvedValue("secret token");

  const db = syncer.db as Database;
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setLastHandledPR(repo, upstreamRepo, "release-2.5", 3);

  const mockPendingPR: PendingPR = {
    repo: repo,
    upstreamRepo: upstreamRepo,
    branch: "release-2.5",
    action: PRAction.Created,
    githubIssue: null,
    upstreamPRIDs: [4],
    prID: 4,
  };
  await db.setPendingPR(mockPendingPR);

  await expect(
    syncer.handleForkedBranch(
      "stolostron",
      "open-cluster-management-io",
      "config-policy-controller",
      "release-2.5",
      "main",
    ),
  ).resolves.not.toThrow();
  const pendingPR = await db.getPendingPR(repo, upstreamRepo, "release-2.5");
  expect(pendingPR?.prID).toEqual(8);
  expect(pendingPR?.upstreamPRIDs).toEqual([4, 5]);
});

test("Syncer.handleForkedBranch merge PR right away", async () => {
  (getRequiredChecks as jest.Mock).mockImplementation(async () => new Set<string>());

  syncer.orgs = { stolostron: { client: jest.fn() } };
  syncer.orgs.stolostron.client = jest.fn();
  syncer.orgs.stolostron.client.pulls = jest.fn();
  syncer.orgs.stolostron.client.pulls.create = jest
    .fn()
    .mockReturnValue({ data: { head: { sha: "dfg3319c0383b929bb05da90add55a07f3f756677" }, number: 8 } });
  syncer.getMergedPRIDs = jest.fn().mockResolvedValue([4, 5]);
  syncer.getBranchToPRIDs = jest.fn().mockResolvedValue({ main: [4, 5] });
  syncer.closePR = jest.fn().mockResolvedValue(true);
  syncer.getPRPatchLocations = jest.fn().mockResolvedValue([
    { head: "79bf6a3d414f4ff08fb726fc60f641e9bd60a025", numCommits: 2 },
    { head: "b6d3319c0383b929bb05da90add55a07f3f75660", numCommits: 1 },
  ]);
  syncer.getToken = jest.fn().mockResolvedValue("secret token");

  const db = syncer.db as Database;
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setLastHandledPR(repo, upstreamRepo, "release-2.5", 3);

  await expect(
    syncer.handleForkedBranch(
      "stolostron",
      "open-cluster-management-io",
      "config-policy-controller",
      "release-2.5",
      "main",
    ),
  ).resolves.not.toThrow();
  expect((mergePR as jest.Mock).mock.calls.length).toBe(1);
});

test("Syncer.handleForkedBranch merge conflict on patch", async () => {
  syncer.orgs = { stolostron: {} };
  syncer.getMergedPRIDs = jest.fn().mockResolvedValue([4]);
  syncer.getBranchToPRIDs = jest.fn().mockResolvedValue({ main: [4] });
  syncer.getPRPatchLocations = jest
    .fn()
    .mockResolvedValue([{ head: "79bf6a3d414f4ff08fb726fc60f641e9bd60a025", numCommits: 2 }]);
  syncer.getToken = jest.fn().mockResolvedValue("secret token");
  (applyPatches as jest.Mock).mockImplementation(
    () =>
      new Promise<bool>((_, reject) => {
        reject(new Error("some error"));
      }),
  );

  const db = syncer.db as Database;
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setLastHandledPR(repo, upstreamRepo, "release-2.5", 3);

  await expect(
    syncer.handleForkedBranch(
      "stolostron",
      "open-cluster-management-io",
      "config-policy-controller",
      "release-2.5",
      "main",
    ),
  ).resolves.not.toThrow();
  const pendingPR = await db.getPendingPR(repo, upstreamRepo, "release-2.5");
  expect(pendingPR?.prID).toBeNull();
  expect(pendingPR?.githubIssue).toEqual(8);
});

test("Syncer.init", async () => {
  config.dbPath = path.join(dirObj.name, "init-test.db");
  const syncer = new Syncer(config);
  const mockAppClient = jest.fn();
  mockAppClient.apps = jest.fn();
  mockAppClient.apps.listInstallations = jest.fn().mockResolvedValueOnce({
    data: [
      { account: { login: "stolostron" }, id: 1 },
      { account: { login: "tom-hanks" }, id: 2 },
    ],
  });

  const mockInstallationClient1 = jest.fn();
  mockInstallationClient1.apps = jest.fn();
  mockInstallationClient1.apps.listReposAccessibleToInstallation = jest.fn().mockResolvedValueOnce({
    data: { repositories: [{ name: "config-policy-controller" }, { name: "governance-policy-propagator" }] },
  });

  const mockInstallationClient2 = jest.fn();
  mockInstallationClient2.apps = jest.fn();
  mockInstallationClient2.apps.listReposAccessibleToInstallation = jest.fn().mockResolvedValueOnce({
    data: { repositories: [{ name: "Toy Story" }, { name: "The Money Pit" }] },
  });

  syncer.getGitHubClient = jest.fn((installationID?: number) => {
    if (installationID === 1) {
      return mockInstallationClient1;
    }

    if (installationID === 2) {
      return mockInstallationClient2;
    }

    return mockAppClient;
  });

  syncer.getUpstreamRepos = jest.fn();

  await syncer.init();

  expect(syncer.db).not.toBeUndefined();
  expect(Object.keys(syncer.orgs).length).toBe(2);
  expect(syncer.orgs.stolostron.repos).toEqual(new Set(["config-policy-controller", "governance-policy-propagator"]));
  expect(syncer.orgs["tom-hanks"].repos).toEqual(new Set(["Toy Story", "The Money Pit"]));
});

test("Syncer.run", async () => {
  syncer.init = jest.fn().mockResolvedValue();
  syncer.handleForkedBranch = jest.fn().mockResolvedValue();
  syncer.orgs = {
    stolostron: { repos: new Set(["config-policy-controller", "governance-policy-propagator", "star-wars-quotes"]) },
  };
  syncer.upstreamOrgRepos = {
    "open-cluster-management-io": new Set(["config-policy-controller", "governance-policy-propagator", "yoda-quotes"]),
  };

  await syncer.run();

  expect(syncer.handleForkedBranch.mock.calls.length).toBe(4);
  expect(syncer.handleForkedBranch).toHaveBeenCalledWith(
    "stolostron",
    "open-cluster-management-io",
    "config-policy-controller",
    "release-2.5",
    "main",
  );
  expect(syncer.handleForkedBranch).toHaveBeenCalledWith(
    "stolostron",
    "open-cluster-management-io",
    "config-policy-controller",
    "release-2.4",
    "release-0.6",
  );
  expect(syncer.handleForkedBranch).toHaveBeenCalledWith(
    "stolostron",
    "open-cluster-management-io",
    "governance-policy-propagator",
    "release-2.5",
    "main",
  );
  expect(syncer.handleForkedBranch).toHaveBeenCalledWith(
    "stolostron",
    "open-cluster-management-io",
    "governance-policy-propagator",
    "release-2.4",
    "release-0.6",
  );
});

test("Syncer.run one failure", async () => {
  syncer.init = jest.fn().mockResolvedValue();
  syncer.handleForkedBranch = jest.fn((_, __, repoName: string, branch: string) => {
    return new Promise((resolve, reject) => {
      if (repoName === "config-policy-controller" && branch === "release-2.5") {
        reject(new Error("some error"));
      } else {
        resolve();
      }
    });
  });
  syncer.orgs = {
    stolostron: { repos: new Set(["config-policy-controller", "governance-policy-propagator", "star-wars-quotes"]) },
  };
  syncer.upstreamOrgRepos = {
    "open-cluster-management-io": new Set(["config-policy-controller", "governance-policy-propagator", "yoda-quotes"]),
  };

  await syncer.run();

  expect(syncer.handleForkedBranch.mock.calls.length).toBe(4);
});
