import dependencyLocks from "./project-framework-locks.json";

/** Keep build/runtime entry points; user-facing content is written by the agent. */
export function minimalHtml(name: string): string {
  const title = name.replace(/[<>&"]/g, "");
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + title + '</title></head><body><main></main></body></html>\n';
}
export function finalizeMinimalScaffold(files: Record<string,string>, framework: string): Record<string,string> {
  const entries: Record<string, Record<string,string>> = {
    "React + Vite": {"src/App.jsx": "export default function App() { return <main />; }\n"},
    "Vue 3 + Vite": {"src/App.vue": "<template><main /></template>\n"},
    "Nuxt": {"pages/index.vue": "<template><main /></template>\n"},
    "SvelteKit": {"src/routes/+page.svelte": "<main></main>\n"},
    "Astro": {"src/pages/index.astro": '<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Website</title></head><body><main></main></body></html>\n'},
    "Angular": {"src/app/app.component.ts": 'import { Component } from "@angular/core";\n@Component({selector:"app-root",standalone:true,template:"<main></main>"})\nexport class AppComponent {}\n'},
    "Remix": {"app/routes/home.tsx": "export default function Home() { return <main />; }\n"},
  };
  Object.assign(files, entries[framework]);
  for (const file of Object.keys(files)) if (/^(?:src\/styles\.css|app\/app\.css)$/.test(file)) files[file] = "/* Project styles */\n";
  const runtimeLock = (dependencyLocks as Record<string, { requirements?: string; composer?: unknown; composerManifest?: unknown }>)[framework];
  if (files["requirements.txt"] && runtimeLock?.requirements) files["requirements.txt"] = runtimeLock.requirements;
  if (files["composer.json"] && runtimeLock?.composer) {
    files["composer.json"] = JSON.stringify(runtimeLock.composerManifest, null, 2) + "\n";
    files["composer.lock"] = JSON.stringify(runtimeLock.composer, null, 2) + "\n";
  }
  if (files["package.json"]) {
    const manifest = JSON.parse(files["package.json"]);
    for (const group of ["dependencies","devDependencies"]) for (const key of Object.keys(manifest[group] ?? {})) {
      manifest[group][key] = manifest[group][key].replace(/^[~^]/, "");
    }
    files["package.json"] = JSON.stringify(manifest,null,2)+"\n";
    const stored = (dependencyLocks as Record<string,unknown>)[framework];
    if (stored) {
      const lock = JSON.parse(JSON.stringify(stored));
      lock.name = manifest.name;
      if (lock.packages?.[""]) lock.packages[""].name = manifest.name;
      files["package-lock.json"] = JSON.stringify(lock,null,2)+"\n";
    }
  }
  return files;
}
export function minimalNextScaffold(name: string): Record<string,string> {
  return finalizeMinimalScaffold({
    "package.json": JSON.stringify({name:name.toLowerCase().replace(/[^a-z0-9-]/g,"-") || "website",version:"0.1.0",private:true,scripts:{dev:"next dev --hostname 0.0.0.0",build:"next build",start:"next start --hostname 0.0.0.0"},dependencies:{next:"14.2.35",react:"18.3.1","react-dom":"18.3.1"},devDependencies:{"@types/node":"20.17.10","@types/react":"18.3.18","@types/react-dom":"18.3.5",typescript:"5.7.2"}}),
    "app/layout.tsx": 'import type { ReactNode } from "react";\nimport "./globals.css";\nexport default function RootLayout({children}:{children:ReactNode}) { return <html lang="en"><body>{children}</body></html>; }\n',
    "app/page.tsx": "export default function Page() { return <main />; }\n",
    "app/globals.css": "/* Project styles */\n",
    "next.config.mjs": "export default { experimental: { cpus: 2 } };\n",
    "next-env.d.ts": '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
    "tsconfig.json": JSON.stringify({compilerOptions:{target:"ES2017",lib:["dom","dom.iterable","esnext"],allowJs:true,skipLibCheck:true,strict:true,noEmit:true,esModuleInterop:true,module:"esnext",moduleResolution:"bundler",resolveJsonModule:true,isolatedModules:true,jsx:"preserve",incremental:true,plugins:[{name:"next"}]},include:["next-env.d.ts","**/*.ts","**/*.tsx",".next/types/**/*.ts"],exclude:["node_modules"]},null,2)+"\n",
  },"Next.js");
}
