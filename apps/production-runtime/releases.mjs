import { randomUUID } from "node:crypto";
import { chmod, chown, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { maxReleaseBytes, maxSnapshotBytes, ProductionError, safeFile } from "./config.mjs";
import { publicFile } from "./http.mjs";
import { allocateUid, readPackage, runBuild, setReleaseOwnership, startApplication } from "./workloads.mjs";

export const dataDir = "/srv/production";
export const projectDir = key => join(dataDir, key);
const releaseDir = (key, id) => join(projectDir(key), id);
export const rootFor = (record, release) => join(releaseDir(record.key, release.id), "source", release.output);
const readJson = async path => JSON.parse(await readFile(path, "utf8"));
export const readOptionalJson = async path => readJson(path).catch(error => {
  if (error.code === "ENOENT") return null;
  throw error;
});
export const discardRelease = (record, release) => rm(releaseDir(record.key, release.id), { recursive: true, force: true });

function validSnapshotPath(path) {
  return safeFile(path) && !path.split("/").some(name => name.startsWith(".") || name.toLowerCase() === "node_modules")
    && !/^(?:deployment\.json|npm-debug\.log)$/i.test(path);
}

export function validateSnapshot(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 4000) throw new ProductionError(400, "Invalid deployment snapshot file count.");
  const seen = new Set();
  let bytes = 0;
  for (const { path, data } of files) {
    if (!validSnapshotPath(path) || seen.has(path) || typeof data !== "string" ||
        data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new ProductionError(400, "Invalid file in deployment snapshot.");
    }
    seen.add(path);
    bytes += Buffer.byteLength(data, "base64");
    if (bytes > maxSnapshotBytes) throw new ProductionError(413, "Deployment snapshot exceeds 24 MiB.");
  }
  for (const path of seen) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join("/"))) throw new ProductionError(400, "Conflicting file paths in deployment snapshot.");
    }
  }
}

async function checkDisk(root) {
  let bytes = 0;
  let count = 0;
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++count > 100000) throw new Error("Release contains more than 100,000 entries.");
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        bytes += (await lstat(path)).size;
        if (bytes > maxReleaseBytes) throw new Error("Release is larger than 512 MiB.");
      }
    }
  };
  await walk(root);
}

export async function buildRelease(record, settings, files, log, environment) {
  const id = randomUUID();
  const folder = releaseDir(record.key, id);
  const staging = join("/builds", id);
  const source = join(staging, "source");
  const buildHome = join(staging, "home");
  const uid = allocateUid();
  const buildUid = allocateUid();
  try {
    await mkdir(source, { recursive: true, mode: 0o700 });
    await chmod(staging, 0o711);
    await mkdir(buildHome, { mode: 0o700 });
    await chown(buildHome, buildUid, buildUid);
    for (const { path, data } of files) {
      const target = join(source, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, Buffer.from(data, "base64"), { flag: "wx", mode: 0o600 });
    }
    const pkg = await readPackage(source);
    const scripts = pkg?.scripts ?? {};
    if (scripts.build || scripts.start) {
      const install = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }).length > 0;
      const buildOptions = {
        uid: buildUid, cwd: source, temp: buildHome, limits: settings.limits, log,
        command: "/usr/local/bin/npm", env: { CI: "true", npm_config_audit: "false", npm_config_fund: "false" },
      };
      await setReleaseOwnership(source, buildUid, true);
      if (install) {
        if (!files.some(file => file.path === "package-lock.json" || file.path === "npm-shrinkwrap.json")) {
          throw new Error("Add a package-lock.json or npm-shrinkwrap.json before publishing a Node.js project.");
        }
        log("Installing locked dependencies");
        await runBuild({ ...buildOptions, args: ["ci", "--include=dev"] });
      }
      if (scripts.build) {
        log("Running npm run build");
        await runBuild({ ...buildOptions, args: ["run", "build"] });
      }
    }
    let output = "";
    let kind = "static";
    for (const candidate of scripts.build ? ["dist", "out", "build", ""] : [""]) {
      if (candidate === "" && (scripts.build || scripts.start)) {
        if (!scripts.start) throw new Error("Build did not emit a static site in dist, out or build.");
        kind = "node";
        break;
      }
      const index = await lstat(join(source, candidate, "index.html")).catch(() => null);
      const dir = await lstat(join(source, candidate)).catch(() => null);
      if (dir?.isDirectory() && index?.isFile() && publicFile("index.html")) {
        output = candidate;
        break;
      }
      if (!candidate) throw new Error("A static site needs an index.html, or a Node.js project needs npm start.");
    }
    const result = join(source, output);
    await checkDisk(result);
    await mkdir(folder, { mode: 0o711 });
    const target = join(folder, "source");
    await cp(result, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    await setReleaseOwnership(target, uid);
    return { id, uid, kind, output: "", settings, environment, createdAt: new Date().toISOString() };
  } catch (error) {
    await discardRelease(record, { id });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function applicationFor(record, release, log) {
  if (release.kind !== "node") return Promise.resolve(null);
  return startApplication({
    root: rootFor(record, release), connectionDir: `/tmp/npati-app-${release.uid}`,
    uid: release.uid, port: release.settings.port, limits: release.settings.limits, env: release.environment, log,
  });
}
