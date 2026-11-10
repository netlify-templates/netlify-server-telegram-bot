import { getContext } from "@netlify/server";

/**
 * Only the published production deploy acts: ingests, claims runs, sends
 * deliveries. An old deploy's permalink reaches the same database with old
 * code, so everything that changes state or sends something checks this first.
 * `netlify dev` sets LOCAL_MODE=1 and uses its own local database.
 *
 * Gate on `published`, never on the context name: a published draft still says
 * "deploy-preview".
 */
export function isLiveDeploy(): boolean {
  if (process.env.LOCAL_MODE === "1") return true;
  try {
    return getContext().deploy.published === true;
  } catch {
    return false;
  }
}
