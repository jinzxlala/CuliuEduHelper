import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REDACTED_FIXTURE_IDS,
  createDatabaseClient,
  parseDatabaseConfig,
  runMigrations,
  seedRedactedFixtures,
} from "../packages/database/dist/index.js";
import { hashPassword } from "../packages/authorization/dist/index.js";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = 3100;
const baseUrl = `http://127.0.0.1:${port}`;
const nextCli = resolve(rootDirectory, "apps/web/node_modules/next/dist/bin/next");
const output = [];
const temporaryUserId = randomUUID();
const temporaryGrantId = randomUUID();
const temporaryEmail = `${temporaryUserId}@example.invalid`;
const temporaryPassword = `E2e-${randomBytes(24).toString("base64url")}!9aA`;
const baseDatabaseConfig = parseDatabaseConfig();
const temporaryDatabaseName = `culiu_e2e_${randomUUID().replaceAll("-", "")}`;
const maintenanceUrl = new URL(baseDatabaseConfig.connectionString);
maintenanceUrl.pathname = "/postgres";
maintenanceUrl.search = "";
const temporaryDatabaseUrl = new URL(baseDatabaseConfig.connectionString);
temporaryDatabaseUrl.pathname = `/${temporaryDatabaseName}`;
temporaryDatabaseUrl.search = "";
const maintenanceClient = createDatabaseClient({
  connectionString: maintenanceUrl.toString(),
  maxConnections: 1,
});
let databaseClient;
let server;

const delay = (milliseconds) =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });

class CookieJar {
  #cookies = new Map();

  capture(response) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const setCookie of setCookies) {
      const [pair] = setCookie.split(";", 1);
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value === "" || /Max-Age=0/iu.test(setCookie)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    return setCookies;
  }

  header() {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function prepareTemporaryDatabase() {
  await maintenanceClient.pool.query(`create database "${temporaryDatabaseName}"`);
  databaseClient = createDatabaseClient({
    connectionString: temporaryDatabaseUrl.toString(),
    maxConnections: 4,
  });
  await runMigrations(databaseClient);
  await seedRedactedFixtures(databaseClient.database);
}

function activeDatabaseClient() {
  if (databaseClient === undefined) {
    throw new Error("Temporary runtime database was not initialized.");
  }
  return databaseClient;
}

async function prepareTemporaryAccount() {
  const client = activeDatabaseClient();
  const passwordHash = await hashPassword(temporaryPassword);
  await client.pool.query(
    `insert into app_user (id, email, display_name, password_hash, role)
     values ($1, $2, 'Synthetic Runtime Advisor', $3, 'advisor')`,
    [temporaryUserId, temporaryEmail, passwordHash],
  );
  await client.pool.query(
    `insert into student_authorization
       (id, user_id, student_id, allowed_actions, max_access_level, granted_by_user_id,
        valid_from)
     values ($1, $2, $3, array['student:read'], 'sensitive', $2, now() - interval '1 minute')`,
    [temporaryGrantId, temporaryUserId, REDACTED_FIXTURE_IDS.student],
  );
}

async function dropTemporaryDatabase() {
  if (databaseClient !== undefined) {
    await databaseClient.close();
    databaseClient = undefined;
  }
  await maintenanceClient.pool.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
    [temporaryDatabaseName],
  );
  await maintenanceClient.pool.query(`drop database if exists "${temporaryDatabaseName}"`);
  const remaining = await maintenanceClient.pool.query(
    "select count(*)::int as count from pg_database where datname = $1",
    [temporaryDatabaseName],
  );
  if (remaining.rows[0]?.count !== 0) {
    throw new Error("Temporary runtime database was not removed.");
  }
  await maintenanceClient.close();
}

function startServer() {
  const child = spawn(process.execPath, [nextCli, "start", "apps/web", "-p", String(port)], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      DATABASE_URL: temporaryDatabaseUrl.toString(),
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? randomBytes(32).toString("base64url"),
      NEXTAUTH_URL: baseUrl,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output.push(chunk);
      if (output.length > 40) output.shift();
    });
  }
  return child;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (server?.exitCode !== null) {
      throw new Error(`Web server exited early.\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response;
    } catch {
      // The server is expected to reject connections while it starts.
    }
    await delay(500);
  }
  throw new Error(`Web server did not become ready.\n${output.join("")}`);
}

async function signIn(email, password) {
  const jar = new CookieJar();
  const csrfResponse = await fetch(`${baseUrl}/api/auth/csrf`);
  jar.capture(csrfResponse);
  const csrf = await csrfResponse.json();
  if (!csrfResponse.ok || typeof csrf.csrfToken !== "string") {
    throw new Error("Auth.js CSRF endpoint failed.");
  }
  const response = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    body: new URLSearchParams({
      callbackUrl: `${baseUrl}/students`,
      csrfToken: csrf.csrfToken,
      email,
      json: "true",
      password,
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar.header(),
    },
    method: "POST",
    redirect: "manual",
  });
  const setCookies = jar.capture(response);
  const result = await response.json();
  return { jar, response, result, setCookies };
}

function authenticatedFetch(path, jar) {
  return fetch(`${baseUrl}${path}`, { headers: { Cookie: jar.header() }, redirect: "manual" });
}

try {
  await prepareTemporaryDatabase();
  await prepareTemporaryAccount();
  server = startServer();

  const healthResponse = await waitForHealth();
  const health = await healthResponse.json();
  if (health.service !== "web" || health.status !== "available") {
    throw new Error("Unexpected health payload.");
  }

  const homeResponse = await fetch(`${baseUrl}/`);
  const home = await homeResponse.text();
  if (!homeResponse.ok || !home.includes("醋溜教育智能助手")) {
    throw new Error("Home page smoke test failed.");
  }

  const loginResponse = await fetch(`${baseUrl}/login`);
  const loginPage = await loginResponse.text();
  if (!loginResponse.ok || !loginPage.includes("内部账号登录")) {
    throw new Error("Login page smoke test failed.");
  }

  const protectedSearch = await fetch(`${baseUrl}/search?q=test`, { redirect: "manual" });
  if (
    protectedSearch.status !== 307 ||
    !protectedSearch.headers.get("location")?.endsWith("/login")
  ) {
    throw new Error("Unauthenticated search was not redirected to login.");
  }

  const unauthorizedStudent = await fetch(
    `${baseUrl}/api/students/${REDACTED_FIXTURE_IDS.student}`,
  );
  if (
    unauthorizedStudent.status !== 401 ||
    !unauthorizedStudent.headers.get("cache-control")?.includes("no-store")
  ) {
    throw new Error("Unauthenticated student API access was not blocked.");
  }

  const rejected = await signIn(temporaryEmail, "Wrong-Synthetic-Runtime-2026!");
  if (
    rejected.response.status !== 401 ||
    typeof rejected.result.url !== "string" ||
    !rejected.result.url.includes("error=CredentialsSignin")
  ) {
    throw new Error(
      `Invalid credentials were not rejected generically (status=${String(rejected.response.status)}, hasErrorUrl=${String(typeof rejected.result.url === "string" && rejected.result.url.includes("error="))}).`,
    );
  }

  const accepted = await signIn(temporaryEmail, temporaryPassword);
  if (accepted.response.status !== 200 || !accepted.result.url?.endsWith("/students")) {
    throw new Error("Valid credentials did not create a session.");
  }
  const sessionCookie = accepted.setCookies.find((cookie) =>
    cookie.startsWith("next-auth.session-token="),
  );
  if (
    sessionCookie === undefined ||
    !/HttpOnly/iu.test(sessionCookie) ||
    !/SameSite=Lax/iu.test(sessionCookie)
  ) {
    throw new Error("Session cookie is missing HttpOnly or SameSite=Lax.");
  }

  const sessionResponse = await authenticatedFetch("/api/auth/session", accepted.jar);
  const session = await sessionResponse.json();
  if (session.user?.role !== "advisor" || session.user?.id !== temporaryUserId) {
    throw new Error("Authenticated session principal is incomplete.");
  }

  const studentsResponse = await authenticatedFetch("/students", accepted.jar);
  const studentsPage = await studentsResponse.text();
  if (!studentsResponse.ok || !studentsPage.includes("student_demo_001")) {
    throw new Error(
      `Authorized student directory failed (status=${String(studentsResponse.status)}, location=${studentsResponse.headers.get("location") ?? "none"}).\n${output.join("")}`,
    );
  }

  const studentResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}`,
    accepted.jar,
  );
  const studentPayload = await studentResponse.json();
  if (
    !studentResponse.ok ||
    studentPayload.student?.publicCode !== "student_demo_001" ||
    studentPayload.student?.facts?.[0]?.fieldKey !== "synthetic_readiness"
  ) {
    throw new Error("Authorized student detail failed.");
  }

  const crossStudentResponse = await authenticatedFetch(
    `/api/students/${randomUUID()}`,
    accepted.jar,
  );
  if (crossStudentResponse.status !== 404) {
    throw new Error("Cross-student parameter tampering was not blocked.");
  }

  await activeDatabaseClient().pool.query("update app_user set active = false where id = $1", [
    temporaryUserId,
  ]);
  const disabledSessionResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}`,
    accepted.jar,
  );
  if (disabledSessionResponse.status !== 401) {
    throw new Error("A disabled account retained student API access.");
  }

  console.log(
    JSON.stringify({
      authenticatedStudentStatus: studentResponse.status,
      crossStudentStatus: crossStudentResponse.status,
      disabledSessionStatus: disabledSessionResponse.status,
      healthStatus: health.status,
      loginStatus: accepted.response.status,
      unauthenticatedStudentStatus: unauthorizedStudent.status,
    }),
  );
} finally {
  if (server !== undefined) {
    server.kill();
    await Promise.race([
      new Promise((resolveExit) => server.once("exit", resolveExit)),
      delay(3000),
    ]);
  }
  await dropTemporaryDatabase();
}
