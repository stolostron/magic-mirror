import fs from "fs";

const DEFAULT_CONFIG_PATH = "/etc/magic-mirror/config.json";

/**
 * Config is the deserialized form of the user provided configuration.
 */
export type Config = {
  appID: number;
  dbPath?: string;
  logLevel?: string;
  privateKeyPath?: string;
  upstreamMappings: {
    // Fork organization
    [key: string]: {
      // Upstream organization
      [key: string]: {
        branchMappings: {
          // Upstream branch to Fork branch
          [key: string]: string;
        };
      };
    };
  };
};

/**
 * Load and validate the application's configuration.
 * @return {Config} the validated Config object.
 */
export function loadConfig(): Config {
  let path: string;
  if (fs.existsSync("config.json")) {
    path = "config.json";
  } else if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
    path = DEFAULT_CONFIG_PATH;
  } else {
    throw new Error("No config.json could be found");
  }

  const config = JSON.parse(fs.readFileSync(path).toString());
  validateConfig(config);

  return config;
}

/**
 * Validate the config object.
 *
 * An error is thrown if the config is invalid.
 * @param {Config} config the Config object to validate.
 */
export function validateConfig(config: Config) {
  if (!config.appID || typeof config.appID !== "number") {
    throw new Error('The configuration\'s "appID" must be set as a number');
  }

  if (config.logLevel && typeof config.logLevel !== "string") {
    throw new Error('The configuration\'s optional "logLevel" must be a string');
  }

  if (config.privateKeyPath) {
    if (typeof config.privateKeyPath !== "string") {
      throw new Error('The configuration\'s "privateKeyPath" must be a string');
    }

    if (!fs.existsSync(config.privateKeyPath)) {
      throw new Error('The configuration\'s "privateKeyPath" must be a valid path to a file that exists');
    }
  }

  if (!config.upstreamMappings || typeof config.upstreamMappings !== "object") {
    throw new Error('The configuration\'s "upstreamMappings" must be a valid object');
  }

  for (const targetOrg in config.upstreamMappings) {
    if (typeof config.upstreamMappings[targetOrg] !== "object") {
      throw new Error(`The configuration's upstreamMappings["${targetOrg}"] must be a valid object"`);
    }

    for (const upstreamOrg in config.upstreamMappings[targetOrg]) {
      if (typeof config.upstreamMappings[targetOrg][upstreamOrg] !== "object") {
        throw new Error(
          `The configuration's upstreamMappings["${targetOrg}"]["${upstreamOrg}"] must be a valid object"`,
        );
      }

      const branchMappings = config.upstreamMappings[targetOrg][upstreamOrg].branchMappings;
      if (!branchMappings || typeof branchMappings !== "object") {
        throw new Error(
          `The configuration's upstreamMappings["${targetOrg}"]["${upstreamOrg}"]["branchMappings"] must ` +
            "be a valid object",
        );
      }

      for (const upstreamBranch in branchMappings) {
        const targetBranch = branchMappings[upstreamBranch];
        if (!targetBranch || typeof targetBranch !== "string") {
          throw new Error(
            `The configuration's upstreamMappings["${targetOrg}"]["${upstreamOrg}"]["branchMappings"]` +
              `["${upstreamBranch}"] must be a non-empty string"`,
          );
        }
      }

      const targetBranches = Object.values(branchMappings);
      if (targetBranches.length != +new Set(targetBranches).size) {
        throw new Error(
          `The configuration's upstreamMappings["${targetOrg}"]["${upstreamOrg}"]["branchMappings"] contains ` +
            "duplicate target branches",
        );
      }
    }
  }
}
