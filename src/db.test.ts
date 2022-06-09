import fs from "fs";
import path from "path";
import tmp from "tmp";

import { Database, PRAction } from "./db";

let dirObj: tmp.DirResult;
let db: Database;

beforeEach(async () => {
  jest.restoreAllMocks();
  dirObj = tmp.dirSync({ keep: true, unsafeCleanup: true });
  db = new Database(path.join(dirObj.name, "magic-mirror.db"));
  await db.init();
});

afterEach(() => {
  dirObj.removeCallback();
});

test("Database.getOrCreateRepo", async () => {
  expect(await db.getOrCreateRepo("kramerica", "industries")).toEqual({
    id: 1,
    organization: "kramerica",
    name: "industries",
  });
});

test("Database.init invalid path", async () => {
  db = new Database("/this/does/not/exist/for/sure/syncer.db");
  await expect(db.init()).rejects.toThrow();
});

test("Database last_handled_prs table", async () => {
  const repo = await db.getOrCreateRepo("kramerica", "industries");
  const upstreamRepo = await db.getOrCreateRepo("kramerica-upstream", "industries");

  await db.setLastHandledPR(repo, upstreamRepo, "main", 2);

  expect(await db.getLastHandledPR(repo, upstreamRepo, "main")).toEqual(2);
});

test("Database last_handled_prs table not present", async () => {
  const repo = await db.getOrCreateRepo("kramerica", "industries");
  const upstreamRepo = await db.getOrCreateRepo("kramerica-upstream", "industries");

  expect(await db.getLastHandledPR(repo, upstreamRepo, "main")).toBeNull();
});

test("Database pending_prs table", async () => {
  const repo = await db.getOrCreateRepo("kramerica", "industries");
  const upstreamRepo = await db.getOrCreateRepo("kramerica-upstream", "industries");

  const pendingPR = {
    repo: repo,
    branch: "main",
    upstreamRepo: upstreamRepo,
    upstreamPRIDs: [4, 7],
    action: PRAction.Created,
    prID: 3,
    githubIssue: null,
  };

  await db.setPendingPR(pendingPR);

  let pendingPRDB = await db.getPendingPR(repo, upstreamRepo, "main");
  expect(pendingPRDB).toEqual(pendingPR);

  await db.deletePendingPR(pendingPR);

  pendingPRDB = await db.getPendingPR(repo, upstreamRepo, "main");
  expect(pendingPRDB).toBeNull();
});

test("Database.getDBPath config", () => {
  expect(Database.getDbPath({ dbPath: "/some/path" })).toEqual("/some/path");
});

test("Database.getDBPath default prod path", () => {
  const prodDBPath = "/etc/magic-mirror/magic-mirror.db";

  const fsMock = jest.spyOn(fs, "existsSync");
  fsMock.mockImplementation((path: fs.PathLike) => path == prodDBPath);

  expect(Database.getDbPath({})).toEqual(prodDBPath);
});

test("Database.getDBPath local path", () => {
  const localPath = "magic-mirror.db";

  const fsMock = jest.spyOn(fs, "existsSync");
  fsMock.mockImplementation((path: fs.PathLike) => path == localPath);

  expect(Database.getDbPath({})).toEqual(localPath);
});
