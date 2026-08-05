import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DeepSeekJsonModelProvider,
  parseDeepSeekGatewayConfig,
} from "../packages/ai/dist/index.js";
import { hashPassword } from "../packages/authorization/dist/index.js";
import {
  CreateManualPlanInputSchema,
  executeCourseRecommendationTask,
  executeTimetableSolveTask,
  recommendationHash,
  solveTimetable,
} from "../packages/course-planning/dist/index.js";
import {
  REDACTED_FIXTURE_IDS,
  createDatabaseClient,
  parseDatabaseConfig,
  runMigrations,
  seedRedactedFixtures,
} from "../packages/database/dist/index.js";
import { LocalImmutableObjectStore } from "../packages/storage/dist/index.js";
import {
  executeProfileDraftTask,
  PROFILE_SYSTEM_PROMPT,
  ProfileDraftOutputSchema,
} from "../packages/student-profiles/dist/index.js";
import {
  IncrementalFactOutputSchema,
  executeBasicStudentImportTask,
  executeIncrementalStudentImportTask,
} from "../packages/student-ingest/dist/index.js";
import {
  createRedisConnection,
  createTaskQueue,
  createTaskWorker,
  parseRedisUrl,
} from "../packages/tasks/dist/index.js";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const planPath = join(rootDirectory, "docs", "test_plan_stage2.md");
const runId = `run-${new Date()
  .toISOString()
  .replace(/[-:TZ.]/gu, "")
  .slice(0, 14)}-${randomBytes(3).toString("hex")}`;
const runRoot = join(rootDirectory, "tmp", "stage2-functional", runId);
const fixtureDirectory = join(runRoot, "fixtures");
const storageRoot = join(runRoot, "objects");
const holdMode = process.argv.includes("--hold");
const keepOnFailure = process.argv.includes("--keep-on-failure");
const baseDatabaseConfig = parseDatabaseConfig();
const temporaryDatabaseName = `culiu_stage2_${randomUUID().replaceAll("-", "")}`;
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
const queueName = `culiu-stage2-${randomUUID()}`;
const configuredPort = Number.parseInt(process.env.CULIU_STAGE2_PORT ?? "", 10);
const port =
  Number.isInteger(configuredPort) && configuredPort >= 1024 && configuredPort <= 65_535
    ? configuredPort
    : 3200 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${String(port)}`;
const nextCli = resolve(rootDirectory, "apps/operations-web/node_modules/next/dist/bin/next");
const adminId = randomUUID();
const advisorId = randomUUID();
const advisorGrantId = randomUUID();
const adminEmail = process.env.CULIU_STAGE2_BROWSER_ADMIN_EMAIL ?? `${adminId}@example.invalid`;
const advisorEmail = `${advisorId}@example.invalid`;
const adminPassword =
  process.env.CULIU_STAGE2_BROWSER_ADMIN_PASSWORD ??
  `S2-Admin-${randomBytes(18).toString("base64url")}!9a`;
const advisorPassword = `S2-Advisor-${randomBytes(18).toString("base64url")}!9a`;
const nextAuthSecret = randomBytes(32).toString("base64url");
const webOutput = [];
const safeTaskStats = {
  calls: 0,
  retries: 0,
  inputTokens: 0,
  outputTokens: 0,
  incrementalSchemaIssues: [],
  profileSchemaIssues: [],
};
let databaseClient;
let redis;
let queue;
let taskWorker;
let webServer;
let stage2ModelProvider;
let stage2ObjectStore;
let failed = false;
let currentStage = "S2-00";

const delay = (milliseconds) =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sanitizeDiagnosticText(value) {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[EMAIL]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu, "[PHONE]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      "[UUID]",
    )
    .replace(/(?:sk|ds)-[A-Za-z0-9_-]{12,}/gu, "[SECRET]")
    .slice(-12_000);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const fixedDosTime = 0;
  const fixedDosDate = 33;
  for (const [name, rawContent] of files) {
    const nameBuffer = Buffer.from(name, "utf8");
    const content = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent, "utf8");
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(fixedDosTime, 10);
    local.writeUInt16LE(fixedDosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(fixedDosTime, 12);
    central.writeUInt16LE(fixedDosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function xmlEscape(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function createDocx(lines) {
  const paragraphs = lines
    .map(
      (line) =>
        `<w:p><w:r><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/></w:rPr><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`,
    )
    .join("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  return zipStore([
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    ["word/document.xml", documentXml],
  ]);
}

function csvSerialize(rows) {
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `\ufeff${rows.map((row) => row.map(escape).join(",")).join("\r\n")}\r\n`;
}

async function generateFixtures() {
  await mkdir(fixtureDirectory, { recursive: true });
  const fixtures = new Map([
    [
      "basic-students.txt",
      Buffer.from(
        "学员姓名：合成学员甲\n英文名：无\n学员年级：G7\n出生日期：2013-04-15\n就读学校：合成学校一\n家长电话：13900000001\n",
        "utf8",
      ),
    ],
    [
      "basic-students.md",
      Buffer.from(
        "# 合成学生基础信息\n\n## 学生一\n\n- 学员姓名：合成学员乙 / Bella\n- 学员年级：G6\n- 出生日期：2014-03-09\n- 就读学校：合成学校二\n- 家长电话：13900000022\n\n## 学生二\n\n- 学员姓名：合成学员丙 / Carl\n- 学员年级：G5\n- 出生日期：2015-08-21\n- 就读学校：合成学校三\n- 家长电话：13900000022\n",
        "utf8",
      ),
    ],
    [
      "basic-students.docx",
      createDocx([
        "合成学生基础信息",
        "学员姓名：合成学员甲",
        "英文名：无",
        "学员年级：G7",
        "出生日期：2013-04-15",
        "就读学校：合成学校一",
        "家长电话：13900000001",
      ]),
    ],
    [
      "basic-students.csv",
      Buffer.from(
        csvSerialize([
          ["学员姓名", "英文名", "年级", "出生日期", "就读学校", "家长电话", "备注", ""],
          [
            "合成学员戊",
            "Evan",
            "G8",
            "2012-06-18",
            "合成学校五",
            "13900000005",
            "喜欢算法，\n愿意继续练习",
            "",
          ],
        ]),
        "utf8",
      ),
    ],
    [
      "incremental-feedback.csv",
      Buffer.from(
        csvSerialize([
          ["上课时间", "课程内容反馈", "合成学员甲 G7", "诱饵学员Z G8", ""],
          [
            "2026-07-15",
            "图搜索与遍历",
            "日期：2026-07-15\n教师：合成教师A\n课程：USACO Silver\n能够解释 DFS 的递归出口，但边界检查仍需提醒。",
            "诱饵私密反馈-不得出站-OMEGA",
            "",
          ],
          [
            "2026-07-22",
            "图搜索与遍历",
            "日期：2026-07-22\n教师：合成教师A\n课程：USACO Silver\n可以独立完成连通块练习，并主动检查 visited 状态。",
            "诱饵缺席记录-不得出站-SIGMA",
            "",
          ],
        ]),
        "utf8",
      ),
    ],
    [
      "incremental-meeting.docx",
      createDocx([
        "合成家长沟通会议逐字稿",
        "会议对象：合成学员甲",
        "会议日期：2026-07-28",
        "顾问：最近两次图搜索课程中，学生已经能够独立描述 DFS 的访问顺序。",
        "家长：学生会主动检查 visited 数组，但遇到复杂边界时仍需要提醒。",
        "顾问：建议下一阶段继续安排图论练习，并观察能否独立解释递归出口。",
        "本文件只包含合成学员甲的信息，不含任何真实学生资料。",
      ]),
    ],
  ]);
  for (const [name, content] of fixtures) {
    await writeFile(join(fixtureDirectory, name), content);
  }
  const oversize = Buffer.alloc(20 * 1024 * 1024 + 1, 0x58);
  await writeFile(join(fixtureDirectory, "oversize.txt"), oversize);
  fixtures.set("oversize.txt", oversize);
  const manifest = {
    schemaVersion: "stage2-functional-fixture.v1",
    runId,
    syntheticOnly: true,
    fieldContract: [
      "identity.chinese_name",
      "identity.english_name",
      "education.grade",
      "education.school",
      "identity.birth_date",
      "contact.parent_phone",
    ],
    files: Object.fromEntries(
      [...fixtures].map(([name, content]) => [
        name,
        { sha256: sha256(content), sizeBytes: content.length },
      ]),
    ),
    forbiddenStrings: ["诱饵私密反馈-不得出站-OMEGA", "诱饵缺席记录-不得出站-SIGMA"],
  };
  await writeFile(
    join(fixtureDirectory, "fixture-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  assert(
    (await stat(join(fixtureDirectory, "oversize.txt"))).size > 20 * 1024 * 1024,
    "S2-01 oversize fixture is too small.",
  );
  assert(manifest.fieldContract.length === 6, "S2-01 field contract is incomplete.");
  return manifest;
}

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
  }

  header() {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function signIn(email, password) {
  const jar = new CookieJar();
  const csrfResponse = await fetch(`${baseUrl}/api/auth/csrf`);
  jar.capture(csrfResponse);
  const csrf = await csrfResponse.json();
  assert(csrfResponse.ok && typeof csrf.csrfToken === "string", "Auth.js CSRF failed.");
  const response = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    body: new URLSearchParams({
      callbackUrl: `${baseUrl}/students`,
      csrfToken: csrf.csrfToken,
      email,
      json: "true",
      password,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
    method: "POST",
    redirect: "manual",
  });
  jar.capture(response);
  assert(response.status === 200, `Login failed with ${String(response.status)}.`);
  return jar;
}

function authenticatedFetch(path, jar, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", jar.header());
  return fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "manual" });
}

async function prepareDatabase() {
  await maintenanceClient.pool.query(`create database "${temporaryDatabaseName}"`);
  databaseClient = createDatabaseClient({
    connectionString: temporaryDatabaseUrl.toString(),
    maxConnections: 6,
  });
  await runMigrations(databaseClient);
  await seedRedactedFixtures(databaseClient.database);
  const [adminHash, advisorHash] = await Promise.all([
    hashPassword(adminPassword),
    hashPassword(advisorPassword),
  ]);
  await databaseClient.pool.query(
    `insert into app_user (id, email, display_name, password_hash, role)
     values ($1, $2, 'Stage2 Synthetic Admin', $3, 'admin'),
            ($4, $5, 'Stage2 Synthetic Advisor', $6, 'advisor')`,
    [adminId, adminEmail, adminHash, advisorId, advisorEmail, advisorHash],
  );
  await databaseClient.pool.query(
    `insert into student_authorization
       (id, user_id, student_id, allowed_actions, max_access_level, granted_by_user_id, valid_from)
     values ($1, $2, $3,
       array['student:read','student:write','student:profile:generate','student:profile:review','student:profile:approve','student:recommendation:generate','student:recommendation:review','student:plan:write','student:plan:review','student:plan:approve','student:plan:export'],
       'sensitive', $4, now() - interval '1 minute')`,
    [advisorGrantId, advisorId, REDACTED_FIXTURE_IDS.student, adminId],
  );
}

function trackProvider(provider) {
  return {
    model: provider.model,
    async generateJson(request) {
      safeTaskStats.calls += 1;
      const result = await provider.generateJson(request);
      safeTaskStats.inputTokens += result.usage.promptTokens;
      safeTaskStats.outputTokens += result.usage.completionTokens;
      if (request.systemPrompt === PROFILE_SYSTEM_PROMPT) {
        const parsed = ProfileDraftOutputSchema.safeParse(result.json);
        safeTaskStats.profileSchemaIssues = parsed.success
          ? []
          : parsed.error.issues.slice(0, 8).map((issue) => ({
              code: issue.code,
              path: issue.path.join("."),
            }));
      }
      if (request.systemPrompt.includes("单一学生证据事实提取助手")) {
        const parsed = IncrementalFactOutputSchema.safeParse(result.json);
        safeTaskStats.incrementalSchemaIssues = parsed.success
          ? []
          : parsed.error.issues.slice(0, 8).map((issue) => ({
              code: issue.code,
              path: issue.path.join("."),
            }));
      }
      return result;
    },
  };
}

async function startStage2Worker() {
  redis ??= createRedisConnection(parseRedisUrl());
  queue ??= createTaskQueue({ connection: redis, queueName });
  stage2ModelProvider ??= trackProvider(
    new DeepSeekJsonModelProvider(parseDeepSeekGatewayConfig()),
  );
  stage2ObjectStore ??= new LocalImmutableObjectStore(storageRoot);
  const provider = stage2ModelProvider;
  const objectStore = stage2ObjectStore;
  taskWorker = createTaskWorker({
    concurrency: 1,
    connection: redis,
    queueName,
    handlers: {
      "course.recommendation.generate": async (task) => {
        if (task.taskName !== "course.recommendation.generate") throw new Error("Unexpected task.");
        return executeCourseRecommendationTask(databaseClient.database, task, provider);
      },
      "knowledge.extract": () => Promise.resolve({ skipped: true }),
      "knowledge.import": () => Promise.resolve({ skipped: true }),
      "profile.draft": async (task) => {
        if (task.taskName !== "profile.draft") throw new Error("Unexpected task.");
        return executeProfileDraftTask(databaseClient.database, task, provider);
      },
      "student.basic.extract": async (task) => {
        if (task.taskName !== "student.basic.extract") throw new Error("Unexpected task.");
        return executeBasicStudentImportTask(databaseClient.database, objectStore, provider, task);
      },
      "student.evidence.extract": async (task) => {
        if (task.taskName !== "student.evidence.extract") throw new Error("Unexpected task.");
        return executeIncrementalStudentImportTask(
          databaseClient.database,
          objectStore,
          provider,
          task,
        );
      },
      "system.probe": () => Promise.resolve({ service: "stage2-functional", status: "available" }),
      "timetable.solve": async (task) => {
        if (task.taskName !== "timetable.solve") throw new Error("Unexpected task.");
        return executeTimetableSolveTask(databaseClient.database, task);
      },
    },
  });
}

function startWebServer() {
  const child = spawn(
    process.execPath,
    [nextCli, "start", "apps/operations-web", "-p", String(port)],
    {
      cwd: rootDirectory,
      env: {
        ...process.env,
        CULIU_GIT_COMMIT_SHA: "2".repeat(40),
        CULIU_TASK_QUEUE_NAME: queueName,
        OPERATIONS_DATABASE_URL: temporaryDatabaseUrl.toString(),
        DATABASE_URL: temporaryDatabaseUrl.toString(),
        LOCAL_STORAGE_ROOT: storageRoot,
        OPERATIONS_NEXTAUTH_SECRET: nextAuthSecret,
        OPERATIONS_NEXTAUTH_URL: baseUrl,
        NEXTAUTH_SECRET: nextAuthSecret,
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
      webOutput.push(chunk);
      if (webOutput.length > 80) webOutput.shift();
    });
  }
  return child;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (webServer?.exitCode !== null) throw new Error("Stage2 Web server exited early.");
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Expected while Next.js starts.
    }
    await delay(500);
  }
  throw new Error("Stage2 Web server did not become healthy.");
}

async function s2PermissionsAndNavigation() {
  const unauthenticated = await fetch(`${baseUrl}/api/students/${REDACTED_FIXTURE_IDS.student}`);
  assert(unauthenticated.status === 401, "S2-02 unauthenticated student API was not 401.");
  const adminJar = await signIn(adminEmail, adminPassword);
  const advisorJar = await signIn(advisorEmail, advisorPassword);
  const crossStudent = await authenticatedFetch(`/api/students/${randomUUID()}`, advisorJar);
  assert(crossStudent.status === 404, "S2-02 cross-student access was not 404.");

  const blockedImport = await authenticatedFetch("/api/student-imports", advisorJar, {
    body: new FormData(),
    method: "POST",
  });
  assert(blockedImport.status === 404, "S2-02 advisor could access bulk import.");
  const blockedCourses = await authenticatedFetch("/api/courses", advisorJar, {
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert(blockedCourses.status === 404, "S2-02 advisor could maintain courses.");
  const blockedScheduling = await authenticatedFetch("/api/scheduling", advisorJar, {
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert(blockedScheduling.status === 404, "S2-02 advisor could run scheduling.");

  const pages = [
    ["/students", "学生档案"],
    ["/students/import", "批量导入学生"],
    ["/courses", "课程模板"],
    ["/scheduling", "班级与排课"],
  ];
  for (const [path, marker] of pages) {
    const response = await authenticatedFetch(path, adminJar);
    const html = await response.text();
    assert(response.ok && html.includes(marker), `S2-02 page ${path} did not render.`);
    assert(!html.includes("修改 JSON"), `S2-02 page ${path} still asks for JSON.`);
  }
  return { adminJar, advisorJar };
}

const mimeByName = {
  "basic-students.csv": "text/csv",
  "basic-students.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "basic-students.md": "text/markdown",
  "basic-students.txt": "text/plain",
  "incremental-feedback.csv": "text/csv",
  "incremental-meeting.docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "oversize.txt": "text/plain",
};

async function readImportErrorCode(batchId) {
  const result = await databaseClient.pool.query(
    "select error_code from student_import_batch where id = $1",
    [batchId],
  );
  return result.rows[0]?.error_code ?? "unknown";
}

async function uploadBasic(name, adminJar) {
  const bytes = await readFile(join(fixtureDirectory, name));
  const form = new FormData();
  form.set("file", new File([bytes], name, { type: mimeByName[name] }));
  const response = await authenticatedFetch("/api/student-imports", adminJar, {
    body: form,
    method: "POST",
  });
  const payload = await response.json();
  assert(
    response.status === 202 && typeof payload.batchId === "string",
    `S2-03 ${name} upload failed.`,
  );
  const observed = new Set([payload.status]);
  let batch;
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const statusResponse = await authenticatedFetch(
      `/api/student-imports?id=${encodeURIComponent(payload.batchId)}`,
      adminJar,
    );
    batch = await statusResponse.json();
    assert(statusResponse.ok, `S2-03 ${name} status read failed.`);
    observed.add(batch.status);
    if (batch.status === "review_ready") break;
    if (batch.status === "failed") {
      const errorCode = await readImportErrorCode(payload.batchId);
      throw new Error(`S2-03 ${name} extraction failed safely (${errorCode}).`);
    }
    await delay(100);
  }
  assert(batch?.status === "review_ready", `S2-03 ${name} did not reach review_ready.`);
  assert(observed.has("uploaded"), `S2-03 ${name} did not expose uploaded.`);
  assert(observed.has("processing"), `S2-03 ${name} did not expose processing.`);
  return batch;
}

function acceptedFields(candidate, edits = new Map(), rejectedKeys = new Set()) {
  return candidate.suggestions.map((suggestion) => ({
    decision: rejectedKeys.has(suggestion.fieldKey) ? "rejected" : "accepted",
    ...(edits.has(suggestion.fieldKey) ? { editedValue: edits.get(suggestion.fieldKey) } : {}),
    suggestionId: suggestion.id,
  }));
}

async function decideBasic(adminJar, candidate, decision, fields) {
  const response = await authenticatedFetch("/api/student-imports", adminJar, {
    body: JSON.stringify({ candidateId: candidate.id, decision, fields }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  const payload = await response.json();
  assert(response.ok, `S2-03 candidate decision ${decision} failed.`);
  return payload;
}

async function grantAdvisor(studentId) {
  await databaseClient.pool.query(
    `insert into student_authorization
       (id, user_id, student_id, allowed_actions, max_access_level, granted_by_user_id, valid_from)
     values ($1, $2, $3,
       array['student:read','student:write','student:profile:generate','student:profile:review','student:profile:approve','student:recommendation:generate','student:recommendation:review','student:plan:write','student:plan:review','student:plan:approve','student:plan:export'],
       'restricted', $4, now() - interval '1 minute')`,
    [randomUUID(), advisorId, studentId, adminId],
  );
}

async function s2BasicImports(adminJar) {
  const txt = await uploadBasic("basic-students.txt", adminJar);
  assert(txt.candidates.length === 1, "S2-03 TXT candidate count is invalid.");
  const txtCandidate = txt.candidates[0];
  const txtPhone = txtCandidate.suggestions.find(
    (suggestion) => suggestion.fieldKey === "contact.parent_phone",
  );
  assert(
    txtPhone?.proposedValue?.text === "13900000001",
    "S2-03 TXT phone placeholder was not restored locally.",
  );
  const txtEnglish = txtCandidate.suggestions.find(
    (suggestion) => suggestion.fieldKey === "identity.english_name",
  );
  assert(
    txtEnglish === undefined ||
      ["无", "none", "null"].includes(String(txtEnglish.proposedValue?.text).toLowerCase()),
    "S2-03 no-English-name handling is invalid.",
  );
  const created = await decideBasic(
    adminJar,
    txtCandidate,
    "create",
    acceptedFields(txtCandidate, new Map([["education.grade", "G7（人工复核）"]])),
  );
  assert(typeof created.studentId === "string", "S2-03 TXT did not create a student.");
  const targetStudentId = created.studentId;
  await grantAdvisor(targetStudentId);

  const duplicateDecision = await authenticatedFetch("/api/student-imports", adminJar, {
    body: JSON.stringify({
      candidateId: txtCandidate.id,
      decision: "create",
      fields: acceptedFields(txtCandidate),
    }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  assert(
    duplicateDecision.status === 409,
    "S2-03 duplicate candidate decision was not idempotently blocked.",
  );

  const markdown = await uploadBasic("basic-students.md", adminJar);
  assert(markdown.candidates.length === 2, "S2-03 Markdown candidate count is invalid.");
  const sharedPhones = markdown.candidates.map(
    (candidate) =>
      candidate.suggestions.find((suggestion) => suggestion.fieldKey === "contact.parent_phone")
        ?.proposedValue?.text,
  );
  assert(
    sharedPhones[0] !== undefined && sharedPhones[0] === sharedPhones[1],
    "S2-03 shared parent phone was not preserved as a warning condition.",
  );
  await decideBasic(
    adminJar,
    markdown.candidates[0],
    "create",
    acceptedFields(markdown.candidates[0], new Map(), new Set(["identity.english_name"])),
  );
  await decideBasic(
    adminJar,
    markdown.candidates[1],
    "rejected",
    acceptedFields(markdown.candidates[1]).map((field) => ({
      ...field,
      decision: "rejected",
    })),
  );

  const docx = await uploadBasic("basic-students.docx", adminJar);
  assert(docx.candidates.length === 1, "S2-03 DOCX candidate count is invalid.");
  assert(
    docx.candidates[0].possibleStudentId === targetStudentId,
    "S2-03 DOCX duplicate did not identify the existing student.",
  );
  const linked = await decideBasic(
    adminJar,
    docx.candidates[0],
    "link",
    acceptedFields(docx.candidates[0]),
  );
  assert(linked.studentId === targetStudentId, "S2-03 link changed the target student.");

  const csv = await uploadBasic("basic-students.csv", adminJar);
  assert(csv.candidates.length === 1, "S2-03 CSV candidate count is invalid.");
  await decideBasic(
    adminJar,
    csv.candidates[0],
    "create",
    acceptedFields(csv.candidates[0], new Map([["education.school", "合成学校五（已核对）"]])),
  );

  const facts = await databaseClient.pool.query(
    `select sf.field_key, sf.value, count(fe.student_fact_id)::int as evidence_count
       from student_fact sf
       left join fact_evidence fe on fe.student_fact_id = sf.id
      where sf.student_id = $1 and sf.valid_to is null
      group by sf.id, sf.field_key, sf.value`,
    [targetStudentId],
  );
  assert(facts.rows.length >= 5, "S2-03 target student facts are incomplete.");
  assert(
    facts.rows.every((row) => row.evidence_count > 0),
    "S2-03 an accepted fact lacks a legal evidence locator.",
  );
  return targetStudentId;
}

async function uploadIncremental(name, studentId, advisorJar, ownershipConfirmed = true) {
  const bytes = await readFile(join(fixtureDirectory, name));
  const form = new FormData();
  form.set("file", new File([bytes], name, { type: mimeByName[name] }));
  form.set("ownershipConfirmed", ownershipConfirmed ? "true" : "false");
  const response = await authenticatedFetch(`/api/students/${studentId}/imports`, advisorJar, {
    body: form,
    method: "POST",
  });
  const payload = await response.json();
  if (!response.ok) return { payload, response };
  assert(
    response.status === 202 && typeof payload.batchId === "string",
    `S2-04 ${name} upload failed.`,
  );
  const observed = new Set([payload.status]);
  let batch;
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const statusResponse = await authenticatedFetch(
      `/api/students/${studentId}/imports?id=${encodeURIComponent(payload.batchId)}`,
      advisorJar,
    );
    batch = await statusResponse.json();
    assert(statusResponse.ok, `S2-04 ${name} status read failed.`);
    observed.add(batch.status);
    if (batch.status === "review_ready") break;
    if (batch.status === "failed") {
      const errorCode = await readImportErrorCode(payload.batchId);
      const issues = safeTaskStats.incrementalSchemaIssues
        .map((issue) => `${issue.path}:${issue.code}`)
        .join(",");
      throw new Error(
        `S2-04 ${name} extraction failed safely (${errorCode};${issues || "no_schema_path"}).`,
      );
    }
    await delay(100);
  }
  assert(batch?.status === "review_ready", `S2-04 ${name} did not reach review_ready.`);
  assert(
    observed.has("uploaded") && observed.has("processing"),
    `S2-04 ${name} skipped a required visible status.`,
  );
  return { batch, payload, response };
}

async function decideIncremental(studentId, advisorJar, suggestion, decision, edits = {}) {
  const response = await authenticatedFetch(`/api/students/${studentId}/imports`, advisorJar, {
    body: JSON.stringify({
      decision,
      ...edits,
      expectedCreatedAt: suggestion.createdAt,
      suggestionId: suggestion.id,
    }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  const payload = await response.json();
  return { payload, response };
}

async function s2IncrementalImports(studentId, advisorJar) {
  const unconfirmedDocx = await uploadIncremental(
    "incremental-meeting.docx",
    studentId,
    advisorJar,
    false,
  );
  assert(
    unconfirmedDocx.response.status === 409,
    `S2-04 unconfirmed DOCX ownership returned ${String(unconfirmedDocx.response.status)}/${String(unconfirmedDocx.payload?.error ?? "unknown")}.`,
  );

  const feedback = await uploadIncremental("incremental-feedback.csv", studentId, advisorJar);
  assert(feedback.batch.suggestions.length > 0, "S2-04 CSV produced no review suggestions.");
  const feedbackText = JSON.stringify(feedback.batch);
  assert(
    !feedbackText.includes("OMEGA") && !feedbackText.includes("SIGMA"),
    "S2-04 decoy student content leaked into suggestions.",
  );
  for (const suggestion of feedback.batch.suggestions) {
    const rejected = await decideIncremental(studentId, advisorJar, suggestion, "rejected");
    assert(
      rejected.response.ok && rejected.payload.factId === null,
      "S2-04 group rejection changed a fact.",
    );
  }

  const meeting = await uploadIncremental("incremental-meeting.docx", studentId, advisorJar);
  assert(meeting.batch.suggestions.length > 0, "S2-04 DOCX produced no review suggestions.");
  let firstAccepted;
  for (const [index, suggestion] of meeting.batch.suggestions.entries()) {
    const edits =
      index === 0
        ? {
            editedFieldKey: "skill.graph_reasoning",
            editedValue: { text: "人工核对后的合成图论学习表现" },
          }
        : {};
    const accepted = await decideIncremental(studentId, advisorJar, suggestion, "accepted", edits);
    assert(
      accepted.response.ok && typeof accepted.payload.factId === "string",
      "S2-04 group acceptance did not create a fact.",
    );
    firstAccepted ??= { suggestion, ...accepted };
  }
  const stale = await decideIncremental(
    studentId,
    advisorJar,
    firstAccepted.suggestion,
    "accepted",
  );
  assert(stale.response.status === 409, "S2-04 repeated or stale decision was not blocked.");

  const derivedEvidence = await databaseClient.pool.query(
    `select storage_key from evidence_object
      where student_id = $1 and original_file_name like 'isolated-%'`,
    [studentId],
  );
  assert(derivedEvidence.rows.length >= 2, "S2-04 derived evidence was not persisted.");
  for (const row of derivedEvidence.rows) {
    const material = await readFile(join(storageRoot, row.storage_key), "utf8");
    assert(
      !material.includes("OMEGA") && !material.includes("SIGMA"),
      "S2-04 decoy student content leaked into stored evidence.",
    );
  }
  const acceptedFacts = await databaseClient.pool.query(
    `select sf.id, count(fe.student_fact_id)::int as evidence_count
       from student_fact sf
       join fact_evidence fe on fe.student_fact_id = sf.id
      where sf.student_id = $1 and sf.source_type = 'import' and sf.valid_to is null
      group by sf.id`,
    [studentId],
  );
  assert(acceptedFacts.rows.length > 0, "S2-04 accepted suggestions did not create current facts.");
  assert(
    acceptedFacts.rows.every((row) => row.evidence_count > 0),
    "S2-04 accepted suggestion lacks evidence.",
  );
}

async function readProfiles(studentId, advisorJar) {
  const response = await authenticatedFetch(
    `/api/students/${studentId}/profile-drafts`,
    advisorJar,
  );
  const payload = await response.json();
  assert(response.ok, "S2-05 profile workspace could not be read.");
  return payload;
}

async function s2ProfileWorkflow(studentId, advisorJar) {
  const enqueue = await authenticatedFetch(
    `/api/students/${studentId}/profile-drafts`,
    advisorJar,
    { method: "POST" },
  );
  assert(enqueue.status === 202, "S2-05 profile draft was not queued.");
  let workspace;
  for (let attempt = 0; attempt < 900; attempt += 1) {
    workspace = await readProfiles(studentId, advisorJar);
    const task = workspace.tasks?.[0];
    if (task?.status === "succeeded") break;
    if (task?.status === "failed") {
      const issues = safeTaskStats.profileSchemaIssues
        .map((issue) => `${issue.path}:${issue.code}`)
        .join(",");
      throw new Error(
        `S2-05 profile model task failed safely (${task.errorCode ?? "unknown"};${issues || "no_schema_path"}).`,
      );
    }
    await delay(100);
  }
  const generated = workspace?.profiles?.[0];
  assert(
    workspace?.tasks?.[0]?.status === "succeeded" && generated?.status === "draft",
    "S2-05 profile draft did not complete.",
  );
  assert(generated.claims?.length === 8, "S2-05 profile does not contain eight sections.");
  assert(
    generated.claims.some((claim) => claim.evidence?.length > 0),
    "S2-05 profile contains no evidence citation.",
  );
  const profileText = JSON.stringify(generated);
  assert(
    !profileText.includes("合成学员甲") &&
      !profileText.includes("13900000001") &&
      !profileText.includes("STU-"),
    "S2-05 profile output leaked a direct identifier.",
  );

  await taskWorker.close();
  taskWorker = undefined;
  const revision = await authenticatedFetch(
    `/api/students/${studentId}/profiles/${generated.id}/revisions`,
    advisorJar,
    {
      body: JSON.stringify({
        claims: generated.claims.map((claim, index) => ({
          category: claim.category,
          confidence: claim.confidence,
          evidence: claim.evidence,
          informationNature: claim.informationNature,
          statement: index === 0 ? `${claim.statement}（顾问已人工核对）` : claim.statement,
        })),
        expectedSourceUpdatedAt: generated.updatedAt,
        questionsToConfirm: generated.questionsToConfirm,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  assert(
    revision.status === 201,
    "S2-05 manual profile revision failed while Worker was unavailable.",
  );

  const manualEvidence = new FormData();
  manualEvidence.set("accessLevel", "sensitive");
  manualEvidence.set(
    "file",
    new File(["synthetic manual evidence while worker unavailable"], "manual-offline.txt", {
      type: "text/plain",
    }),
  );
  manualEvidence.set(
    "locators",
    JSON.stringify([{ locator: { field: "offline_manual" }, locatorType: "record_field" }]),
  );
  const evidenceResponse = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/evidence`,
    advisorJar,
    { body: manualEvidence, method: "POST" },
  );
  const evidencePayload = await evidenceResponse.json();
  assert(
    evidenceResponse.status === 201,
    "S2-05 manual evidence failed while Worker was unavailable.",
  );
  const offlineFact = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/facts`,
    advisorJar,
    {
      body: JSON.stringify({
        accessLevel: "sensitive",
        confirmationStatus: "confirmed",
        evidenceLinks: [
          {
            evidenceLocatorId: evidencePayload.evidence.locators[0].id,
            relation: "supports",
          },
        ],
        fieldKey: "skill.offline_manual",
        sourceType: "evidence",
        value: { text: "synthetic offline manual fact" },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  assert(offlineFact.status === 201, "S2-05 manual fact failed while Worker was unavailable.");

  workspace = await readProfiles(studentId, advisorJar);
  const revised = workspace.profiles?.[0];
  assert(revised?.version === 2 && revised.status === "draft", "S2-05 revised profile is invalid.");
  const submit = await authenticatedFetch(
    `/api/students/${studentId}/profiles/${revised.id}/transitions`,
    advisorJar,
    {
      body: JSON.stringify({ action: "submit", expectedUpdatedAt: revised.updatedAt }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  assert(submit.ok, "S2-05 profile submission failed.");
  workspace = await readProfiles(studentId, advisorJar);
  const inReview = workspace.profiles?.[0];
  const approve = await authenticatedFetch(
    `/api/students/${studentId}/profiles/${inReview.id}/transitions`,
    advisorJar,
    {
      body: JSON.stringify({ action: "approve", expectedUpdatedAt: inReview.updatedAt }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  assert(approve.ok, "S2-05 profile approval failed.");
  workspace = await readProfiles(studentId, advisorJar);
  const approved = workspace.profiles?.[0];
  assert(
    approved?.status === "approved" &&
      approved.reviews?.some((review) => review.action === "approved"),
    "S2-05 profile review history is incomplete.",
  );
  await startStage2Worker();
  return approved;
}

async function postJson(path, jar, body) {
  const response = await authenticatedFetch(path, jar, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const responseText = await response.text();
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(
      `${currentStage} ${path} returned non-JSON (${String(response.status)};${String(Buffer.byteLength(responseText, "utf8"))} bytes).`,
    );
  }
  return { payload, response };
}

function courseContent(title, scheduled = false) {
  return {
    capabilityTags: ["programming"],
    deliverables: [`${title}合成作品`],
    deliveryMode: scheduled ? "scheduled" : "self_paced",
    difficulty: "intermediate",
    durationWeeks: 8,
    notSuitableConditions: [],
    objectives: [`完成${title}合成目标`],
    projectTypes: ["synthetic_project"],
    schedule: scheduled ? [{ endMinute: 660, startMinute: 540, weekday: 6 }] : [],
    stage: "合成阶段二",
    subjectTags: ["computer_science"],
    summary: `${title}仅用于阶段二隔离功能测试。`,
    ...(scheduled ? { termEndDate: "2026-10-31", termStartDate: "2026-09-01" } : {}),
    title,
    totalInstructionMinutes: 960,
    weeklyLoadMinutes: 120,
  };
}

async function readCourses(adminJar) {
  const response = await authenticatedFetch("/api/courses", adminJar);
  const payload = await response.json();
  assert(response.ok, "S2-06 course catalog read failed.");
  return payload.courses;
}

async function transitionCourse(adminJar, courseVersionId, action, expectedUpdatedAt, reason) {
  const result = await postJson("/api/courses", adminJar, {
    action: "transition_course",
    courseVersionId,
    input: { action, expectedUpdatedAt, ...(reason === undefined ? {} : { reason }) },
  });
  assert(result.response.status === 201, `S2-06 course ${action} failed.`);
  return result.payload;
}

async function transitionScheduling(adminJar, kind, versionId, action, expectedUpdatedAt, reason) {
  const result = await postJson("/api/scheduling", adminJar, {
    action: "transition",
    input: { action, expectedUpdatedAt, ...(reason === undefined ? {} : { reason }) },
    kind,
    versionId,
  });
  assert(result.response.status === 201, `S2-06 ${kind} ${action} failed.`);
}

async function readScheduling(adminJar) {
  const response = await authenticatedFetch("/api/scheduling", adminJar);
  const payload = await response.json();
  assert(response.ok, "S2-06 scheduling catalog read failed.");
  return payload;
}

async function s2CoursesAndRecommendation(studentId, adminJar, advisorJar, approvedProfile) {
  const createdCourses = [];
  for (const [code, title, scheduled] of [
    ["S2_GRAPH", "合成图论进阶", true],
    ["S2_PROJECT", "合成项目探索", false],
    ["S2_FOUNDATION", "合成基础训练", false],
    ["S2_ARCHIVE", "合成待归档课程", false],
  ]) {
    const created = await postJson("/api/courses", adminJar, {
      action: "create_course",
      input: { code, content: courseContent(title, scheduled) },
    });
    assert(created.response.status === 201, `S2-06 course ${code} creation failed.`);
    const catalog = await readCourses(adminJar);
    const draft = catalog.find((item) => item.courseVersionId === created.payload.courseVersionId);
    await transitionCourse(adminJar, draft.courseVersionId, "approve", draft.updatedAt);
    createdCourses.push({ ...created.payload, code });
  }

  let catalog = await readCourses(adminJar);
  const graphApproved = catalog.find(
    (item) => item.code === "S2_GRAPH" && item.status === "approved",
  );
  const revised = await postJson("/api/courses", adminJar, {
    action: "revise_course",
    courseVersionId: graphApproved.courseVersionId,
    input: {
      content: { ...graphApproved.content, title: "合成图论进阶（修订）" },
      expectedSourceUpdatedAt: graphApproved.updatedAt,
    },
  });
  assert(revised.response.status === 201, "S2-06 course revision failed.");
  catalog = await readCourses(adminJar);
  const graphRevision = catalog.find(
    (item) => item.courseVersionId === revised.payload.courseVersionId,
  );
  await transitionCourse(
    adminJar,
    graphRevision.courseVersionId,
    "approve",
    graphRevision.updatedAt,
  );
  catalog = await readCourses(adminJar);
  const archivedOriginal = catalog.find(
    (item) => item.courseVersionId === graphApproved.courseVersionId,
  );
  assert(
    archivedOriginal.status === "archived",
    "S2-06 old course version was overwritten instead of archived.",
  );
  const archiveCourse = catalog.find(
    (item) => item.code === "S2_ARCHIVE" && item.status === "approved",
  );
  await transitionCourse(
    adminJar,
    archiveCourse.courseVersionId,
    "archive",
    archiveCourse.updatedAt,
    "合成归档验证",
  );

  const location = await postJson("/api/scheduling", adminJar, {
    action: "create_location",
    input: {
      code: "S2_ROOM_A",
      content: {
        name: "合成校区 A",
        unavailableDates: [],
        weeklyAvailability: [
          { endMinute: 1200, startMinute: 480, weekday: 6 },
          { endMinute: 1200, startMinute: 480, weekday: 7 },
        ],
      },
    },
  });
  assert(location.response.status === 201, "S2-06 location creation failed.");
  for (const [code, name, preferredTags] of [
    ["S2_TEACHER_A", "合成教师 A", ["programming"]],
    ["S2_TEACHER_B", "合成教师 B", []],
  ]) {
    const teacher = await postJson("/api/scheduling", adminJar, {
      action: "create_teacher",
      input: {
        code,
        content: {
          maxDailyMinutes: 360,
          maxWeeklyMinutes: 720,
          name,
          preferredTags,
          qualificationTags: ["programming"],
          unavailableDates: [],
          weeklyAvailability: [
            { endMinute: 1200, startMinute: 480, weekday: 6 },
            { endMinute: 1200, startMinute: 480, weekday: 7 },
          ],
        },
      },
    });
    assert(teacher.response.status === 201, `S2-06 teacher ${code} creation failed.`);
  }
  let scheduling = await readScheduling(adminJar);
  await transitionScheduling(
    adminJar,
    "location",
    scheduling.locations[0].versionId,
    "approve",
    scheduling.locations[0].updatedAt,
  );
  for (const teacher of scheduling.teachers) {
    await transitionScheduling(
      adminJar,
      "teacher",
      teacher.versionId,
      "approve",
      teacher.updatedAt,
    );
  }
  scheduling = await readScheduling(adminJar);
  const approvedGraph = (await readCourses(adminJar)).find(
    (item) => item.code === "S2_GRAPH" && item.status === "approved",
  );
  const offering = await postJson("/api/scheduling", adminJar, {
    action: "create_offering",
    input: {
      code: "S2_GRAPH_CLASS",
      content: {
        allowedTeacherIds: scheduling.teachers.map((item) => item.teacherId),
        candidateSchedules: [
          {
            kind: "weekly",
            label: "周六方案",
            occurrences: [
              { endMinute: 660, sessionDate: "2026-09-05", startMinute: 540 },
              { endMinute: 660, sessionDate: "2026-09-12", startMinute: 540 },
            ],
            preferenceRank: 1,
          },
          {
            kind: "weekly",
            label: "周日方案",
            occurrences: [
              { endMinute: 660, sessionDate: "2026-09-06", startMinute: 540 },
              { endMinute: 660, sessionDate: "2026-09-13", startMinute: 540 },
            ],
            preferenceRank: 2,
          },
        ],
        className: "合成图论进阶班",
        courseVersionId: approvedGraph.courseVersionId,
        endDate: "2026-10-31",
        locationVersionId: scheduling.locations[0].versionId,
        priority: 100,
        requiredQualificationTags: ["programming"],
        startDate: "2026-09-01",
        studentRosterText: ["合成名单甲", "合成名单乙"],
      },
    },
  });
  assert(offering.response.status === 201, "S2-06 offering creation failed.");
  scheduling = await readScheduling(adminJar);
  const draftOffering = scheduling.offerings.find(
    (item) => item.versionId === offering.payload.versionId,
  );
  await transitionScheduling(
    adminJar,
    "offering",
    draftOffering.versionId,
    "approve",
    draftOffering.updatedAt,
  );

  const noProfileRecommendation = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/recommendations`,
    advisorJar,
    { method: "POST" },
  );
  assert(
    noProfileRecommendation.status === 409,
    "S2-06 recommendation without approved profile was not blocked.",
  );

  const queued = await authenticatedFetch(
    `/api/students/${studentId}/recommendations`,
    advisorJar,
    { method: "POST" },
  );
  const queuedPayload = await queued.json();
  assert(queued.status === 202, "S2-06 recommendation was not queued.");
  let recommendations = [];
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const response = await authenticatedFetch(
      `/api/students/${studentId}/recommendations`,
      advisorJar,
    );
    recommendations = await response.json();
    assert(response.ok, "S2-06 recommendation read failed.");
    if (recommendations.length > 0) break;
    const job = await databaseClient.pool.query(
      "select status, error_code from background_job where id = $1",
      [queuedPayload.taskId],
    );
    if (job.rows[0]?.status === "failed")
      throw new Error("S2-06 recommendation model task failed safely.");
    await delay(100);
  }
  assert(recommendations.length === 1, "S2-06 recommendation result is missing.");
  const recommendation = recommendations[0];
  const snapshot = await databaseClient.pool.query(
    `select eligible_course_version_ids, eligible_offering_version_ids, profile_claim_ids
       from course_recommendation_snapshot where id = $1`,
    [queuedPayload.snapshotId],
  );
  const allowedCourses = new Set(snapshot.rows[0].eligible_course_version_ids);
  const allowedOfferings = new Set(snapshot.rows[0].eligible_offering_version_ids);
  const allowedClaims = new Set(snapshot.rows[0].profile_claim_ids);
  const items = [...recommendation.output.recommendations, recommendation.output.alternative];
  for (const item of items) {
    assert(
      allowedCourses.has(item.courseVersionId),
      "S2-06 model returned an out-of-snapshot course.",
    );
    assert(
      item.offeringVersionIds.every((id) => allowedOfferings.has(id)),
      "S2-06 model returned an out-of-snapshot class.",
    );
    assert(
      item.claimIds.every((id) => allowedClaims.has(id)),
      "S2-06 model returned an out-of-snapshot claim.",
    );
  }
  assert(
    allowedCourses.size >= 2 && allowedOfferings.size === 1,
    "S2-06 snapshot did not preserve course/class joint recommendation boundaries.",
  );
  const accepted = await authenticatedFetch(
    `/api/students/${studentId}/recommendations`,
    advisorJar,
    {
      body: JSON.stringify({ decision: "accepted", recommendationId: recommendation.id }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    },
  );
  assert(accepted.ok, "S2-06 recommendation acceptance failed.");
  const planning = await authenticatedFetch(
    `/students/${studentId}/planning?recommendation=${recommendation.id}`,
    advisorJar,
  );
  assert(planning.ok, "S2-06 accepted recommendation could not enter manual planning.");
  assert(approvedProfile.status === "approved", "S2-06 approved profile was not used.");
  const approvedCourses = (await readCourses(adminJar)).filter(
    (item) => item.status === "approved",
  );
  const graphCourse = approvedCourses.find((item) => item.code === "S2_GRAPH");
  const projectCourse = approvedCourses.find((item) => item.code === "S2_PROJECT");
  const foundationCourse = approvedCourses.find((item) => item.code === "S2_FOUNDATION");
  const supportingClaimId = approvedProfile.claims.find((claim) => claim.evidence.length > 0)?.id;
  assert(
    graphCourse !== undefined &&
      projectCourse !== undefined &&
      foundationCourse !== undefined &&
      supportingClaimId !== undefined,
    "S2-06 approved planning inputs are incomplete.",
  );
  const planInput = {
    content: {
      classroomProfile: {
        statement: "合成课堂画像，仅用于隔离功能测试。",
        supportingClaimIds: [supportingClaimId],
      },
      decisionTimeline: [
        {
          decisionQuestion: "下一阶段继续哪条合成路线？",
          observableSignals: ["能够独立完成合成交付物"],
          period: { endDate: "2026-10-31", startDate: "2026-10-01" },
        },
      ],
      goal: "验证画像、推荐和人工课程规划的失效联动。",
      overlapAndGaps: {
        overlap: ["两条路线均观察问题解决过程"],
        routeAGaps: ["需要继续观察算法迁移"],
        routeBGaps: ["需要继续观察开放项目完成度"],
      },
      period: { endDate: "2027-06-30", startDate: "2026-09-01" },
      risks: ["合成结果不能作为真实学生业务结论"],
      routeComparison: Array.from({ length: 6 }, (_, index) => ({
        dimension: `合成比较维度 ${String(index + 1)}`,
        routeA: `路线 A 观察项 ${String(index + 1)}`,
        routeB: `路线 B 观察项 ${String(index + 1)}`,
      })),
      routes: [
        {
          key: "route_a",
          name: "路线 A：图论进阶",
          phases: [
            {
              courseVersionIds: [graphCourse.courseVersionId],
              label: "合成算法阶段",
              period: { endDate: "2026-10-31", startDate: "2026-09-01" },
              sequence: 1,
            },
          ],
          summary: "通过合成课程观察算法迁移。",
          supportingClaimIds: [supportingClaimId],
        },
        {
          key: "route_b",
          name: "路线 B：项目探索",
          phases: [
            {
              courseVersionIds: [projectCourse.courseVersionId],
              label: "合成项目阶段",
              period: { endDate: "2026-12-31", startDate: "2026-11-01" },
              sequence: 1,
            },
          ],
          summary: "通过合成项目观察开放任务表现。",
          supportingClaimIds: [supportingClaimId],
        },
      ],
      shortTermItems: [
        {
          courseVersionId: foundationCourse.courseVersionId,
          expectedOutcome: "完成一份合成算法作品。",
          order: 1,
          period: { endDate: "2026-10-31", startDate: "2026-09-01" },
          reason: "验证短期课程与长期路线联动。",
          risks: ["仅供技术测试"],
          supportingClaimIds: [supportingClaimId],
        },
      ],
      title: "第二阶段合成人工课程规划",
    },
    profileVersionId: approvedProfile.id,
    reviewDueDate: "2027-01-31",
    studentInput: {
      ageYears: 15,
      classroomFeedback: [
        {
          statement: "合成课堂反馈已与画像证据关联。",
          supportingClaimIds: [supportingClaimId],
        },
      ],
      completedCourseIds: [],
      constraints: ["合成每周容量"],
      inProgressCourseVersionIds: [],
      interests: ["合成项目实践"],
    },
  };
  const parsedPlanInput = CreateManualPlanInputSchema.safeParse(planInput);
  if (!parsedPlanInput.success) {
    const issues = parsedPlanInput.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".")}:${issue.code}`)
      .join(",");
    throw new Error(`S2-06 functional plan fixture failed schema validation (${issues}).`);
  }
  const createdPlan = await postJson(
    `/api/students/${studentId}/plans`,
    advisorJar,
    parsedPlanInput.data,
  );
  assert(createdPlan.response.status === 201, "S2-06 manual plan creation failed.");
  const planId = createdPlan.payload.plan.id;
  let currentPlan = createdPlan.payload.plan;
  const hardViolations = currentPlan.evaluation.scopes.flatMap((scope) =>
    scope.result.violations
      .filter((violation) => violation.severity === "hard")
      .map((violation) => ({ scopeKey: scope.scopeKey, violationKey: violation.violationKey })),
  );
  for (const violation of hardViolations) {
    const requested = await postJson(
      `/api/students/${studentId}/plans/${planId}/overrides`,
      advisorJar,
      {
        expectedPlanUpdatedAt: currentPlan.updatedAt,
        reason: "合成技术测试中的课程规则覆盖，需保留人工批准记录。",
        scopeKey: violation.scopeKey,
        violationKey: violation.violationKey,
      },
    );
    assert(requested.response.status === 201, "S2-06 plan override request failed.");
    const decided = await postJson(
      `/api/students/${studentId}/plans/${planId}/overrides/${requested.payload.id}/decisions`,
      advisorJar,
      { action: "approve", expectedUpdatedAt: requested.payload.updatedAt },
    );
    assert(decided.response.ok, "S2-06 plan override approval failed.");
  }
  for (const action of ["submit", "approve"]) {
    const transitioned = await postJson(
      `/api/students/${studentId}/plans/${planId}/transitions`,
      advisorJar,
      { action, expectedUpdatedAt: currentPlan.updatedAt },
    );
    if (!transitioned.response.ok) {
      const errorCode =
        transitioned.payload !== null && typeof transitioned.payload === "object"
          ? transitioned.payload.error
          : undefined;
      throw new Error(
        `S2-06 manual plan ${action} failed (${String(transitioned.response.status)};${typeof errorCode === "string" ? errorCode : "unknown"}).`,
      );
    }
    const refreshedWorkspace = await readPlans(studentId, advisorJar);
    currentPlan = refreshedWorkspace.plans.find((plan) => plan.id === planId);
    assert(currentPlan !== undefined, "S2-06 transitioned plan could not be reloaded.");
  }
  assert(currentPlan.status === "approved", "S2-06 manual plan was not approved.");
  return { planId, recommendationId: recommendation.id, scheduling };
}

async function solveTimetableThroughApi(adminJar) {
  const queued = await postJson("/api/scheduling", adminJar, {
    action: "solve_timetable",
  });
  assert(queued.response.status === 201, "S2-07 timetable task was not queued.");
  let run;
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const scheduling = await readScheduling(adminJar);
    run = scheduling.timetableRuns.find((item) => item.id === queued.payload.runId);
    if (["solved", "partially_solved", "infeasible", "failed"].includes(run?.status)) break;
    await delay(100);
  }
  assert(run !== undefined && run.status !== "failed", "S2-07 timetable solver failed.");
  return run;
}

async function s2Timetable(adminJar, advisorJar) {
  const first = await solveTimetableThroughApi(adminJar);
  assert(first.status === "solved", "S2-07 initial timetable was not solved.");
  assert(first.output.assignments.length === 1, "S2-07 initial timetable assignment is invalid.");
  const persisted = await databaseClient.pool.query(
    "select input_snapshot, output_hash from timetable_run where id = $1",
    [first.id],
  );
  const inputText = JSON.stringify(persisted.rows[0].input_snapshot);
  assert(
    !inputText.includes("合成名单甲") && !inputText.includes("合成名单乙"),
    "S2-07 text roster leaked into solver input.",
  );
  const deterministicA = await solveTimetable(persisted.rows[0].input_snapshot);
  const deterministicB = await solveTimetable(persisted.rows[0].input_snapshot);
  const deterministicHashA = recommendationHash(deterministicA);
  const deterministicHashB = recommendationHash(deterministicB);
  assert(
    deterministicHashA === deterministicHashB &&
      deterministicHashA === persisted.rows[0].output_hash,
    "S2-07 identical solver input produced a different output hash.",
  );
  const advisorApprove = await authenticatedFetch("/api/scheduling", advisorJar, {
    body: JSON.stringify({ action: "approve_timetable", runId: first.id }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert(advisorApprove.status === 404, "S2-07 advisor could approve a timetable.");
  const approved = await postJson("/api/scheduling", adminJar, {
    action: "approve_timetable",
    runId: first.id,
  });
  assert(
    approved.response.status === 201 && approved.payload.status === "approved",
    "S2-07 admin approval failed.",
  );

  let scheduling = await readScheduling(adminJar);
  const projectCourse = (await readCourses(adminJar)).find(
    (item) => item.code === "S2_PROJECT" && item.status === "approved",
  );
  const impossible = await postJson("/api/scheduling", adminJar, {
    action: "create_offering",
    input: {
      code: "S2_IMPOSSIBLE_CLASS",
      content: {
        allowedTeacherIds: [],
        candidateSchedules: [
          {
            kind: "short_term",
            label: "无资质短期营",
            occurrences: [
              { endMinute: 660, sessionDate: "2026-09-19", startMinute: 540 },
              { endMinute: 660, sessionDate: "2026-09-20", startMinute: 540 },
            ],
            preferenceRank: 1,
          },
        ],
        className: "合成无资质班",
        courseVersionId: projectCourse.courseVersionId,
        endDate: "2026-09-20",
        locationVersionId: scheduling.locations[0].versionId,
        priority: 1,
        requiredQualificationTags: ["robotics"],
        startDate: "2026-09-19",
        studentRosterText: ["不参与冲突检测的合成名单"],
      },
    },
  });
  assert(impossible.response.status === 201, "S2-07 impossible offering creation failed.");
  scheduling = await readScheduling(adminJar);
  const impossibleDraft = scheduling.offerings.find(
    (item) => item.versionId === impossible.payload.versionId,
  );
  await transitionScheduling(
    adminJar,
    "offering",
    impossibleDraft.versionId,
    "approve",
    impossibleDraft.updatedAt,
  );
  const partial = await solveTimetableThroughApi(adminJar);
  assert(
    partial.status === "partially_solved" && partial.output.unassigned.length === 1,
    "S2-07 partial solution or safe unassigned reason is missing.",
  );
  scheduling = await readScheduling(adminJar);
  for (const teacher of scheduling.teachers.filter((item) => item.status === "approved")) {
    await transitionScheduling(
      adminJar,
      "teacher",
      teacher.versionId,
      "archive",
      teacher.updatedAt,
      "合成不可行状态验证",
    );
  }
  const unqualified = await postJson("/api/scheduling", adminJar, {
    action: "create_teacher",
    input: {
      code: "S2_TEACHER_UNQUALIFIED",
      content: {
        maxDailyMinutes: 360,
        maxWeeklyMinutes: 720,
        name: "合成非编程资质教师",
        preferredTags: [],
        qualificationTags: ["mathematics"],
        unavailableDates: [],
        weeklyAvailability: [
          { endMinute: 1200, startMinute: 480, weekday: 6 },
          { endMinute: 1200, startMinute: 480, weekday: 7 },
        ],
      },
    },
  });
  assert(unqualified.response.status === 201, "S2-07 unqualified teacher creation failed.");
  scheduling = await readScheduling(adminJar);
  const unqualifiedDraft = scheduling.teachers.find(
    (item) => item.versionId === unqualified.payload.versionId,
  );
  await transitionScheduling(
    adminJar,
    "teacher",
    unqualifiedDraft.versionId,
    "approve",
    unqualifiedDraft.updatedAt,
  );
  const infeasible = await solveTimetableThroughApi(adminJar);
  assert(
    infeasible.status === "infeasible" &&
      infeasible.output.unassigned[0]?.reason.includes("教师资质"),
    "S2-07 infeasible result lacks a safe reason.",
  );
  return { approvedRunId: first.id };
}

async function readPlans(studentId, advisorJar) {
  const response = await authenticatedFetch(`/api/students/${studentId}/plans`, advisorJar);
  const payload = await response.json();
  assert(response.ok, "S2-08 planning workspace could not be read.");
  return payload;
}

async function s2InvalidationSecurityAndBoundaries(
  studentId,
  adminJar,
  advisorJar,
  approvedProfile,
  courseState,
  timetableState,
) {
  const callsBeforeNegativeCases = safeTaskStats.calls;
  for (const [name, file] of [
    ["empty.txt", new File([""], "empty.txt", { type: "text/plain" })],
    ["wrong.pdf", new File(["not a supported document"], "wrong.pdf", { type: "application/pdf" })],
    [
      "oversize.txt",
      new File([await readFile(join(fixtureDirectory, "oversize.txt"))], "oversize.txt", {
        type: "text/plain",
      }),
    ],
  ]) {
    const form = new FormData();
    form.set("file", file);
    const response = await authenticatedFetch("/api/student-imports", adminJar, {
      body: form,
      method: "POST",
    });
    assert(!response.ok, `S2-08 ${name} was accepted.`);
  }

  const ambiguous = new FormData();
  ambiguous.set(
    "file",
    new File(["课程,合成学员甲,合成学员甲反馈\n算法,目标内容,重复目标列"], "ambiguous.csv", {
      type: "text/csv",
    }),
  );
  ambiguous.set("ownershipConfirmed", "true");
  const ambiguousUpload = await authenticatedFetch(
    `/api/students/${studentId}/imports`,
    advisorJar,
    { body: ambiguous, method: "POST" },
  );
  const ambiguousPayload = await ambiguousUpload.json();
  assert(ambiguousUpload.status === 202, "S2-08 ambiguous CSV did not enter safe validation.");
  let ambiguousStatus;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await authenticatedFetch(
      `/api/students/${studentId}/imports?id=${encodeURIComponent(ambiguousPayload.batchId)}`,
      advisorJar,
    );
    ambiguousStatus = await response.json();
    if (ambiguousStatus.status === "failed") break;
    await delay(100);
  }
  assert(ambiguousStatus?.status === "failed", "S2-08 ambiguous CSV was not rejected safely.");
  assert(
    safeTaskStats.calls === callsBeforeNegativeCases,
    "S2-08 invalid inputs unexpectedly called DeepSeek.",
  );

  const crossStudent = await authenticatedFetch(
    `/api/students/${REDACTED_FIXTURE_IDS.student}/plans/${courseState.planId}/export`,
    advisorJar,
  );
  assert(
    crossStudent.status === 404,
    `S2-08 cross-student plan substitution was not hidden (${String(crossStudent.status)}).`,
  );
  const plansBefore = await readPlans(studentId, advisorJar);
  const approvedPlanBefore = plansBefore.plans.find((plan) => plan.id === courseState.planId);
  assert(approvedPlanBefore?.status === "approved", "S2-08 approved plan baseline is missing.");
  const illegalTransition = await postJson(
    `/api/students/${studentId}/plans/${courseState.planId}/transitions`,
    advisorJar,
    { action: "approve", expectedUpdatedAt: approvedPlanBefore.updatedAt },
  );
  assert(illegalTransition.response.status === 409, "S2-08 illegal plan transition was accepted.");
  const profileBefore = (await readProfiles(studentId, advisorJar)).profiles.find(
    (profile) => profile.id === approvedProfile.id,
  );
  const recommendationsBefore = await (
    await authenticatedFetch(`/api/students/${studentId}/recommendations`, advisorJar)
  ).json();
  const timetableBefore = (await readScheduling(adminJar)).timetableRuns.find(
    (run) => run.id === timetableState.approvedRunId,
  );
  assert(
    profileBefore?.status === "approved" &&
      recommendationsBefore.find((item) => item.id === courseState.recommendationId)?.status ===
        "accepted" &&
      timetableBefore?.status === "approved",
    "S2-08 negative cases overwrote an approved artifact.",
  );

  const citedLocatorId = approvedProfile.claims.flatMap((claim) => claim.evidence)[0]?.locatorId;
  assert(citedLocatorId !== undefined, "S2-08 approved profile lacks cited evidence.");
  const evidence = await databaseClient.pool.query(
    "select evidence_object_id from evidence_locator where id = $1",
    [citedLocatorId],
  );
  const evidenceObjectId = evidence.rows[0]?.evidence_object_id;
  assert(typeof evidenceObjectId === "string", "S2-08 cited evidence object was not found.");
  const invalidated = await postJson(
    `/api/students/${studentId}/evidence/${evidenceObjectId}/invalidate`,
    advisorJar,
    { reason: "合成证据失效传播测试" },
  );
  assert(invalidated.response.ok, "S2-08 evidence invalidation failed.");
  const profileAfter = (await readProfiles(studentId, advisorJar)).profiles.find(
    (profile) => profile.id === approvedProfile.id,
  );
  const recommendationsAfter = await (
    await authenticatedFetch(`/api/students/${studentId}/recommendations`, advisorJar)
  ).json();
  const planAfter = (await readPlans(studentId, advisorJar)).plans.find(
    (plan) => plan.id === courseState.planId,
  );
  assert(profileAfter?.status === "needs_review", "S2-08 profile did not enter needs_review.");
  assert(
    recommendationsAfter.find((item) => item.id === courseState.recommendationId)?.status ===
      "needs_review",
    "S2-08 recommendation did not enter needs_review.",
  );
  assert(planAfter?.status === "needs_review", "S2-08 plan did not enter needs_review.");

  const queuedJobs = await queue.getJobs(["active", "completed", "delayed", "failed", "waiting"]);
  const auditRows = await databaseClient.pool.query("select details from audit_event");
  const securityText = JSON.stringify({
    audit: auditRows.rows,
    jobs: queuedJobs.map((job) => job.data),
    web: webOutput,
  });
  for (const forbidden of [
    "13900000001",
    "OMEGA-OTHER-STUDENT-PRIVATE",
    "SIGMA-OTHER-STUDENT-PRIVATE",
    "DEEPSEEK_API_KEY",
    "api.deepseek.com",
  ]) {
    assert(
      !securityText.includes(forbidden),
      `S2-08 protected string leaked into logs or task metadata (${forbidden}).`,
    );
  }
}

async function cleanup() {
  if (webServer !== undefined) {
    webServer.kill();
    await Promise.race([
      new Promise((resolveExit) => webServer.once("exit", resolveExit)),
      delay(3000),
    ]);
  }
  if (taskWorker !== undefined) await taskWorker.close().catch(() => undefined);
  if (queue !== undefined) {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
  }
  if (redis !== undefined) await redis.quit().catch(() => undefined);
  if (databaseClient !== undefined) {
    await databaseClient.close().catch(() => undefined);
    databaseClient = undefined;
  }
  await maintenanceClient.pool.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
    [temporaryDatabaseName],
  );
  await maintenanceClient.pool.query(`drop database if exists "${temporaryDatabaseName}"`);
  await maintenanceClient.close().catch(() => undefined);
  if ((!failed || !keepOnFailure) && !holdMode) {
    await rm(runRoot, { force: true, recursive: true });
  }
}

async function main() {
  await mkdir(storageRoot, { recursive: true });
  const planContent = await readFile(planPath);
  const planHash = sha256(planContent);
  const manifest = await generateFixtures();
  await prepareDatabase();
  await startStage2Worker();
  webServer = startWebServer();
  await waitForHealth();
  const sessions = await s2PermissionsAndNavigation();
  if (holdMode) {
    const sentinel = process.env.CULIU_STAGE2_BROWSER_SENTINEL ?? join(runRoot, "browser-complete");
    await writeFile(
      join(runRoot, "browser-session.json"),
      `${JSON.stringify(
        {
          baseUrl,
          admin: { email: adminEmail, password: adminPassword },
          advisor: { email: advisorEmail, password: advisorPassword },
          runId,
          sentinel,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    process.stdout.write(`${JSON.stringify({ baseUrl, hold: true, planHash, runId })}\n`);
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      try {
        await stat(sentinel);
        break;
      } catch {
        await delay(1000);
      }
    }
    if (process.env.CULIU_STAGE2_BROWSER_RESULT !== undefined) {
      await mkdir(dirname(process.env.CULIU_STAGE2_BROWSER_RESULT), { recursive: true });
      await writeFile(
        process.env.CULIU_STAGE2_BROWSER_RESULT,
        `${JSON.stringify({
          calls: safeTaskStats.calls,
          tokenUsage: { input: safeTaskStats.inputTokens, output: safeTaskStats.outputTokens },
        })}\n`,
        "utf8",
      );
    }
    return;
  }
  currentStage = "S2-03";
  const targetStudentId = await s2BasicImports(sessions.adminJar);
  currentStage = "S2-04";
  await s2IncrementalImports(targetStudentId, sessions.advisorJar);
  currentStage = "S2-05";
  const approvedProfile = await s2ProfileWorkflow(targetStudentId, sessions.advisorJar);
  currentStage = "S2-06";
  const courseState = await s2CoursesAndRecommendation(
    targetStudentId,
    sessions.adminJar,
    sessions.advisorJar,
    approvedProfile,
  );
  currentStage = "S2-07";
  const timetableState = await s2Timetable(sessions.adminJar, sessions.advisorJar);
  currentStage = "S2-08";
  await s2InvalidationSecurityAndBoundaries(
    targetStudentId,
    sessions.adminJar,
    sessions.advisorJar,
    approvedProfile,
    courseState,
    timetableState,
  );
  process.stdout.write(
    `${JSON.stringify({
      calls: safeTaskStats.calls,
      currentStage,
      fixtureFiles: Object.keys(manifest.files).length,
      planHash,
      runId,
      s2_02: "passed",
      s2_03: "passed",
      s2_04: "passed",
      s2_05: "passed",
      s2_06: "passed",
      s2_07: "passed",
      s2_08: "passed",
      targetStudent: sha256(targetStudentId).slice(0, 12),
      tokenUsage: {
        input: safeTaskStats.inputTokens,
        output: safeTaskStats.outputTokens,
      },
    })}\n`,
  );
}

try {
  await main();
} catch (error) {
  failed = true;
  const safeMessage = error instanceof Error ? error.message.split("\n", 1)[0] : "unknown_failure";
  if (webOutput.length > 0) {
    await writeFile(
      join(runRoot, "safe-web-diagnostic.log"),
      sanitizeDiagnosticText(webOutput.join("\n")),
      "utf8",
    );
  }
  process.stderr.write(
    `${JSON.stringify({
      calls: safeTaskStats.calls,
      currentStage,
      runId,
      safeMessage,
      status: "failed",
      tokenUsage: { input: safeTaskStats.inputTokens, output: safeTaskStats.outputTokens },
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await cleanup();
}
