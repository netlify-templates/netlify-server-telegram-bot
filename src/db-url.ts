/** Asks for full certificate checks, which is what pg does anyway, without its warning about `sslmode=require`. */
export function withVerifyFull(url: string): string {
  const u = new URL(url);
  if (u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "verify-full");
  return u.toString();
}

/**
 * Netlify Database gives the server a pooled URL (PgBouncer in transaction
 * mode). A long-lived server is better off on the direct host, which is the
 * same name without "-pooler".
 */
export function directUrl(url: string): string {
  const u = new URL(withVerifyFull(url));
  u.hostname = u.hostname.replace("-pooler.", ".");
  return u.toString();
}
