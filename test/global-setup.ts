import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import type { TestProject } from "vitest/node";

// The queue's tests need a real Postgres: claims race across sessions, which
// netlify dev's PGlite can't show (it runs every connection in one session).
// This starts postgres:18 in Docker, unless TEST_DATABASE_URL points at one,
// and prepares a template database with the migrations applied.

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

export const TEMPLATE = "assistant_template";

export async function applyMigrations(client: pg.Client): Promise<void> {
  const dir = join(import.meta.dirname, "..", "netlify", "database", "migrations");
  for (const name of readdirSync(dir).sort()) {
    const text = readFileSync(join(dir, name, "migration.sql"), "utf8");
    for (const statement of text.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
  }
}

async function waitForPostgres(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (err) {
      await client.end().catch(() => {});
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

export default async function setup(project: TestProject) {
  let adminUrl = process.env.TEST_DATABASE_URL;
  let container: string | undefined;
  if (!adminUrl) {
    container = execFileSync(
      "docker",
      ["run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=test", "-p", "127.0.0.1::5432", "postgres:18",
       "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "max_connections=300"],
      { encoding: "utf8" },
    ).trim();
    const port = execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).trim().split(":").pop();
    adminUrl = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  }
  await waitForPostgres(adminUrl);

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${TEMPLATE} with (force)`);
  await admin.query(`create database ${TEMPLATE}`);
  await admin.end();
  const template = new pg.Client({ connectionString: adminUrl.replace(/\/[^/]*$/, `/${TEMPLATE}`) });
  await template.connect();
  await applyMigrations(template);
  // A table for tests to count side effects in.
  await template.query("create table effects (id serial primary key, run_id integer, label text)");
  await template.end();

  project.provide("pgAdminUrl", adminUrl);
  return () => {
    if (container) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  };
}
