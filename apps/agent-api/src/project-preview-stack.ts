/** Framework and server-command detection shared by Preview startup and recovery. */
export interface DetectedStack {
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  framework: string;
  command: string;
  port: number;
  /** Command that serves the verified production build, when the framework has one. */
  productionCommand?: string;
}

export async function detectProjectStack(
  files: Array<{ path: string }>,
  readFile: (filePath: string) => Promise<string>,
): Promise<DetectedStack> {
  const pathSet = new Set(files.map((f) => f.path));

  // 1. Detect Package Manager
  let packageManager: "npm" | "pnpm" | "yarn" | "bun" = "npm";
  if (pathSet.has("pnpm-lock.yaml")) {
    packageManager = "pnpm";
  } else if (pathSet.has("yarn.lock")) {
    packageManager = "yarn";
  } else if (pathSet.has("bun.lock") || pathSet.has("bun.lockb")) {
    packageManager = "bun";
  } else if (pathSet.has("package-lock.json")) {
    packageManager = "npm";
  }

  // 2. Inspect package.json if present
  let pkg: any = null;
  if (pathSet.has("package.json")) {
    try {
      const content = await readFile("package.json");
      pkg = JSON.parse(content);
      if (pkg?.packageManager) {
        if (pkg.packageManager.startsWith("pnpm")) packageManager = "pnpm";
        else if (pkg.packageManager.startsWith("yarn")) packageManager = "yarn";
        else if (pkg.packageManager.startsWith("bun")) packageManager = "bun";
        else if (pkg.packageManager.startsWith("npm")) packageManager = "npm";
      }
    } catch {
      // Ignore parse failure, fallback
    }
  }

  // 3. Framework & Dev command detection
  if (pathSet.has("pubspec.yaml") && /\bflutter\s*:/m.test(await readFile("pubspec.yaml").catch(() => ""))) {
    // An interrupted build leaves index.html without the compiled app, so the compiled file decides.
    const stale = 'if [ ! -f build/web/main.dart.js ] || [ -n "$(find lib web pubspec.yaml -newer build/web/main.dart.js 2>/dev/null | head -1)" ]; then flutter build web; fi';
    return { packageManager, framework: "flutter", command: `${stale} && npx -y serve -s build/web -l 3000`, port: 3000 };
  }
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    // Expo (React Native) projects preview through an Expo Web export served statically (D6).
    // The static export avoids Metro WebSockets and keeps bundle responses inside the preview
    // proxy limits; the port matches the static branch so the existing proxy path is reused.
    const hasExpo = Boolean(deps["expo"] || deps["react-native"] && (pathSet.has("app.json") || pathSet.has("app.config.js") || pathSet.has("app.config.ts")));
    if (hasExpo) {
      const port = 3000;
      const command = pkg.scripts?.export
        ? `${packageManager} run export && npx -y serve -s dist -l ${port}`
        : `npx expo export --platform web --output-dir dist && npx -y serve -s dist -l ${port}`;
      return { packageManager, framework: "expo", command, port };
    }
    const hasNext = Boolean(deps["next"] || Array.from(pathSet).some((p) => /^next\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasVite = Boolean(deps["vite"] || Array.from(pathSet).some((p) => /^vite\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasAstro = Boolean(deps["astro"] || Array.from(pathSet).some((p) => /^astro\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasNuxt = Boolean(deps["nuxt"] || Array.from(pathSet).some((p) => /^nuxt\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasRemix = Boolean(deps["@remix-run/react"] || deps["@react-router/dev"] || deps["@react-router/serve"] || Array.from(pathSet).some((p) => /^(?:remix|react-router)\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasSvelteKit = Boolean(deps["@sveltejs/kit"] || Array.from(pathSet).some((p) => /^svelte\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasAngular = Boolean(deps["@angular/core"]);
    const hasNest = Boolean(deps["@nestjs/core"]);
    const hasFastify = Boolean(deps["fastify"]);
    const hasExpress = Boolean(deps["express"]);

    if (hasNext) {
      const command = pkg.scripts?.dev ? `${packageManager} run dev` : "npx next dev";
      return { packageManager, framework: "nextjs", command, port: 3000, productionCommand: serveCommand("npx next start --hostname 0.0.0.0", 3000) };
    }
    if (hasNuxt) {
      const command = pkg.scripts?.dev ? `${packageManager} run dev` : "npx nuxi dev";
      return { packageManager, framework: "nuxt", command, port: 3000, productionCommand: "node .output/server/index.mjs" };
    }
    if (hasAstro) {
      const command = pkg.scripts?.dev
        ? pkg.scripts.dev.includes("--host") ? `${packageManager} run dev` : `${packageManager} run dev -- --host 0.0.0.0`
        : "npx astro dev --host 0.0.0.0";
      return { packageManager, framework: "astro", command, port: 4321, productionCommand: "npx astro preview --host 0.0.0.0 --port 4321" };
    }
    if (hasSvelteKit) {
      const command = pkg.scripts?.dev
        ? pkg.scripts.dev.includes("--host") ? `${packageManager} run dev` : `${packageManager} run dev -- --host 0.0.0.0`
        : "npx vite --host 0.0.0.0";
      return { packageManager, framework: "sveltekit", command, port: 5173, productionCommand: "node build/index.js" };
    }
    if (hasRemix) {
      const command = pkg.scripts?.dev ? `${packageManager} run dev` : "npx remix dev";
      return { packageManager, framework: "remix", command, port: 3000, productionCommand: "npx react-router-serve ./build/server/index.js" };
    }
    if (hasAngular) {
      // Expose serve's listen argument to the existing port normalizer.
      // Forwarding npm start -- --port is invalid for serve (ARG_UNKNOWN_OPTION).
      const start = typeof pkg.scripts?.start === "string" ? pkg.scripts.start.trim() : "";
      const command = /^serve(?:\s|$)/.test(start)
        ? `npx ${start}`
        : start ? `${packageManager} run start` : "npx serve -s dist -l 3000";
      return { packageManager, framework: "angular", command, port: 3000, productionCommand: command };
    }
    if (hasNest) {
      const command = pkg.scripts?.start ? `${packageManager} run start` : "node dist/main.js";
      return { packageManager, framework: "nestjs", command, port: 3000, productionCommand: "node dist/main.js" };
    }
    if (hasFastify) {
      const command = pkg.scripts?.start ? `${packageManager} run start` : "node dist/server.js";
      return { packageManager, framework: "fastify", command, port: 3000, productionCommand: command };
    }
    if (hasExpress) {
      const command = pkg.scripts?.start ? `${packageManager} run start` : "node dist/server.js";
      return { packageManager, framework: "express", command, port: 3000, productionCommand: command };
    }
    if (hasVite) {
      const framework = deps["vue"] ? "vue" : "vite";
      const command = pkg.scripts?.dev
        ? pkg.scripts.dev.includes("--host") ? `${packageManager} run dev` : `${packageManager} run dev -- --host 0.0.0.0`
        : "npx vite --host 0.0.0.0";
      return { packageManager, framework, command, port: 5173, productionCommand: "npx vite preview --host 0.0.0.0 --port 5173" };
    }
    // A plain HTML page whose scripts only serve its files (serve, http-server, live-server) needs no package: those scripts
    // fetch the server from the network and listen on their own fixed port, so Preview waited on a port nobody used (E2E G5).
    const scripts = [pkg.scripts?.dev, pkg.scripts?.start].filter((script): script is string => typeof script === "string");
    if (pathSet.has("index.html") && scripts.length && scripts.every((script) => /^(?:npx\s+(?:-y\s+|--yes\s+)?)?(?:serve|http-server|live-server)(?:@[\w.^~-]+)?(?:\s|$)/.test(script.trim()))) {
      return { packageManager, framework: "static", command: "python3 -m http.server $PORT --bind 0.0.0.0", port: 3000, productionCommand: "python3 -m http.server $PORT --bind 0.0.0.0" };
    }
    if (pkg.scripts?.dev) {
      return { packageManager, framework: "custom", command: `${packageManager} run dev`, port: 3000 };
    }
    if (pkg.scripts?.start) {
      return { packageManager, framework: "custom", command: `${packageManager} run start`, port: 3000 };
    }
  }

  // Non-Node / Static detection
  if (pathSet.has("manage.py") && pathSet.has("requirements.txt")) {
    const command = ".venv/bin/python manage.py runserver 0.0.0.0:$PORT --noreload";
    return { packageManager, framework: "django", command, port: 8000, productionCommand: command };
  }
  if (pathSet.has("requirements.txt")) {
    let fastapi = false;
    const asgiEntry = pathSet.has("main.py") ? "main.py" : pathSet.has("app/main.py") ? "app/main.py" : null;
    if (asgiEntry) {
      const entry = await readFile(asgiEntry).catch(() => "");
      fastapi = /FastAPI\s*\(|from\s+fastapi\b/.test(entry);
      // Packaged ASGI apps commonly re-export app from main.py; the dependency remains authoritative.
      if (!fastapi) fastapi = /^\s*fastapi(?:\[[^\]\r\n]+\])?\s*(?:[=<>!~;]|$)/im.test(await readFile("requirements.txt").catch(() => ""));
    }
    if (fastapi) {
      const command = `.venv/bin/python -m uvicorn ${asgiEntry === "main.py" ? "main" : "app.main"}:app --host 0.0.0.0 --port $PORT`;
      return { packageManager, framework: "fastapi", command, port: 8000, productionCommand: command };
    }
    if (pathSet.has("app.py")) {
      return { packageManager, framework: "flask", command: ".venv/bin/python app.py", port: 3000, productionCommand: ".venv/bin/python app.py" };
    }
    return { packageManager, framework: "python", command: ".venv/bin/python -m http.server $PORT --bind 0.0.0.0", port: 8000, productionCommand: ".venv/bin/python -m http.server $PORT --bind 0.0.0.0" };
  }
  if (pathSet.has("composer.json")) {
    const command = pathSet.has("artisan") ? "php artisan serve --host=0.0.0.0 --port=$PORT" : "php -S 0.0.0.0:$PORT -t public";
    return { packageManager, framework: pathSet.has("artisan") ? "laravel" : "php", command, port: 8000, productionCommand: command };
  }
  if (pathSet.has("index.php")) {
    return { packageManager, framework: "php", command: "php -S 0.0.0.0:$PORT", port: 8000, productionCommand: "php -S 0.0.0.0:$PORT" };
  }
  if (pathSet.has("index.html")) {
    return { packageManager, framework: "static", command: "python3 -m http.server $PORT --bind 0.0.0.0", port: 3000, productionCommand: "python3 -m http.server $PORT --bind 0.0.0.0" };
  }

  return { packageManager, framework: "static", command: "python3 -m http.server $PORT --bind 0.0.0.0", port: 3000, productionCommand: "python3 -m http.server $PORT --bind 0.0.0.0" };
}

function serveCommand(command: string, port: number): string {
  return `${command} --port ${port}`;
}

export function extractPortFromCommand(command: string, fallbackPort: number): number {
  const match = command.match(/(?:-p|--port|-l)\s+(\d+)/);
  if (match && match[1]) {
    const parsed = Number(match[1]);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  }
  return fallbackPort;
}
