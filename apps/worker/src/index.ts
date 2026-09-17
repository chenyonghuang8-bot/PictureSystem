import pino from "pino";
import { createLoggerOptions, loadWorkerEnv } from "@family-album/config";

const env = loadWorkerEnv();
const logger = pino(createLoggerOptions());

logger.info(
  { appEnv: env.APP_ENV, service: "worker" },
  "Worker skeleton ready",
);
