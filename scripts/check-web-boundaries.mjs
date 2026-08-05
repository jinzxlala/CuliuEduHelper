import { access, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const knowledgeRoot = join(root, "apps", "knowledge-web", "src");
const operationsRoot = join(root, "apps", "operations-web", "src");

const requiredPaths = [
  join(knowledgeRoot, "app", "search", "page.tsx"),
  join(knowledgeRoot, "app", "knowledge", "import", "page.tsx"),
  join(knowledgeRoot, "app", "api", "knowledge", "imports", "route.ts"),
  join(operationsRoot, "app", "students", "page.tsx"),
  join(operationsRoot, "app", "courses", "page.tsx"),
  join(operationsRoot, "app", "scheduling", "page.tsx"),
];

const forbiddenPaths = [
  join(knowledgeRoot, "app", "students"),
  join(knowledgeRoot, "app", "courses"),
  join(knowledgeRoot, "app", "scheduling"),
  join(knowledgeRoot, "app", "api", "students"),
  join(knowledgeRoot, "app", "api", "courses"),
  join(knowledgeRoot, "app", "api", "scheduling"),
  join(operationsRoot, "app", "search"),
  join(operationsRoot, "app", "knowledge"),
  join(operationsRoot, "app", "api", "knowledge"),
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : Promise.resolve([path]);
    }),
  );
  return files.flat().filter((path) => /\.(?:ts|tsx)$/u.test(path));
}

for (const path of requiredPaths) {
  if (!(await exists(path)))
    throw new Error(`Required system route is missing: ${relative(root, path)}`);
}

for (const path of forbiddenPaths) {
  if (await exists(path)) throw new Error(`Cross-system route is present: ${relative(root, path)}`);
}

const forbiddenImports = [
  {
    root: knowledgeRoot,
    patterns: [
      "@culiu/course-planning",
      "@culiu/student-profiles",
      "@culiu/student-records",
      "@culiu/student-ingest",
    ],
  },
  {
    root: operationsRoot,
    patterns: ["@culiu/knowledge-ingest", "@culiu/search"],
  },
];

for (const boundary of forbiddenImports) {
  for (const file of await sourceFiles(boundary.root)) {
    const source = await readFile(file, "utf8");
    const match = boundary.patterns.find((pattern) => source.includes(pattern));
    if (match !== undefined) {
      throw new Error(`Cross-system import ${match} found in ${relative(root, file)}`);
    }
  }
}

console.log("Knowledge and operations Web route/import boundaries are isolated.");
