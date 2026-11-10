import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/** A hash of the server bundle, so a response says which build answered. */
export const BUILD_ID = (() => {
  try {
    return createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
})();

/** Generated when the instance loads, so a response says which instance answered. */
export const INSTANCE_ID = randomUUID().slice(0, 8);
export const STARTED_AT = new Date();
