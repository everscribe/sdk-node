import type { Logger } from "../event/types.js";

/** Default console-backed logger, used when no logger is supplied. */
export const consoleLogger: Logger = {
  warn(message, meta) {
    if (meta && Object.keys(meta).length > 0) {
      console.warn(`[everscribe] ${message}`, meta);
    } else {
      console.warn(`[everscribe] ${message}`);
    }
  },
  error(message, meta) {
    if (meta && Object.keys(meta).length > 0) {
      console.error(`[everscribe] ${message}`, meta);
    } else {
      console.error(`[everscribe] ${message}`);
    }
  },
};
