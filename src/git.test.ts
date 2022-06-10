import fs from "fs";
import path from "path";

import simpleGit, { SimpleGit } from "simple-git";
import tmp from "tmp";

import { applyPatches } from "./git";

let dirObj: tmp.DirResult;
let gitObj: SimpleGit;

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
});

afterEach(() => {
  dirObj.removeCallback();
});

test("applyPatches with two valid patches and an empty patch", async () => {
  const patches = [
    `
From d09f72f1d6729528c62bc0df5a70d635d47907bb Mon Sep 17 00:00:00 2001
From: mprahl <mprahl@users.noreply.github.com>
Date: Wed, 1 Jun 2022 10:39:29 -0400
Subject: [PATCH] Add the state to the message

---
 message.txt | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/message.txt b/message.txt
index 1bfd7cc..382ca18 100644
--- a/message.txt
+++ b/message.txt
@@ -1 +1 @@
-Hello Raleigh!
+Hello Raleigh, NC!
-- 
2.35.3
    `,
    `
From f4daacd4a0c9c2a8cf12b64ddf77c4302e628917 Mon Sep 17 00:00:00 2001
From: mprahl <mprahl@users.noreply.github.com>
Date: Wed, 1 Jun 2022 10:43:47 -0400
Subject: [PATCH] Add the country to the message

---
 message.txt | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/message.txt b/message.txt
index 382ca18..cea7f00 100644
--- a/message.txt
+++ b/message.txt
@@ -1 +1 @@
-Hello Raleigh, NC!
+Hello Raleigh, NC, USA!
-- 
2.35.3
    `,
    "",
  ];

  expect(await applyPatches("file://" + dirObj.name, "main", "main-with-patch", patches)).toBe(true);
  await gitObj.checkout("main-with-patch").then(() => {
    const textOutput = fs.readFileSync(path.join(dirObj.name, "message.txt"));
    expect(textOutput.toString()).toEqual("Hello Raleigh, NC, USA!\n");
  });
});

test("applyPatches with a patch that doesn't change the Git history", async () => {
  fs.writeFileSync(path.join(dirObj.name, "message.txt"), "Hello\nRaleigh, NC!\n");
  await gitObj.add("message.txt").commit("Add the state");

  const patch = await gitObj.raw(["format-patch", "HEAD~1", "--stdout"]);

  expect(await applyPatches("file://" + dirObj.name, "main", "main-with-patch", [patch])).toBe(false);
});

test("applyPatches invalid patch", async () => {
  const patches = [
    `
From f4daacd4a0c9c2a8cf12b64ddf77c4302e628917 Mon Sep 17 00:00:00 2001
From: mprahl <mprahl@users.noreply.github.com>
Date: Wed, 1 Jun 2022 10:43:47 -0400
Subject: [PATCH] Add the country to the message

---
 message.txt | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/message.txt b/message.txt
index 382ca18..cea7f00 100644
--- a/message.txt
+++ b/message.txt
@@ -1 +1 @@
-Hello Raleigh, NC!
+Hello Raleigh, NC, USA!
-- 
2.35.3
    `,
  ];

  await expect(applyPatches("file://" + dirObj.name, "main", "main-with-patch", patches)).rejects.toThrow();
});

test("applyPatches no input patches", async () => {
  await expect(applyPatches("file://" + dirObj.name, "main", "main-with-patch", [])).rejects.toThrow();
});
