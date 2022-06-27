import fs from "fs";
import path from "path";

import { ApplicationFunctionOptions, Probot, ProbotOctokit } from "probot";
import nock from "nock";
import request from "supertest";
import tmp from "tmp";

import { Config } from "./config";
import { Database, PRAction } from "./db";
import { app, getProbotServer } from "./web";
import checkRunCompleted from "./fixtures/check_run.completed.json";
import issueClosed from "./fixtures/issues.closed.json";
import prClosed from "./fixtures/pull_request.closed.json";
import status from "./fixtures/status.json";

let config: Config;
let db: Database;
let dirObj: tmp.DirResult;
const privateKey = fs.readFileSync(path.join(__dirname, "./fixtures/mock-cert.pem"), "utf-8");
let probot: Probot;

beforeEach(async () => {
  nock.disableNetConnect();
  // Allow localhost connections to test custom Probot routes.
  nock.enableNetConnect("127.0.0.1");

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
  probot.load((p: Probot, options: ApplicationFunctionOptions) => app(p, options, config, db));
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

test("check_run.completed no PR", async () => {
  const mock = nock("https://api.github.com");

  const checkRunNoPR = JSON.parse(JSON.stringify(checkRunCompleted));
  checkRunNoPR.check_run.pull_requests = [];

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_run", payload: checkRunNoPR });

  expect(mock.pendingMocks()).toStrictEqual([]);
});

test("check_run.completed irrelevant PR", async () => {
  const mock = nock("https://api.github.com");

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_run", payload: checkRunCompleted });

  expect(mock.pendingMocks()).toStrictEqual([]);
});

test("check_run.completed blocked PR", async () => {
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

  const mock = nock("https://api.github.com");

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_run", payload: checkRunCompleted });

  expect(mock.pendingMocks()).toStrictEqual([]);
});

test("check_run.completed irrelevant check run", async () => {
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
    .get("/repos/stolostron/config-policy-controller/branches/release-2.5")
    .reply(200, {
      protection: { enabled: true, required_status_checks: { contexts: ["Crazy long test", "dco"] } },
    });

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_run", payload: checkRunCompleted });

  expect(mock.pendingMocks()).toStrictEqual([]);
});

test("check_run.completed failed check run", async () => {
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
    .get("/repos/stolostron/config-policy-controller/branches/release-2.5")
    .reply(200, {
      protection: { enabled: true, required_status_checks: { contexts: ["KinD tests (1.17, latest)", "other test"] } },
    })
    .post("/repos/stolostron/config-policy-controller/issues", (body: any) => {
      const issueContent = body.body as string;
      expect(issueContent.includes("The pull-request (#6) can be reviewed for more information.")).toBe(true);
      expect(issueContent.includes("because the PR CI failed")).toBe(true);
      return true;
    })
    .reply(200, { number: 7 });

  const checkRunNoPR = JSON.parse(JSON.stringify(checkRunCompleted));
  checkRunNoPR.check_run.conclusion = "failure";

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_run", payload: checkRunNoPR });

  expect(mock.pendingMocks()).toStrictEqual([]);
  const updatedPendingPR = await db.getPendingPR(repo, upstreamRepo, "release-2.5");
  expect(updatedPendingPR?.githubIssue).toEqual(7);
  expect(updatedPendingPR?.action).toEqual(PRAction.Blocked);
});

test("check_run.completed failed other check run", async () => {
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
    .get("/repos/stolostron/config-policy-controller/branches/release-2.5")
    .reply(200, {
      protection: { enabled: true, required_status_checks: { contexts: ["KinD tests (1.17, latest)", "other test"] } },
    })
    .get("/repos/stolostron/config-policy-controller/commits/changes/check-runs?page=1")
    .reply(200, {
      check_runs: [
        { name: "KinD tests (1.17, latest)", conclusion: "success" },
        { name: "other test", conclusion: "failure" },
      ],
    });

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_run", payload: checkRunCompleted });

  expect(mock.pendingMocks()).toStrictEqual([]);
});

test("check_run.completed failed other commit status ", async () => {
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
    .get("/repos/stolostron/config-policy-controller/branches/release-2.5")
    .reply(200, {
      protection: { enabled: true, required_status_checks: { contexts: ["KinD tests (1.17, latest)", "dco"] } },
    })
    .get("/repos/stolostron/config-policy-controller/commits/changes/check-runs?page=1")
    .reply(200, {
      check_runs: [{ name: "KinD tests (1.17, latest)", conclusion: "success" }],
    })
    .get("/repos/stolostron/config-policy-controller/commits/changes/check-runs?page=2")
    .reply(200, { check_runs: [] })
    .get("/repos/stolostron/config-policy-controller/commits/changes/statuses?page=1")
    .reply(200, [{ context: "dco", state: "failure" }]);

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_run", payload: checkRunCompleted });

  expect(mock.pendingMocks()).toStrictEqual([]);
});

test("check_run.completed missing required check runs", async () => {
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
    .get("/repos/stolostron/config-policy-controller/branches/release-2.5")
    .reply(200, {
      protection: { enabled: true, required_status_checks: { contexts: ["KinD tests (1.17, latest)", "dco"] } },
    })
    .get("/repos/stolostron/config-policy-controller/commits/changes/check-runs?page=1")
    .reply(200, {
      check_runs: [{ name: "KinD tests (1.17, latest)", conclusion: "success" }],
    })
    .get("/repos/stolostron/config-policy-controller/commits/changes/check-runs?page=2")
    .reply(200, { check_runs: [] })
    .get("/repos/stolostron/config-policy-controller/commits/changes/statuses?page=1")
    .reply(200, [{ context: "not required", state: "success" }])
    .get("/repos/stolostron/config-policy-controller/commits/changes/statuses?page=2")
    .reply(200, []);

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_run", payload: checkRunCompleted });

  expect(mock.pendingMocks()).toStrictEqual([]);
});

test("check_run.completed merge failure", async () => {
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
    .get("/repos/stolostron/config-policy-controller/branches/release-2.5")
    .reply(200, {
      protection: { enabled: true, required_status_checks: { contexts: ["KinD tests (1.17, latest)", "dco"] } },
    })
    .get("/repos/stolostron/config-policy-controller/commits/changes/check-runs?page=1")
    .reply(200, {
      check_runs: [{ name: "KinD tests (1.17, latest)", conclusion: "success" }],
    })
    .get("/repos/stolostron/config-policy-controller/commits/changes/check-runs?page=2")
    .reply(200, { check_runs: [] })
    .get("/repos/stolostron/config-policy-controller/commits/changes/statuses?page=1")
    .reply(200, [{ context: "dco", state: "success" }])
    .get("/repos/stolostron/config-policy-controller/commits/changes/statuses?page=2")
    .reply(200, [])
    .put("/repos/stolostron/config-policy-controller/pulls/6/merge")
    .reply(400)
    .post("/repos/stolostron/config-policy-controller/issues", (body: any) => {
      const issueContent = body.body as string;
      expect(issueContent.includes("the pull-request (#6) couldn't be merged")).toBe(true);
      return true;
    })
    .reply(200, { number: 7 });

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_run", payload: checkRunCompleted });

  expect(mock.pendingMocks()).toStrictEqual([]);
  const updatedPendingPR = await db.getPendingPR(repo, upstreamRepo, "release-2.5");
  expect(updatedPendingPR?.githubIssue).toEqual(7);
  expect(updatedPendingPR?.action).toEqual(PRAction.Blocked);
});

test("check_run.completed", async () => {
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
    .get("/repos/stolostron/config-policy-controller/branches/release-2.5")
    .reply(200, {
      protection: { enabled: true, required_status_checks: { contexts: ["KinD tests (1.17, latest)", "dco"] } },
    })
    .get("/repos/stolostron/config-policy-controller/commits/changes/check-runs?page=1")
    .reply(200, {
      check_runs: [
        { name: "KinD tests (1.17, latest)", conclusion: "success" },
        { name: "Not required", conclusion: "failure" },
      ],
    })
    .get("/repos/stolostron/config-policy-controller/commits/changes/check-runs?page=2")
    .reply(200, { check_runs: [] })
    .get("/repos/stolostron/config-policy-controller/commits/changes/statuses?page=1")
    .reply(200, [
      { context: "dco", state: "success" },
      { context: "not required", state: "failure" },
    ])
    .get("/repos/stolostron/config-policy-controller/commits/changes/statuses?page=2")
    .reply(200, [])
    .put("/repos/stolostron/config-policy-controller/pulls/6/merge", (body: any) => {
      // Verify that the PR was merged
      expect(body).toMatchObject({ merge_method: "rebase", sha: "db26c3e57ca3a959ca5aad62de7213c562f8c832" });
      return true;
    })
    .reply(200);

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "check_run", payload: checkRunCompleted });

  expect(mock.pendingMocks()).toStrictEqual([]);
  // Verify that the pending PR wasn't modified. That is the responsibility of a different handler.
  expect((await db.getPendingPR(repo, upstreamRepo, "release-2.5"))?.action).toEqual(PRAction.Created);
});

test("status commit status success on PR", async () => {
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
    .get("/repos/stolostron/config-policy-controller/pulls?head=db26c3e57ca3a959ca5aad62de7213c562f8c832")
    .reply(200, [
      {
        base: {
          ref: "release-2.5",
        },
        head: {
          ref: "db26c3e57ca3a959ca5aad62de7213c562f8c832",
          sha: "db26c3e57ca3a959ca5aad62de7213c562f8c832",
        },
        number: 6,
      },
    ])
    .get("/repos/stolostron/config-policy-controller/branches/release-2.5")
    .reply(200, {
      protection: { enabled: true, required_status_checks: { contexts: ["KinD tests (1.17, latest)", "dco"] } },
    })
    .get(
      "/repos/stolostron/config-policy-controller/commits/db26c3e57ca3a959ca5aad62de7213c562f8c832/check-runs?page=1",
    )
    .reply(200, {
      check_runs: [{ name: "KinD tests (1.17, latest)", conclusion: "success" }],
    })
    .get(
      "/repos/stolostron/config-policy-controller/commits/db26c3e57ca3a959ca5aad62de7213c562f8c832/check-runs?page=2",
    )
    .reply(200, { check_runs: [] })
    .get("/repos/stolostron/config-policy-controller/commits/db26c3e57ca3a959ca5aad62de7213c562f8c832/statuses?page=1")
    .reply(200, [{ context: "dco", state: "success" }])
    .get("/repos/stolostron/config-policy-controller/commits/db26c3e57ca3a959ca5aad62de7213c562f8c832/statuses?page=2")
    .reply(200, [])
    .put("/repos/stolostron/config-policy-controller/pulls/6/merge", (body: any) => {
      // Verify that the PR was merged
      expect(body).toMatchObject({ merge_method: "rebase", sha: "db26c3e57ca3a959ca5aad62de7213c562f8c832" });
      return true;
    })
    .reply(200);

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "status", payload: status });

  expect(mock.pendingMocks()).toStrictEqual([]);
  // Verify that the pending PR wasn't modified. That is the responsibility of a different handler.
  expect((await db.getPendingPR(repo, upstreamRepo, "release-2.5"))?.action).toEqual(PRAction.Created);
});

test("status ignore pending", async () => {
  const statusPending = JSON.parse(JSON.stringify(status));
  statusPending.state = "pending";

  const mock = nock("https://api.github.com");

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "status", payload: statusPending });

  expect(mock.pendingMocks()).toStrictEqual([]);
});

test("status commit status failure on PR", async () => {
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

  const statusFailure = JSON.parse(JSON.stringify(status));
  statusFailure.state = "failure";

  const mock = nock("https://api.github.com")
    .get("/repos/stolostron/config-policy-controller/pulls?head=db26c3e57ca3a959ca5aad62de7213c562f8c832")
    .reply(200, [
      {
        base: {
          ref: "release-2.5",
        },
        head: {
          ref: "db26c3e57ca3a959ca5aad62de7213c562f8c832",
          sha: "db26c3e57ca3a959ca5aad62de7213c562f8c832",
        },
        number: 6,
      },
    ])
    .get("/repos/stolostron/config-policy-controller/branches/release-2.5")
    .reply(200, {
      protection: { enabled: true, required_status_checks: { contexts: ["KinD tests (1.17, latest)", "dco"] } },
    })
    .post("/repos/stolostron/config-policy-controller/issues", (body: any) => {
      const issueContent = body.body as string;
      expect(issueContent.includes("The pull-request (#6) can be reviewed for more information.")).toBe(true);
      expect(issueContent.includes("because the PR CI failed")).toBe(true);
      return true;
    })
    .reply(200, { number: 7 });

  // @ts-expect-error since the event JSON is incomplete
  await probot.receive({ name: "status", payload: statusFailure });

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

test("/status", async () => {
  const server = await getProbotServer(config, db);
  await request(server.expressApp).get("/status").expect("Content-Type", "text/plain; charset=utf-8").expect(200, "OK");
});
