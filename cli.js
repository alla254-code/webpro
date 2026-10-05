const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { spawn } = require("node:child_process");
const { stdin, stdout } = require("node:process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
function resolveDataPath(value, fallback) {
  const configuredPath = value || fallback;
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(ROOT, configuredPath);
}
const dbPath = path.join(resolveDataPath(process.env.DATA_DIR, "data"), "vault.sqlite");
const uploadDir = resolveDataPath(process.env.UPLOAD_DIR, "uploads");
const workDir = path.join(ROOT, "runtime", "work");

function usage() {
  console.log(`
Tool Vault CLI

  npm run cli -- list
  npm run cli -- run <tool-id> [-- program arguments]

Only Windows .exe and .com files can be run. A confirmation is required every time.
Programs run as your Windows user; this CLI is not a security sandbox.
`);
}

function openDb() {
  if (!fs.existsSync(dbPath)) {
    throw new Error("The vault is not initialized yet. Start the website once with npm start.");
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

function getTool(db, id) {
  return db.prepare("SELECT * FROM tools WHERE id = ?").get(id);
}

async function listTools(db) {
  const tools = db.prepare(`
    SELECT id, name, original_name, size, sha256, created_at FROM tools ORDER BY created_at DESC
  `).all();
  if (!tools.length) {
    console.log("Your vault is empty. Upload a tool from the website first.");
    return;
  }
  for (const tool of tools) {
    console.log(`${tool.id}  ${tool.name}  (${tool.original_name}, ${formatSize(tool.size)})`);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function runTool(db, id, args) {
  if (process.platform !== "win32") {
    throw new Error("Running stored programs is supported on Windows only. Render services run Linux; download programs and use the CLI on your Windows computer.");
  }
  const tool = getTool(db, id);
  if (!tool) throw new Error(`No tool found with id "${id}". Run "list" to see available ids.`);
  if (![".exe", ".com"].includes(path.extname(tool.original_name).toLowerCase())) {
    throw new Error("For safety, the CLI only runs .exe and .com files. Other file types can still be stored and downloaded.");
  }

  const filePath = path.join(uploadDir, tool.storage_name);
  const resolvedPath = path.resolve(filePath);
  if (path.dirname(resolvedPath) !== path.resolve(uploadDir) || !fs.existsSync(resolvedPath)) {
    throw new Error("The stored program is missing or its storage path is invalid.");
  }
  const actualHash = await hashFile(resolvedPath);
  if (actualHash !== tool.sha256) {
    throw new Error("Integrity check failed: the stored file no longer matches its upload checksum.");
  }

  console.log(`\nYou are about to run: ${tool.name} (${tool.original_name})`);
  console.log(`SHA-256: ${tool.sha256}`);
  console.log("This program is NOT sandboxed. It can access files, credentials, and network resources");
  console.log("available to your Windows account. Only continue if you trust this upload.\n");
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  const confirmation = await terminal.question('Type "RUN" to continue: ');
  terminal.close();
  if (confirmation !== "RUN") {
    console.log("Cancelled.");
    return;
  }

  fs.mkdirSync(workDir, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(workDir, "run-"));
  const environment = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  await new Promise((resolve, reject) => {
    const child = spawn(resolvedPath, args, {
      cwd,
      env: environment,
      shell: false,
      stdio: "inherit",
      windowsHide: false
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Program exceeded the 10-minute execution limit and was stopped."));
    }, 10 * 60 * 1000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (signal) return reject(new Error(`Program exited after receiving ${signal}.`));
      if (code !== 0) return reject(new Error(`Program exited with code ${code}.`));
      resolve();
    });
  }).finally(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  console.log("Program finished.");
}

async function main() {
  const [command, id, ...remaining] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") return usage();
  const db = openDb();
  try {
    if (command === "list") return await listTools(db);
    if (command === "run") {
      if (!id) return usage();
      const args = remaining[0] === "--" ? remaining.slice(1) : remaining;
      return await runTool(db, id, args);
    }
    usage();
    process.exitCode = 2;
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
