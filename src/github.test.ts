import { createFailureIssue } from "./github";

test("createFailureIssue", () => {
  const mockClient = {
    issues: {
      create: jest.fn(() => {
        return new Promise((resolve) => {
          resolve({
            data: { number: 6 },
          });
        });
      }),
    },
  };

  expect(
    // @ts-ignore
    createFailureIssue(mockClient, "kramerica", "industries", "upstream", "main", [5, 7], "it failed"),
  ).resolves.toEqual(6);

  expect(mockClient.issues.create.mock.calls.length).toEqual(1);

  const expectedIssueArgs = {
    body:
      "🪞 Magic Mirror 🪞 failed to sync the following upstream pull-requests because it failed:\n" +
      "* upstream/industries#5\n* upstream/industries#7\n\n" +
      "Syncing is paused for the branch main on kramerica/industries until the issue is manually resolved and this " +
      "issue is closed.\n\n" +
      "![sad Yoda](https://media.giphy.com/media/3o7qDK5J5Uerg3atJ6/giphy.gif)",
    owner: "kramerica",
    repo: "industries",
    title: "😿 Failed to sync the upstream PRs: #5, #7",
  };
  expect(mockClient.issues.create).toHaveBeenCalledWith(expectedIssueArgs);
});

test("createFailureIssue with prID", () => {
  const mockClient = {
    issues: {
      create: jest.fn(() => {
        return new Promise((resolve) => {
          resolve({
            data: { number: 6 },
          });
        });
      }),
    },
  };

  expect(
    // @ts-ignore
    createFailureIssue(mockClient, "kramerica", "industries", "upstream", "main", [5, 7], "it failed", 3),
  ).resolves.toEqual(6);

  expect(mockClient.issues.create.mock.calls.length).toEqual(1);

  const expectedIssueArgs = {
    body:
      "🪞 Magic Mirror 🪞 failed to sync the following upstream pull-requests because it failed:\n" +
      "* upstream/industries#5\n* upstream/industries#7\n\n" +
      "Syncing is paused for the branch main on kramerica/industries until the issue is manually resolved and this " +
      "issue is closed.\n\n" +
      "![sad Yoda](https://media.giphy.com/media/3o7qDK5J5Uerg3atJ6/giphy.gif)\n\n" +
      "The pull-request (#3) can reviewed for more information.",
    owner: "kramerica",
    repo: "industries",
    title: "😿 Failed to sync the upstream PRs: #5, #7",
  };
  expect(mockClient.issues.create).toHaveBeenCalledWith(expectedIssueArgs);
});
