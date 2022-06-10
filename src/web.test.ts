import fs from "fs";
import path from "path";

import { Probot, ProbotOctokit } from "probot";
import nock from "nock";
import tmp from "tmp";

import { Config } from "./config";
import { Database, PRAction } from "./db";
import { app } from "./web";
import checkSuiteCompleted from "./fixtures/check_suite.completed.json";
import issueClosed from "./fixtures/issues.closed.json";
import prClosed from "./fixtures/pull_request.closed.json";

let config: Config;
let db: Database;
let dirObj: tmp.DirResult;
const privateKey = fs.readFileSync(path.join(__dirname, "./fixtures/mock-cert.pem"), "utf-8");
let probot: Probot;

beforeEach(async () => {
  nock.disableNetConnect();

  dirObj = tmp.dirSync({ keep: true, unsafeCleanup: true });
  db = new Database(path.join(dirObj.name, "magic-mirror.db"));
  await db.init();

  config = {
    appID: 2,
    logLevel: "debug",
    privateKey: privateKey,
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

  probot = new Probot({
    appId: 123,
    privateKey,
    // disable request throttling and retries for testing
    Octokit: ProbotOctokit.defaults({
      retry: { enabled: false },
      throttle: { enabled: false },
    }),
  });
  probot.load((p: Probot) => app(p, config, db));
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();

  dirObj.removeCallback();
});

test("issues.closed ignore irrelevant comment", async () => {
  const mock = nock("https://api.github.com");

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "issues", payload: issueClosed });

  expect(mock.pendingMocks()).toStrictEqual([]);
});

test("issues.closed pending PR with issue", async () => {
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setPendingPR({
    action: PRAction.Blocked,
    branch: "release-2.5",
    githubIssue: 1,
    prID: null,
    repo,
    upstreamRepo,
    upstreamPRIDs: [2, 3],
  });
  await db.setLastHandledPR(repo, upstreamRepo, "main", 1);

  const mock = nock("https://api.github.com");
  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "issues", payload: issueClosed });

  expect(mock.pendingMocks()).toStrictEqual([]);
  // Verify the last handled PR is now the last upstream PR ID associated with the GitHub issue.
  expect(await db.getLastHandledPR(repo, upstreamRepo, "release-2.5")).toEqual(3);
  // Verify that the blocked pending PR was deleted.
  expect(await db.getPendingPR(repo, upstreamRepo, "release-2.5")).toBeNull();
});

test("issues.closed pending PR with issue and PR ID", async () => {
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setPendingPR({
    action: PRAction.Blocked,
    branch: "release-2.5",
    githubIssue: 1,
    prID: 3,
    repo,
    upstreamRepo,
    upstreamPRIDs: [2, 3],
  });
  await db.setLastHandledPR(repo, upstreamRepo, "main", 1);

  const mock = nock("https://api.github.com")
    // Test that we correctly return a test token
    .post("/app/installations/2/access_tokens")
    .reply(200, { token: "test" })
    .patch("/repos/stolostron/config-policy-controller/pulls/3", (body: any) => {
      // Verify that the patch sets the "closed" state
      expect(body).toMatchObject({ state: "closed" });
      return true;
    })
    .reply(200);
  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "issues", payload: issueClosed });

  expect(mock.pendingMocks()).toStrictEqual([]);
  // Verify the last handled PR is now the last upstream PR ID associated with the GitHub issue.
  expect(await db.getLastHandledPR(repo, upstreamRepo, "release-2.5")).toEqual(3);
  // Verify that the blocked pending PR was deleted.
  expect(await db.getPendingPR(repo, upstreamRepo, "release-2.5")).toBeNull();
});

test("check_suite.completed irrelevant PR", async () => {
  const mock = nock("https://api.github.com");

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_suite", payload: checkSuiteCompleted });

  expect(mock.pendingMocks()).toStrictEqual([]);
});

test("check_suite.completed", async () => {
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setPendingPR({
    action: PRAction.Created,
    branch: "release-2.5",
    githubIssue: null,
    prID: 6,
    repo,
    upstreamRepo,
    upstreamPRIDs: [2, 3],
  });
  await db.setLastHandledPR(repo, upstreamRepo, "main", 1);

  const mock = nock("https://api.github.com")
    .put("/repos/stolostron/config-policy-controller/pulls/6/merge", (body: any) => {
      // Verify that the PR was merged
      expect(body).toMatchObject({ merge_method: "rebase", sha: "db26c3e57ca3a959ca5aad62de7213c562f8c832" });
      return true;
    })
    .reply(200);

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_suite", payload: checkSuiteCompleted });

  expect(mock.pendingMocks()).toStrictEqual([]);
  // Verify that the pending PR wasn't modified. That is the responsibility of a different handler.
  expect((await db.getPendingPR(repo, upstreamRepo, "release-2.5"))?.action).toEqual(PRAction.Created);
});

test("check_suite.completed blocked pending PR", async () => {
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setPendingPR({
    action: PRAction.Blocked,
    branch: "release-2.5",
    githubIssue: 5,
    prID: 6,
    repo,
    upstreamRepo,
    upstreamPRIDs: [2, 3],
  });
  await db.setLastHandledPR(repo, upstreamRepo, "main", 1);

  const mock = nock("https://api.github.com");

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_suite", payload: checkSuiteCompleted });

  expect(mock.pendingMocks()).toStrictEqual([]);
});

test("check_suite.completed failure", async () => {
  const checkSuiteFailure = JSON.parse(JSON.stringify(checkSuiteCompleted));
  checkSuiteFailure.check_suite.conclusion = "failure";

  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setPendingPR({
    action: PRAction.Created,
    branch: "release-2.5",
    githubIssue: null,
    prID: 6,
    repo,
    upstreamRepo,
    upstreamPRIDs: [2, 3],
  });
  await db.setLastHandledPR(repo, upstreamRepo, "main", 1);

  const mock = nock("https://api.github.com")
    .post("/repos/stolostron/config-policy-controller/issues", (body: any) => {
      // Verify that the PR was merged
      const issueContent = body.body as string;
      expect(issueContent.includes("The pull-request (#6) can be reviewed for more information.")).toBe(true);
      expect(issueContent.includes('because the PR check suite concluded with "failure"')).toBe(true);
      return true;
    })
    .reply(200, { number: 7 });

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_suite", payload: checkSuiteFailure });

  expect(mock.pendingMocks()).toStrictEqual([]);
  // Verify that the pending PR is blocked.
  const pendingPRResult = await db.getPendingPR(repo, upstreamRepo, "release-2.5");
  expect(pendingPRResult?.action).toEqual(PRAction.Blocked);
  expect(pendingPRResult?.githubIssue).toEqual(7);
});

test("check_suite.completed no PRs on check suite", async () => {
  const checkSuiteNoPRs = JSON.parse(JSON.stringify(checkSuiteCompleted));
  checkSuiteNoPRs.check_suite.pull_requests = [];

  const mock = nock("https://api.github.com");

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_suite", payload: checkSuiteNoPRs });

  expect(mock.pendingMocks()).toStrictEqual([]);
});

test("pull_request.closed irrelevant PR", async () => {
  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "pull_request", payload: prClosed });

  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  expect(await db.getPendingPR(repo, upstreamRepo, "release-2.5")).toBe(null);
});

test("pull_request.closed pending PR with GitHub issue", async () => {
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setPendingPR({
    action: PRAction.Blocked,
    branch: "release-2.5",
    githubIssue: 7,
    prID: 6,
    repo,
    upstreamRepo,
    upstreamPRIDs: [2, 3],
  });
  await db.setLastHandledPR(repo, upstreamRepo, "main", 1);

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "pull_request", payload: prClosed });

  // Verify that nothing was done
  expect((await db.getPendingPR(repo, upstreamRepo, "release-2.5"))?.githubIssue).toEqual(7);
});

test("pull_request.closed pending PR", async () => {
  const repo = await db.getOrCreateRepo("stolostron", "config-policy-controller");
  const upstreamRepo = await db.getOrCreateRepo("open-cluster-management-io", "config-policy-controller");
  await db.setPendingPR({
    action: PRAction.Created,
    branch: "release-2.5",
    githubIssue: null,
    prID: 6,
    repo,
    upstreamRepo,
    upstreamPRIDs: [2, 3],
  });
  await db.setLastHandledPR(repo, upstreamRepo, "main", 1);

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "pull_request", payload: prClosed });

  expect(await db.getPendingPR(repo, upstreamRepo, "release-2.5")).toBe(null);
  expect(await db.getLastHandledPR(repo, upstreamRepo, "release-2.5")).toEqual(3);
});
