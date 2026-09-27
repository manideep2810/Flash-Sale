import { baseEnvSchema, loadEnv } from "@flash/config";
import { createLogger } from "@flash/observability";
import { SERVICE_NAME, startServer } from "./server.js";

const env = loadEnv(baseEnvSchema);
const logger = createLogger({ service: SERVICE_NAME, level: env.LOG_LEVEL });

startServer({ port: env.PORT, logger });
