import fs from "fs";

import { Config, loadConfig, validateConfig } from "./config";

let config: Config;

beforeEach(() => {
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
});

test("loadConfig local config.json and private key", () => {
  const expectedConfig = JSON.parse(JSON.stringify(config));
  config.privateKey = "";
  const mockFsExistsSync = jest.spyOn(fs, "existsSync");
  mockFsExistsSync.mockImplementation((path: fs.PathLike) => path == "config.json" || path == "auth.key");
  const mockFsreadFileSync = jest.spyOn(fs, "readFileSync");
  mockFsreadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
    if (path == "config.json") {
      return JSON.stringify(config);
    }

    return "some private key";
  });

  expect(loadConfig()).toEqual(expectedConfig);
});

test("loadConfig production config.json and private key", () => {
  const expectedConfig = JSON.parse(JSON.stringify(config));
  config.privateKey = "";
  const mockFsExistsSync = jest.spyOn(fs, "existsSync");
  mockFsExistsSync.mockImplementation(
    (path: fs.PathLike) => path == "/etc/magic-mirror/config.json" || path == "/etc/magic-mirror/auth.key",
  );
  const mockFsreadFileSync = jest.spyOn(fs, "readFileSync");
  mockFsreadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
    if (path == "/etc/magic-mirror/config.json") {
      return JSON.stringify(config);
    }

    return "some private key";
  });

  expect(loadConfig()).toEqual(expectedConfig);
});

test("loadConfig production config.json and private key from config path", () => {
  config.privateKeyPath = "/path/to/auth.key";
  const expectedConfig = JSON.parse(JSON.stringify(config));
  config.privateKey = "";

  const mockFsExistsSync = jest.spyOn(fs, "existsSync");
  mockFsExistsSync.mockImplementation(() => true);
  const mockFsreadFileSync = jest.spyOn(fs, "readFileSync");
  mockFsreadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
    if (path == "config.json") {
      return JSON.stringify(config);
    }

    return "some private key";
  });

  expect(loadConfig()).toEqual(expectedConfig);
});

test("loadConfig config.json does not exist", () => {
  const mockFsExistsSync = jest.spyOn(fs, "existsSync");
  mockFsExistsSync.mockImplementation(() => false);

  expect(loadConfig).toThrow("No config.json could be found");
});

test("loadConfig private key does not exist", () => {
  const mockFsExistsSync = jest.spyOn(fs, "existsSync");
  mockFsExistsSync.mockImplementation((path: fs.PathLike) => path.toString().endsWith(".json"));

  expect(loadConfig).toThrow("No auth.key could be found");
});

test("validateConfig", () => {
  expect(() => validateConfig(config)).not.toThrow();
});

test("validateConfig invalid appID", () => {
  // @ts-expect-error
  config.appID = null;
  expect(() => validateConfig(config)).toThrow('The configuration\'s "appID" must be set as a number');
});

test("validateConfig invalid logLevel", () => {
  // @ts-expect-error
  config.logLevel = 123;
  expect(() => validateConfig(config)).toThrow('The configuration\'s optional "logLevel" must be a string');
});

test("validateConfig invalid privateKeyPath type", () => {
  // @ts-expect-error
  config.privateKeyPath = 123;
  expect(() => validateConfig(config)).toThrow('The configuration\'s "privateKeyPath" must be a string');
});

test("validateConfig invalid privateKeyPath path", () => {
  config.privateKeyPath = "/this/does/not/exist";
  expect(() => validateConfig(config)).toThrow(
    'The configuration\'s "privateKeyPath" must be a valid path to a file that exists',
  );
});

test("validateConfig invalid syncInterval", () => {
  // @ts-expect-error
  config.syncInterval = "test";
  expect(() => validateConfig(config)).toThrow(
    'The configuration\'s "syncInterval" must be a number',
  );
});

test("validateConfig upstreamMappings not set", () => {
  // @ts-expect-error
  config.upstreamMappings = undefined;
  expect(() => validateConfig(config)).toThrow('The configuration\'s "upstreamMappings" must be a valid object');
});

test("validateConfig upstreamMappings wrong type", () => {
  // @ts-expect-error
  config.upstreamMappings = "some mapping";
  expect(() => validateConfig(config)).toThrow('The configuration\'s "upstreamMappings" must be a valid object');
});

test("validateConfig upstreamMappings wrong type", () => {
  // @ts-expect-error
  config.upstreamMappings = "some mapping";
  expect(() => validateConfig(config)).toThrow('The configuration\'s "upstreamMappings" must be a valid object');
});

test("validateConfig upstreamMappings.targetOrg wrong type", () => {
  // @ts-expect-error
  config.upstreamMappings.targetOrg = 123;
  expect(() => validateConfig(config)).toThrow(
    'The configuration\'s upstreamMappings["targetOrg"] must be a valid object',
  );
});

test("validateConfig upstreamMappings.targetOrg.upstreamOrg wrong type", () => {
  // @ts-expect-error
  config.upstreamMappings.targetOrg = { upstreamOrg: 123 };
  expect(() => validateConfig(config)).toThrow(
    'The configuration\'s upstreamMappings["targetOrg"]["upstreamOrg"] must be a valid object',
  );
});

test("validateConfig upstreamMappings.targetOrg.upstreamOrg.branchMappings wrong type", () => {
  // @ts-expect-error
  config.upstreamMappings.targetOrg = { upstreamOrg: { branchMappings: 123 } };
  expect(() => validateConfig(config)).toThrow(
    'The configuration\'s upstreamMappings["targetOrg"]["upstreamOrg"]["branchMappings"] must be a valid object',
  );
});

test("validateConfig upstreamMappings.targetOrg.upstreamOrg.branchMappings.upstreamBranch empty string", () => {
  config.upstreamMappings.targetOrg = { upstreamOrg: { branchMappings: { upstreamBranch: "" } } };
  expect(() => validateConfig(config)).toThrow(
    'The configuration\'s upstreamMappings["targetOrg"]["upstreamOrg"]["branchMappings"]["upstreamBranch"] ' +
      "must be a non-empty string",
  );
});

test("validateConfig upstreamMappings.targetOrg.upstreamOrg.branchMappings.upstreamBranch wrong type", () => {
  // @ts-expect-error
  config.upstreamMappings.targetOrg = { upstreamOrg: { branchMappings: { upstreamBranch: 123 } } };
  expect(() => validateConfig(config)).toThrow(
    'The configuration\'s upstreamMappings["targetOrg"]["upstreamOrg"]["branchMappings"]["upstreamBranch"] ' +
      "must be a non-empty string",
  );
});

test("validateConfig upstreamMappings.targetOrg.upstreamOrg.branchMappings duplicate target branch", () => {
  config.upstreamMappings.targetOrg = {
    upstreamOrg: { branchMappings: { upstreamBranch: "main", otherUpstreamBranch: "main" } },
  };
  expect(() => validateConfig(config)).toThrow(
    'The configuration\'s upstreamMappings["targetOrg"]["upstreamOrg"]["branchMappings"] contains duplicate ' +
      "target branches",
  );
});

test("validateConfig webhookSecret", () => {
  // @ts-expect-error
  config.webhookSecret = 123;
  expect(() => validateConfig(config)).toThrow('The configuration\'s optional "webhookSecret" must be a string');
});
