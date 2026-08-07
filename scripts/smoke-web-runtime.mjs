import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REDACTED_FIXTURE_IDS,
  createDatabaseClient,
  parseDatabaseConfig,
  runMigrations,
  seedRedactedFixtures,
} from "../packages/database/dist/index.js";
import { hashPassword } from "../packages/authorization/dist/index.js";
import { ProfileRevisionInputSchema } from "../packages/student-profiles/dist/index.js";
import { createCourse, transitionCourseVersion } from "../packages/course-planning/dist/index.js";
import {
  createRedisConnection,
  createTaskQueue,
  parseRedisUrl,
} from "../packages/tasks/dist/index.js";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = 3100;
const baseUrl = `http://127.0.0.1:${port}`;
const nextCli = resolve(rootDirectory, "apps/operations-web/node_modules/next/dist/bin/next");
const workerEntry = resolve(rootDirectory, "apps/worker/dist/index.js");
const output = [];
const workerOutput = [];
const queueName = `culiu-e2e-${randomUUID()}`;
const temporaryUserId = randomUUID();
const temporaryGrantId = randomUUID();
const temporaryAdminId = randomUUID();
const temporaryEmail = `${temporaryUserId}@example.invalid`;
const temporaryPassword = `E2e-${randomBytes(24).toString("base64url")}!9aA`;
const operationsAuthSecret =
  process.env.OPERATIONS_NEXTAUTH_SECRET ?? randomBytes(32).toString("base64url");
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
let worker;
let temporaryStorageRoot;

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
  temporaryStorageRoot = await mkdtemp(join(tmpdir(), "culiu-web-e2e-storage-"));
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
    `insert into app_user (id, email, display_name, role)
     values ($1, $2, 'Synthetic Runtime Admin', 'admin')`,
    [temporaryAdminId, `${temporaryAdminId}@example.invalid`],
  );
  await client.pool.query(
    `insert into app_user (id, email, display_name, password_hash, role)
     values ($1, $2, 'Synthetic Runtime Advisor', $3, 'advisor')`,
    [temporaryUserId, temporaryEmail, passwordHash],
  );
  await client.pool.query(
    `insert into student_authorization
     (id, user_id, student_id, allowed_actions, max_access_level, granted_by_user_id,
        valid_from)
     values ($1, $2, $3, array['student:read', 'student:write', 'student:profile:generate', 'student:profile:review', 'student:profile:approve', 'student:plan:write', 'student:plan:review', 'student:plan:approve', 'student:plan:export'], 'sensitive', $2, now() - interval '1 minute')`,
    [temporaryGrantId, temporaryUserId, REDACTED_FIXTURE_IDS.student],
  );
}

async function prepareSyntheticCourseCatalog() {
  const client = activeDatabaseClient();
  const admin = {
    displayName: "Synthetic Runtime Admin",
    email: `${temporaryAdminId}@example.invalid`,
    id: temporaryAdminId,
    role: "admin",
  };
  const courses = [];
  for (const [code, title] of [
    ["RUNTIME_FOUNDATION", "Runtime Foundation"],
    ["RUNTIME_PROJECT", "Runtime Project"],
    ["RUNTIME_EXPLORATION", "Runtime Exploration"],
  ]) {
    const created = await createCourse(client.database, admin, {
      code,
      content: {
        capabilityTags: ["synthetic_reasoning"],
        deliverables: [`${title} synthetic artifact`],
        deliveryMode: "self_paced",
        difficulty: "foundation",
        durationWeeks: 8,
        notSuitableConditions: [],
        objectives: [`Complete ${title} synthetic objective`],
        projectTypes: ["synthetic_project"],
        schedule: [],
        stage: "Synthetic runtime stage",
        subjectTags: ["synthetic_subject"],
        summary: `${title} exists only inside the disposable runtime test database.`,
        title,
        totalInstructionMinutes: 720,
        weeklyLoadMinutes: 120,
      },
    });
    const timestamp = await client.pool.query(
      "select updated_at from course_version where id = $1",
      [created.courseVersionId],
    );
    await transitionCourseVersion(client.database, admin, created.courseVersionId, {
      action: "approve",
      expectedUpdatedAt: timestamp.rows[0].updated_at.toISOString(),
    });
    courses.push(created);
  }
  return courses;
}

function runtimePlanInput(profileVersionId, claimId, courses) {
  const [foundation, project, exploration] = courses;
  return {
    content: {
      classroomProfile: {
        statement: "Synthetic approved classroom profile for runtime verification.",
        supportingClaimIds: [claimId],
      },
      decisionTimeline: [
        {
          decisionQuestion: "Which synthetic route has stronger observable engagement?",
          observableSignals: ["Completes the synthetic artifact independently"],
          period: { endDate: "2026-11-30", startDate: "2026-11-01" },
        },
      ],
      goal: "Verify the protected manual planning workflow without real student data.",
      overlapAndGaps: {
        overlap: ["Both routes observe persistence and independent completion"],
        routeAGaps: ["Needs a later structured sequence"],
        routeBGaps: ["Needs a later open project"],
      },
      period: { endDate: "2027-06-30", startDate: "2026-09-01" },
      risks: ["Synthetic runtime outcomes are not business evidence"],
      routeComparison: Array.from({ length: 6 }, (_, index) => ({
        dimension: `Runtime dimension ${String(index + 1)}`,
        routeA: `Route A runtime observation ${String(index + 1)}`,
        routeB: `Route B runtime observation ${String(index + 1)}`,
      })),
      routes: [
        {
          key: "route_a",
          name: "Synthetic project route",
          phases: [
            {
              courseVersionIds: [project.courseVersionId],
              label: "Project observation",
              period: { endDate: "2027-02-28", startDate: "2026-12-01" },
              sequence: 1,
            },
          ],
          summary: "Observe engagement through a synthetic project.",
          supportingClaimIds: [claimId],
        },
        {
          key: "route_b",
          name: "Synthetic exploration route",
          phases: [
            {
              courseVersionIds: [exploration.courseVersionId],
              label: "Exploration observation",
              period: { endDate: "2027-02-28", startDate: "2026-12-01" },
              sequence: 1,
            },
          ],
          summary: "Observe engagement through synthetic exploration.",
          supportingClaimIds: [claimId],
        },
      ],
      shortTermItems: [
        {
          courseVersionId: foundation.courseVersionId,
          expectedOutcome: "Complete one synthetic foundation artifact.",
          order: 1,
          period: { endDate: "2026-10-31", startDate: "2026-09-01" },
          reason: "The approved synthetic claim supports a short foundation trial.",
          risks: [],
          supportingClaimIds: [claimId],
        },
      ],
      title: "Synthetic protected runtime plan",
    },
    profileVersionId,
    reviewDueDate: "2027-01-31",
    studentInput: {
      ageYears: 15,
      classroomFeedback: [
        {
          statement: "Synthetic classroom feedback for runtime verification.",
          supportingClaimIds: [claimId],
        },
      ],
      completedCourseIds: [],
      constraints: ["Synthetic weekly capacity"],
      inProgressCourseVersionIds: [],
      interests: ["Synthetic project work"],
    },
  };
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
  if (temporaryStorageRoot !== undefined) {
    await rm(temporaryStorageRoot, { force: true, recursive: true });
    temporaryStorageRoot = undefined;
  }
}

function startServer() {
  const child = spawn(
    process.execPath,
    [nextCli, "start", "apps/operations-web", "-p", String(port)],
    {
      cwd: rootDirectory,
      env: {
        ...process.env,
        OPERATIONS_DATABASE_URL: temporaryDatabaseUrl.toString(),
        DATABASE_URL: temporaryDatabaseUrl.toString(),
        CULIU_GIT_COMMIT_SHA: "1".repeat(40),
        CULIU_TASK_QUEUE_NAME: queueName,
        LOCAL_STORAGE_ROOT: temporaryStorageRoot,
        OPERATIONS_NEXTAUTH_SECRET: operationsAuthSecret,
        OPERATIONS_NEXTAUTH_URL: baseUrl,
        NEXTAUTH_SECRET: operationsAuthSecret,
        NEXTAUTH_URL: baseUrl,
        NEXT_TELEMETRY_DISABLED: "1",
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output.push(chunk);
      if (output.length > 40) output.shift();
    });
  }
  return child;
}

function startWorker() {
  const child = spawn(process.execPath, [workerEntry], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      CULIU_TASK_QUEUE_NAME: queueName,
      DATABASE_URL: temporaryDatabaseUrl.toString(),
      KNOWLEDGE_STARTUP_RECONCILE_ENABLED: "false",
      LOCAL_STORAGE_ROOT: temporaryStorageRoot,
      NODE_ENV: "test",
      PROFILE_MODEL_PROVIDER: "mock",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      workerOutput.push(chunk);
      if (workerOutput.length > 40) workerOutput.shift();
    });
  }
  return child;
}

async function waitForWorker() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (worker?.exitCode !== null) {
      throw new Error(`Worker exited early.\n${workerOutput.join("")}`);
    }
    if (workerOutput.join("").includes('"service":"worker"')) return;
    await delay(500);
  }
  throw new Error(`Worker did not become ready.\n${workerOutput.join("")}`);
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

function authenticatedFetch(path, jar, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", jar.header());
  return fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "manual" });
}

try {
  await prepareTemporaryDatabase();
  await prepareTemporaryAccount();
  const syntheticCourses = await prepareSyntheticCourseCatalog();
  worker = startWorker();
  await waitForWorker();
  server = startServer();

  const healthResponse = await waitForHealth();
  const health = await healthResponse.json();
  if (health.service !== "operations-web" || health.status !== "available") {
    throw new Error("Unexpected health payload.");
  }

  const homeResponse = await fetch(`${baseUrl}/`);
  const home = await homeResponse.text();
  if (!homeResponse.ok || !home.includes("醋溜教育教务系统")) {
    throw new Error("Home page smoke test failed.");
  }

  const loginResponse = await fetch(`${baseUrl}/login`);
  const loginPage = await loginResponse.text();
  if (!loginResponse.ok || !loginPage.includes("教务系统登录")) {
    throw new Error("Login page smoke test failed.");
  }

  const protectedStudents = await fetch(`${baseUrl}/students`, { redirect: "manual" });
  if (
    protectedStudents.status !== 307 ||
    !protectedStudents.headers.get("location")?.endsWith("/login")
  ) {
    throw new Error("Unauthenticated student directory was not redirected to login.");
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
    cookie.startsWith("culiu-operations.session-token="),
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
    !studentPayload.student?.facts?.some((fact) => fact.fieldKey === "synthetic_readiness")
  ) {
    throw new Error("Authorized student detail failed.");
  }

  const evidenceForm = new FormData();
  evidenceForm.set("accessLevel", "sensitive");
  evidenceForm.set(
    "file",
    new File(["synthetic runtime evidence"], "runtime-evidence.txt", { type: "text/plain" }),
  );
  evidenceForm.set(
    "locators",
    JSON.stringify([{ locator: { field: "runtime_summary" }, locatorType: "record_field" }]),
  );
  const evidenceResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/evidence`,
    accepted.jar,
    { body: evidenceForm, method: "POST" },
  );
  const evidencePayload = await evidenceResponse.json();
  const evidenceId = evidencePayload.evidence?.id;
  const locatorId = evidencePayload.evidence?.locators?.[0]?.id;
  if (
    evidenceResponse.status !== 201 ||
    typeof evidenceId !== "string" ||
    typeof locatorId !== "string"
  ) {
    throw new Error(`Evidence upload failed (status=${String(evidenceResponse.status)}).`);
  }

  const factResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/facts`,
    accepted.jar,
    {
      body: JSON.stringify({
        accessLevel: "sensitive",
        confirmationStatus: "confirmed",
        evidenceLinks: [{ evidenceLocatorId: locatorId, relation: "supports" }],
        fieldKey: "academic.readiness",
        sourceType: "evidence",
        value: { text: "synthetic runtime readiness" },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  const factPayload = await factResponse.json();
  if (factResponse.status !== 201 || factPayload.fact?.fieldKey !== "academic.readiness") {
    throw new Error(`Student fact creation failed (status=${String(factResponse.status)}).`);
  }

  const updatedStudentResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}`,
    accepted.jar,
  );
  const updatedStudent = await updatedStudentResponse.json();
  const runtimeFact = updatedStudent.student?.facts?.find(
    (fact) => fact.fieldKey === "academic.readiness",
  );
  if (
    !updatedStudentResponse.ok ||
    runtimeFact?.evidenceLinks?.[0]?.effectiveValidationStatus !== "valid"
  ) {
    throw new Error("Created student fact was not traceable to valid evidence.");
  }

  const profileEnqueueResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/profile-drafts`,
    accepted.jar,
    { method: "POST" },
  );
  const profileEnqueuePayload = await profileEnqueueResponse.json();
  if (profileEnqueueResponse.status !== 202) {
    throw new Error(
      `Profile draft enqueue failed (status=${String(profileEnqueueResponse.status)}, error=${String(profileEnqueuePayload.error ?? "unknown")}).`,
    );
  }
  let profilePayload;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await authenticatedFetch(
      `/api/students/${REDACTED_FIXTURE_IDS.student}/profile-drafts`,
      accepted.jar,
    );
    profilePayload = await response.json();
    if (profilePayload.tasks?.[0]?.status === "succeeded") break;
    if (profilePayload.tasks?.[0]?.status === "failed") {
      throw new Error("Profile draft worker reported a failed task.");
    }
    await delay(500);
  }
  if (
    profilePayload?.tasks?.[0]?.status !== "succeeded" ||
    profilePayload.profiles?.[0]?.status !== "draft" ||
    profilePayload.profiles?.[0]?.claims?.length !== 8 ||
    JSON.stringify(profilePayload).includes("student_demo_001") ||
    JSON.stringify(profilePayload).includes("student@example.com")
  ) {
    throw new Error("Profile draft did not complete as a safe eight-section draft.");
  }

  const generatedProfile = profilePayload.profiles[0];
  const revisionBody = ProfileRevisionInputSchema.parse({
    claims: generatedProfile.claims.map(
      ({ category, confidence, evidence, informationNature, statement }, index) => ({
        category,
        confidence,
        evidence,
        informationNature,
        statement: index === 0 ? `${statement} Advisor reviewed.` : statement,
      }),
    ),
    expectedSourceUpdatedAt: generatedProfile.updatedAt,
    questionsToConfirm: [],
  });
  const revisionResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/profiles/${generatedProfile.id}/revisions`,
    accepted.jar,
    {
      body: JSON.stringify(revisionBody),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (revisionResponse.status !== 201) {
    const safeError = await revisionResponse.text();
    throw new Error(
      `Profile revision failed (status=${String(revisionResponse.status)}, body=${safeError}).`,
    );
  }
  let reviewedProfilesResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/profile-drafts`,
    accepted.jar,
  );
  let reviewedProfiles = await reviewedProfilesResponse.json();
  const revisedProfile = reviewedProfiles.profiles?.[0];
  if (revisedProfile?.version !== 2 || revisedProfile.status !== "draft") {
    throw new Error("Profile revision did not create a new draft version.");
  }
  const submitResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/profiles/${revisedProfile.id}/transitions`,
    accepted.jar,
    {
      body: JSON.stringify({ action: "submit", expectedUpdatedAt: revisedProfile.updatedAt }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (!submitResponse.ok) {
    throw new Error(`Profile submit failed (status=${String(submitResponse.status)}).`);
  }
  reviewedProfilesResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/profile-drafts`,
    accepted.jar,
  );
  reviewedProfiles = await reviewedProfilesResponse.json();
  const inReviewProfile = reviewedProfiles.profiles?.[0];
  const approveResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/profiles/${inReviewProfile.id}/transitions`,
    accepted.jar,
    {
      body: JSON.stringify({ action: "approve", expectedUpdatedAt: inReviewProfile.updatedAt }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (!approveResponse.ok) {
    throw new Error(`Profile approval failed (status=${String(approveResponse.status)}).`);
  }
  reviewedProfilesResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/profile-drafts`,
    accepted.jar,
  );
  reviewedProfiles = await reviewedProfilesResponse.json();
  if (
    reviewedProfiles.profiles?.[0]?.status !== "approved" ||
    reviewedProfiles.profiles?.[0]?.reviews?.some((review) => review.action === "approved") !== true
  ) {
    throw new Error("Profile approval was not persisted with review history.");
  }

  const approvedProfile = reviewedProfiles.profiles[0];
  const supportingClaim = approvedProfile.claims.find(
    (claim) => claim.informationNature !== "missing",
  );
  if (supportingClaim === undefined) {
    throw new Error("Approved runtime profile did not expose an evidence-backed claim.");
  }
  const unauthorizedPlanning = await fetch(
    `${baseUrl}/api/students/${REDACTED_FIXTURE_IDS.student}/plans`,
  );
  if (unauthorizedPlanning.status !== 401) {
    throw new Error("Unauthenticated planning workspace access was not blocked.");
  }
  const planningPageResponse = await authenticatedFetch(
    `/students/${REDACTED_FIXTURE_IDS.student}/planning`,
    accepted.jar,
  );
  const planningPage = await planningPageResponse.text();
  if (!planningPageResponse.ok || !planningPage.includes("人工课程规划工作台")) {
    throw new Error("Protected advisor planning page did not render.");
  }
  const createPlanResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/plans`,
    accepted.jar,
    {
      body: JSON.stringify(
        runtimePlanInput(approvedProfile.id, supportingClaim.id, syntheticCourses),
      ),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  const createPlanPayload = await createPlanResponse.json();
  const planId = createPlanPayload.plan?.id;
  if (createPlanResponse.status !== 201 || typeof planId !== "string") {
    throw new Error(`Manual plan creation failed (status=${String(createPlanResponse.status)}).`);
  }
  let planningWorkspaceResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/plans`,
    accepted.jar,
  );
  let planningWorkspace = await planningWorkspaceResponse.json();
  let runtimePlan = planningWorkspace.plans?.[0];
  if (
    !planningWorkspaceResponse.ok ||
    runtimePlan?.status !== "draft" ||
    planningWorkspace.approvedProfile?.id !== approvedProfile.id ||
    planningWorkspace.catalog?.courses?.length !== 3
  ) {
    throw new Error("Planning workspace did not return its protected profile, catalog, and draft.");
  }
  const submitPlanResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/plans/${planId}/transitions`,
    accepted.jar,
    {
      body: JSON.stringify({ action: "submit", expectedUpdatedAt: runtimePlan.updatedAt }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (!submitPlanResponse.ok) {
    throw new Error(`Manual plan submit failed (status=${String(submitPlanResponse.status)}).`);
  }
  planningWorkspaceResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/plans`,
    accepted.jar,
  );
  planningWorkspace = await planningWorkspaceResponse.json();
  runtimePlan = planningWorkspace.plans?.[0];
  const approvePlanResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/plans/${planId}/transitions`,
    accepted.jar,
    {
      body: JSON.stringify({ action: "approve", expectedUpdatedAt: runtimePlan.updatedAt }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (!approvePlanResponse.ok) {
    throw new Error(`Manual plan approval failed (status=${String(approvePlanResponse.status)}).`);
  }
  const planExportResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/plans/${planId}/export`,
    accepted.jar,
  );
  const planExport = await planExportResponse.text();
  if (
    !planExportResponse.ok ||
    !planExport.includes("Synthetic protected runtime plan") ||
    !planExportResponse.headers.get("content-type")?.includes("text/markdown") ||
    !planExportResponse.headers.get("content-disposition")?.includes("attachment")
  ) {
    throw new Error("Approved plan Markdown export failed.");
  }
  const crossStudentPlan = await authenticatedFetch(
    `/api/students/${randomUUID()}/plans/${planId}/transitions`,
    accepted.jar,
    {
      body: JSON.stringify({
        action: "archive",
        expectedUpdatedAt: runtimePlan.updatedAt,
        reason: "must not apply",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (crossStudentPlan.status !== 404) {
    throw new Error("Cross-student plan transition was not blocked uniformly.");
  }

  const evidenceDownload = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/evidence/${evidenceId}`,
    accepted.jar,
  );
  if (
    !evidenceDownload.ok ||
    (await evidenceDownload.text()) !== "synthetic runtime evidence" ||
    !evidenceDownload.headers.get("content-disposition")?.includes("attachment")
  ) {
    throw new Error("Protected student evidence download failed.");
  }

  const crossStudentWrite = await authenticatedFetch(
    `/api/students/${randomUUID()}/facts`,
    accepted.jar,
    {
      body: JSON.stringify({
        fieldKey: "runtime.cross_student",
        sourceType: "advisor",
        value: { text: "must not be stored" },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (
    crossStudentWrite.status !== 404 ||
    !crossStudentWrite.headers.get("cache-control")?.includes("no-store")
  ) {
    throw new Error("Cross-student fact write was not blocked uniformly.");
  }
  const crossStudentProfileTransition = await authenticatedFetch(
    `/api/students/${randomUUID()}/profiles/${revisedProfile.id}/transitions`,
    accepted.jar,
    {
      body: JSON.stringify({ action: "submit", expectedUpdatedAt: revisedProfile.updatedAt }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (crossStudentProfileTransition.status !== 404) {
    throw new Error("Cross-student profile transition was not blocked uniformly.");
  }

  const invalidateResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/evidence/${evidenceId}/invalidate`,
    accepted.jar,
    {
      body: JSON.stringify({ reason: "Synthetic runtime withdrawal" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  if (!invalidateResponse.ok) {
    throw new Error(`Evidence invalidation failed (status=${String(invalidateResponse.status)}).`);
  }
  const invalidatedStudentResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}`,
    accepted.jar,
  );
  const invalidatedStudent = await invalidatedStudentResponse.json();
  const invalidatedRuntimeFact = invalidatedStudent.student?.facts?.find(
    (fact) => fact.fieldKey === "academic.readiness",
  );
  if (invalidatedRuntimeFact?.evidenceLinks?.[0]?.effectiveValidationStatus !== "invalid") {
    throw new Error("Evidence invalidation did not propagate to the fact view.");
  }
  const invalidatedProfilesResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/profile-drafts`,
    accepted.jar,
  );
  const invalidatedProfiles = await invalidatedProfilesResponse.json();
  if (invalidatedProfiles.profiles?.[0]?.status !== "needs_review") {
    throw new Error("Evidence invalidation did not mark the approved profile for review.");
  }
  const invalidatedPlansResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/plans`,
    accepted.jar,
  );
  const invalidatedPlans = await invalidatedPlansResponse.json();
  if (
    invalidatedPlans.plans?.[0]?.status !== "needs_review" ||
    typeof invalidatedPlans.plans?.[0]?.invalidationReason !== "string"
  ) {
    throw new Error("Evidence invalidation did not propagate to the approved plan view.");
  }
  const invalidatedPlanExport = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/plans/${planId}/export`,
    accepted.jar,
  );
  if (invalidatedPlanExport.status !== 409) {
    throw new Error("An invalidated plan remained exportable.");
  }
  const invalidatedDownload = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/evidence/${evidenceId}`,
    accepted.jar,
  );
  if (invalidatedDownload.status !== 404) {
    throw new Error("Invalidated evidence remained downloadable.");
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
      crossStudentWriteStatus: crossStudentWrite.status,
      crossStudentStatus: crossStudentResponse.status,
      crossStudentProfileTransitionStatus: crossStudentProfileTransition.status,
      disabledSessionStatus: disabledSessionResponse.status,
      evidenceStatus: evidenceResponse.status,
      factStatus: factResponse.status,
      healthStatus: health.status,
      loginStatus: accepted.response.status,
      profileStatus: profilePayload.tasks[0].status,
      profileWorkflowStatus: invalidatedProfiles.profiles[0].status,
      planWorkflowStatus: invalidatedPlans.plans[0].status,
      planExportStatus: planExportResponse.status,
      crossStudentPlanStatus: crossStudentPlan.status,
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
  if (worker !== undefined) {
    worker.kill();
    await Promise.race([
      new Promise((resolveExit) => worker.once("exit", resolveExit)),
      delay(3000),
    ]);
  }
  const cleanupRedis = createRedisConnection(parseRedisUrl());
  const cleanupQueue = createTaskQueue({ connection: cleanupRedis, queueName });
  await cleanupQueue.obliterate({ force: true }).catch(() => undefined);
  await cleanupQueue.close().catch(() => undefined);
  await cleanupRedis.quit().catch(() => undefined);
  await dropTemporaryDatabase();
}
