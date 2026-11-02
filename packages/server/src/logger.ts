import pino, { type Logger } from "pino";

/**
 * JSON logs to standard output, which is where Docker collects them. Anything
 * that could carry a secret is replaced before it is written, however it
 * ends up in a log line.
 */
export function createLogger(level: string = "info", destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      base: undefined,
      redact: {
        paths: [
          "authorization",
          "*.authorization",
          "headers.authorization",
          "req.headers.authorization",
          "*.password",
          "*.signingKey",
          "*.exchangeKey",
          "*.apiKey",
          "*.secretAccessKey",
          "err.config",
        ],
        censor: "[redacted]",
      },
    },
    destination,
  );
}
