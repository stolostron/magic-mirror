import fs from "fs";
import path from "path";

import simpleGit, { SimpleGit } from "simple-git";
import tmp from "tmp";

import { applyPatches, patchLocation } from "./git";

let dirObj: tmp.DirResult;
let upstreamDirObj: tmp.DirResult;
let gitObj: SimpleGit;
let upstreamGitObj: SimpleGit;

beforeEach(async () => {
  dirObj = tmp.dirSync({ keep: true, unsafeCleanup: true });
  gitObj = simpleGit(dirObj.name);
  await gitObj
    .init()
    .branch(["-m", "main"])
    .then(async () => {
      fs.writeFileSync(path.join(dirObj.name, "message.txt"), "Hello Raleigh!\n");
      await gitObj.add("message.txt").commit("Add a welcome message");
    });

  upstreamDirObj = tmp.dirSync({ keep: true, unsafeCleanup: true });
  upstreamGitObj = simpleGit(upstreamDirObj.name);
  await upstreamGitObj
    .init()
    .branch(["-m", "main"])
    .then(async () => {
      fs.writeFileSync(path.join(upstreamDirObj.name, "message.txt"), "Hello Raleigh!\n");
      await upstreamGitObj.add("message.txt").commit("Add a welcome message");
    });
});

afterEach(() => {
  dirObj.removeCallback();
  upstreamDirObj.removeCallback();
});

test("applyPatches with two valid patches and an empty patch", async () => {
  const patchLocations: Array<patchLocation> = [];
  fs.writeFileSync(path.join(upstreamDirObj.name, "message.txt"), "Hello Raleigh, NC!\n");
  await upstreamGitObj.add("message.txt").commit("Add the state to the message");
  patchLocations.push({ head: await upstreamGitObj.revparse(["HEAD"]), numCommits: 1 });
  fs.writeFileSync(path.join(upstreamDirObj.name, "message.txt"), "Hello Raleigh, NC, USA!\n");
  await upstreamGitObj.add("message.txt").commit("Add the country to the message");
  fs.writeFileSync(path.join(upstreamDirObj.name, "message.txt"), "Hello Raleigh, NC, United States of America!\n");
  await upstreamGitObj.add("message.txt").commit("Spell out the country in the message");
  patchLocations.push({ head: await upstreamGitObj.revparse(["HEAD"]), numCommits: 2 });
  await upstreamGitObj.raw(["commit", "--allow-empty", "-m", "Empty commit"]);
  patchLocations.push({ head: await upstreamGitObj.revparse(["HEAD"]), numCommits: 1 });

  await expect(
    applyPatches("file://" + dirObj.name, "file://" + upstreamDirObj.name, "main", "main-with-patch", patchLocations),
  ).resolves.not.toThrowError();
  await gitObj.checkout("main-with-patch").then(() => {
    const textOutput = fs.readFileSync(path.join(dirObj.name, "message.txt"));
    expect(textOutput.toString()).toEqual("Hello Raleigh, NC, United States of America!\n");
  });
});

test("applyPatches invalid patch", async () => {
  fs.writeFileSync(path.join(dirObj.name, "message.txt"), "Hello\nRaleigh, North Carolina!\n");
  await gitObj.add("message.txt").commit("Add the state");

  fs.writeFileSync(path.join(upstreamDirObj.name, "message.txt"), "Hello\nRaleigh, NC!\n");
  await upstreamGitObj.add("message.txt").commit("Add the state");

  const patchLocations = [{ head: await upstreamGitObj.revparse(["HEAD"]), numCommits: 1 }];

  await expect(
    applyPatches("file://" + dirObj.name, "file://" + upstreamDirObj.name, "main", "main-with-patch", patchLocations),
  ).rejects.toThrow();
});

test("applyPatches no input patches", async () => {
  await expect(
    applyPatches("file://" + dirObj.name, "file://" + upstreamDirObj.name, "main", "main-with-patch", []),
  ).rejects.toThrow();
});
