import winston from "winston";

export type Logger = winston.Logger;

export interface LoggerOptions {
  service: string;
  level?: string;
}

/** Structured JSON logger; every line carries the service name so logs can be filtered centrally. */
export function createLogger({ service, level = "info" }: LoggerOptions): Logger {
  return winston.createLogger({
    level,
    defaultMeta: { service },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    ),
    transports: [new winston.transports.Console()],
  });
}
