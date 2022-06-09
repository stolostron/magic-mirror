import fs from "fs";

import { Config, loadConfig, validateConfig } from "./config";

let config: Config;

beforeEach(() => {
  config = {
    appID: 2,
    logLevel: "debug",
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
});

test("loadConfig local config.json", () => {
  const mockFsExistsSync = jest.spyOn(fs, "existsSync");
  mockFsExistsSync.mockImplementation((path: fs.PathLike) => path == "config.json");
  const mockFsreadFileSync = jest.spyOn(fs, "readFileSync");
  mockFsreadFileSync.mockImplementation(() => JSON.stringify(config));

  expect(loadConfig()).toEqual(config);
});

test("loadConfig production config.json", () => {
  const mockFsExistsSync = jest.spyOn(fs, "existsSync");
  mockFsExistsSync.mockImplementation((path: fs.PathLike) => path == "/etc/magic-mirror/config.json");
  const mockFsreadFileSync = jest.spyOn(fs, "readFileSync");
  mockFsreadFileSync.mockImplementation(() => JSON.stringify(config));

  expect(loadConfig()).toEqual(config);
});

test("loadConfig does not exist", () => {
  const mockFsExistsSync = jest.spyOn(fs, "existsSync");
  mockFsExistsSync.mockImplementation(() => false);

  expect(loadConfig).toThrowError();
});

test("validateConfig", () => {
  expect(() => validateConfig(config)).not.toThrowError();
});

test("validateConfig invalid appID", () => {
  // @ts-expect-error
  config.appID = null;
  expect(() => validateConfig(config)).toThrowError('The configuration\'s "appID" must be set as a number');
});

test("validateConfig invalid logLevel", () => {
  // @ts-expect-error
  config.logLevel = 123;
  expect(() => validateConfig(config)).toThrowError('The configuration\'s optional "logLevel" must be a string');
});

test("validateConfig invalid privateKeyPath type", () => {
  // @ts-expect-error
  config.privateKeyPath = 123;
  expect(() => validateConfig(config)).toThrowError('The configuration\'s "privateKeyPath" must be a string');
});

test("validateConfig invalid privateKeyPath path", () => {
  config.privateKeyPath = "/this/does/not/exist";
  expect(() => validateConfig(config)).toThrowError(
    'The configuration\'s "privateKeyPath" must be a valid path to a file that exists',
  );
});

test("validateConfig upstreamMappings not set", () => {
  // @ts-expect-error
  config.upstreamMappings = undefined;
  expect(() => validateConfig(config)).toThrowError('The configuration\'s "upstreamMappings" must be a valid object');
});

test("validateConfig upstreamMappings wrong type", () => {
  // @ts-expect-error
  config.upstreamMappings = "some mapping";
  expect(() => validateConfig(config)).toThrowError('The configuration\'s "upstreamMappings" must be a valid object');
});

test("validateConfig upstreamMappings wrong type", () => {
  // @ts-expect-error
  config.upstreamMappings = "some mapping";
  expect(() => validateConfig(config)).toThrowError('The configuration\'s "upstreamMappings" must be a valid object');
});

test("validateConfig upstreamMappings.targetOrg wrong type", () => {
  // @ts-expect-error
  config.upstreamMappings.targetOrg = 123;
  expect(() => validateConfig(config)).toThrowError(
    'The configuration\'s upstreamMappings["targetOrg"] must be a valid object',
  );
});

test("validateConfig upstreamMappings.targetOrg.upstreamOrg wrong type", () => {
  // @ts-expect-error
  config.upstreamMappings.targetOrg = { upstreamOrg: 123 };
  expect(() => validateConfig(config)).toThrowError(
    'The configuration\'s upstreamMappings["targetOrg"]["upstreamOrg"] must be a valid object',
  );
});

test("validateConfig upstreamMappings.targetOrg.upstreamOrg.branchMappings wrong type", () => {
  // @ts-expect-error
  config.upstreamMappings.targetOrg = { upstreamOrg: { branchMappings: 123 } };
  expect(() => validateConfig(config)).toThrowError(
    'The configuration\'s upstreamMappings["targetOrg"]["upstreamOrg"]["branchMappings"] must be a valid object',
  );
});

test("validateConfig upstreamMappings.targetOrg.upstreamOrg.branchMappings.upstreamBranch empty string", () => {
  config.upstreamMappings.targetOrg = { upstreamOrg: { branchMappings: { upstreamBranch: "" } } };
  expect(() => validateConfig(config)).toThrowError(
    'The configuration\'s upstreamMappings["targetOrg"]["upstreamOrg"]["branchMappings"]["upstreamBranch"] ' +
      "must be a non-empty string",
  );
});

test("validateConfig upstreamMappings.targetOrg.upstreamOrg.branchMappings.upstreamBranch wrong type", () => {
  // @ts-expect-error
  config.upstreamMappings.targetOrg = { upstreamOrg: { branchMappings: { upstreamBranch: 123 } } };
  expect(() => validateConfig(config)).toThrowError(
    'The configuration\'s upstreamMappings["targetOrg"]["upstreamOrg"]["branchMappings"]["upstreamBranch"] ' +
      "must be a non-empty string",
  );
});

test("validateConfig upstreamMappings.targetOrg.upstreamOrg.branchMappings duplicate target branch", () => {
  config.upstreamMappings.targetOrg = {
    upstreamOrg: { branchMappings: { upstreamBranch: "main", otherUpstreamBranch: "main" } },
  };
  expect(() => validateConfig(config)).toThrowError(
    'The configuration\'s upstreamMappings["targetOrg"]["upstreamOrg"]["branchMappings"] contains duplicate ' +
      "target branches",
  );
});
