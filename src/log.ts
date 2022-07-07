import winston from "winston";

/**
 * Get a new winston logger.
 * @param {string} logLevel the log level of the logger. This defaults to "info".
 * @return {winston.Logger} the winston Logger object.
 */
export function newLogger(logLevel = "info") {
  // Log out to the console. This is suited for a containerized deployment.
  return winston.createLogger({
    level: logLevel,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.align(),
      winston.format.printf((info) => `${info.timestamp}  ${info.level}  ${info.message}`),
    ),
    transports: [new winston.transports.Console()],
  });
}
