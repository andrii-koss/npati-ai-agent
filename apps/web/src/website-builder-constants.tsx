import React from "react";
import { canonicalFrameworkName, type ProjectKind } from "@npati/shared";

export function FrameworkIcon({ id }: { id: string }) {
  if (id === "html-css") {
    return (
      <svg width="24" height="24" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path fill="#E44D26" d="M19.037 113.876L9.032 1.661h109.936l-10.016 112.198-45.019 12.48z" />
        <path fill="#F16529" d="M64 116.8l36.378-10.086 8.559-95.878H64z" />
        <path fill="#EBEBEB" d="M64 52.455H45.788L44.53 38.361H64V24.599H29.489l.33 3.692 3.382 37.927H64zm0 35.743l-.061.017-15.327-4.14-.979-10.975H33.816l1.928 21.609 28.193 7.826.063-.017z" />
        <path fill="#FFFFFF" d="M63.952 52.455v13.763h16.947l-1.597 17.849-15.35 4.143v14.319l28.215-7.82.207-2.325 3.234-36.233.335-3.696h-3.708zm0-27.856v13.762h33.244l.276-3.092.628-6.978.329-3.692z" />
      </svg>
    );
  }
  if (id === "nextjs") {
    return (
      <svg width="24" height="24" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="64" cy="64" r="64" fill="#000000" />
        <path fill="url(#next_devicon_a)" d="M106.317 112.014 49.167 38.4H38.4v51.179h8.614v-40.24l52.54 67.884a64.216 64.216 0 0 0 6.763-5.209z" />
        <path fill="url(#next_devicon_b)" d="M81.778 38.4h8.533v51.2h-8.533z" />
        <defs>
          <linearGradient id="next_devicon_a" x1="109" x2="144.5" y1="116.5" y2="160.5" gradientTransform="scale(.71111)" gradientUnits="userSpaceOnUse">
            <stop stopColor="#ffffff" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="next_devicon_b" x1="121" x2="120.799" y1="54" y2="106.875" gradientTransform="scale(.71111)" gradientUnits="userSpaceOnUse">
            <stop stopColor="#ffffff" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
    );
  }
  if (id === "vite") {
    return (
      <svg width="24" height="24" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="vite_devicon_a" x1="6" x2="235" y1="33" y2="344" gradientTransform="translate(0 .937) scale(.3122)" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#41d1ff" />
            <stop offset="1" stopColor="#bd34fe" />
          </linearGradient>
          <linearGradient id="vite_devicon_b" x1="194.651" x2="236.076" y1="8.818" y2="292.989" gradientTransform="translate(0 .937) scale(.3122)" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ffea83" />
            <stop offset=".083" stopColor="#ffdd35" />
            <stop offset="1" stopColor="#ffa800" />
          </linearGradient>
        </defs>
        <path fill="url(#vite_devicon_a)" d="M124.766 19.52 67.324 122.238c-1.187 2.121-4.234 2.133-5.437.024L3.305 19.532c-1.313-2.302.652-5.087 3.261-4.622L64.07 25.187a3.09 3.09 0 0 0 1.11 0l56.3-10.261c2.598-.473 4.575 2.289 3.286 4.594Zm0 0" />
        <path fill="url(#vite_devicon_b)" d="M91.46 1.43 48.954 9.758a1.56 1.56 0 0 0-1.258 1.437l-2.617 44.168a1.563 1.563 0 0 0 1.91 1.614l11.836-2.735a1.562 1.562 0 0 1 1.88 1.836l-3.517 17.219a1.562 1.562 0 0 0 1.985 1.805l7.308-2.223c1.133-.344 2.223.652 1.985 1.812l-5.59 27.047c-.348 1.692 1.902 2.614 2.84 1.164l.625-.968 34.64-69.13c.582-1.16-.421-2.48-1.69-2.234l-12.185 2.352a1.558 1.558 0 0 1-1.793-1.965l7.95-27.562A1.56 1.56 0 0 0 91.46 1.43Zm0 0" />
      </svg>
    );
  }
  if (id === "astro") {
    return (
      <svg width="24" height="24" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="astro_devicon_flame" x1="1001.68" x2="790.326" y1="652.45" y2="1094.91" gradientTransform="scale(.1)" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ff1639" />
            <stop offset="1" stopColor="#ff1639" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path fill="#ffffff" d="M81.504 9.465c.973 1.207 1.469 2.836 2.457 6.09l21.656 71.136a90.079 90.079 0 0 0-25.89-8.765L65.629 30.28a1.833 1.833 0 0 0-3.52.004L48.18 77.902a90.104 90.104 0 0 0-26.003 8.778l21.758-71.14c.996-3.25 1.492-4.876 2.464-6.083a8.023 8.023 0 0 1 3.243-2.398c1.433-.575 3.136-.575 6.535-.575H71.72c3.402 0 5.105 0 6.543.579a7.988 7.988 0 0 1 3.242 2.402Zm0 0" />
        <path fill="#ff5d01" d="M84.094 90.074c-3.57 3.055-10.696 5.137-18.903 5.137-10.07 0-18.515-3.137-20.754-7.356-.8 2.418-.98 5.184-.98 6.954 0 0-.527 8.675 5.508 14.71a5.671 5.671 0 0 1 5.672-5.671c5.37 0 5.367 4.683 5.363 8.488v.336c0 5.773 3.527 10.719 8.543 12.805a11.62 11.62 0 0 1-1.172-5.098c0-5.508 3.23-7.555 6.988-9.938 2.989-1.894 6.309-4 8.594-8.222a15.513 15.513 0 0 0 1.875-7.41 15.55 15.55 0 0 0-.734-4.735Zm0 0" />
        <path fill="url(#astro_devicon_flame)" d="M84.094 90.074c-3.57 3.055-10.696 5.137-18.903 5.137-10.07 0-18.515-3.137-20.754-7.356-.8 2.418-.98 5.184-.98 6.954 0 0-.527 8.675 5.508 14.71a5.671 5.671 0 0 1 5.672-5.671c5.37 0 5.367 4.683 5.363 8.488v.336c0 5.773 3.527 10.719 8.543 12.805a11.62 11.62 0 0 1-1.172-5.098c0-5.508 3.23-7.555 6.988-9.938 2.989-1.894 6.309-4 8.594-8.222a15.513 15.513 0 0 0 1.875-7.41 15.55 15.55 0 0 0-.734-4.735Zm0 0" />
      </svg>
    );
  }
  if (id === "vue") {
    return (
      <svg width="24" height="24" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path fill="#41B883" d="M78.8 10 64 35.6 49.2 10H0l64 110.9L128 10z" />
        <path fill="#34495E" d="M78.8 10 64 35.6 49.2 10H25.6L64 76.5 102.4 10z" />
      </svg>
    );
  }
  if (id === "phaser") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#c084fc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2 3 7v10l9 5 9-5V7z" />
        <path d="M10 17V8h3a2.5 2.5 0 0 1 0 5h-3" />
      </svg>
    );
  }
  if (id === "three") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2 2 21h20z" />
        <path d="M12 2v13M2 21l10-6 10 6" />
      </svg>
    );
  }
  if (id === "flutter") {
    return (
      <svg width="24" height="24" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path fill="#47C5FB" d="M76.4 2 12.8 65.6l19.7 19.7L115.8 2z" />
        <path fill="#47C5FB" d="M76.4 60.9 42.4 95.1l19.7 19.9 19.6-19.6 34.1-34.5z" />
        <path fill="#00569E" d="M62.1 115l14.9 13h38.9L81.7 95.4z" />
        <path fill="#00B5F8" d="M42.3 95.2 62 75.5l19.7 19.8L62.1 115z" />
      </svg>
    );
  }
  if (id === "nuxt") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#00DC82" d="M13.5 19h6.9c.5 0 1-.1 1.3-.4.4-.2.5-.6.5-.9 0-.3-.1-.6-.3-1l-4.6-7.9c-.2-.4-.4-.6-.7-.8-.3-.2-.6-.3-.9-.3-.4 0-.7.1-1 .3-.3.2-.5.4-.7.8l-1.2 2-2.3-4c-.2-.3-.4-.6-.7-.8-.3-.2-.6-.3-1-.3s-.7.1-1 .3c-.3.2-.5.5-.7.8L1.3 17c-.2.4-.3.7-.3 1 0 .3.2.7.5.9.3.3.8.4 1.3.4h4.3c1.7 0 3-.8 3.8-2.2l2.1-3.6 1.1-1.9 3.4 5.8h-4.5z"/></svg>
    );
  }
  if (id === "sveltekit") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path stroke="#FF3E00" strokeWidth="2.4" strokeLinecap="round" d="M16.5 5.5c-2-1.6-5-1.3-6.8.5l-3 3c-1.6 1.6-1.4 4 .4 5.2 1 .7 2.3.8 3.4.3M7.5 18.5c2 1.6 5 1.3 6.8-.5l3-3c1.6-1.6 1.4-4-.4-5.2-1-.7-2.3-.8-3.4-.3"/></svg>
    );
  }
  if (id === "angular") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#DD0031" d="M12 2 3 5.2l1.4 11.9L12 22l7.6-4.9L21 5.2z"/><path fill="#fff" d="m12 5-5.6 12.5h2.1l1.1-2.8h4.8l1.1 2.8h2.1zm1.6 8H10.4L12 9.2z"/></svg>
    );
  }
  if (id === "express-react") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="2.2" fill="#61DAFB"/><g stroke="#61DAFB" strokeWidth="1.4"><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/></g></svg>
    );
  }
  if (id === "nestjs") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#E0234E" d="M12 2 3.5 7v10l8.5 5 8.5-5V7zm0 3.3 5.7 3.3v6.8L12 18.7l-5.7-3.3V8.6z"/><circle cx="12" cy="12" r="2.4" fill="#E0234E"/></svg>
    );
  }
  if (id === "fastapi") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="#009688"/><path fill="#fff" d="M13 4.5 6.5 13.5H11l-1 6 7-9.5h-4.5z"/></svg>
    );
  }
  if (id === "shadcn") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" d="M20 12 12 20M18 4 4 18"/></svg>
    );
  }
  if (id === "game") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffcf4a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="6" width="20" height="12" rx="6" />
        <path d="M6 12h4M8 10v4" />
        <circle cx="15.5" cy="11" r="1" fill="#ffcf4a" />
        <circle cx="18" cy="13" r="1" fill="#ffcf4a" />
      </svg>
    );
  }
  if (id === "expo") {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="6" y="2" width="12" height="20" rx="3" />
        <path d="M11 18h2" />
      </svg>
    );
  }
  return null;
}

export interface FrameworkStarterOption {
  id: "html-css" | "nextjs" | "vite" | "vue" | "astro" | "nuxt" | "sveltekit" | "angular" | "express-react" | "nestjs" | "fastapi" | "shadcn" | "game" | "phaser" | "three" | "expo" | "flutter";
  frameworkKey: "HTML/CSS" | "Next.js" | "Vite" | "Vue 3 + Vite" | "Astro" | "Nuxt" | "SvelteKit" | "Angular" | "Express" | "NestJS" | "FastAPI" | "Expo" | "Flutter";
  /** What the starter creates; shown and filtered on the Projects page. */
  kind: ProjectKind;
  name: string;
  runtimeLabel: string;
  runtimeLabelUk: string;
  verifiedLabel: string;
  tags: string[];
  defaultPort: number;
  defaultType: "website" | "landing_page" | "web_app" | "mobile_app";
  defaultName: string;
  defaultNameUk: string;
  defaultDesc: string;
  defaultDescUk: string;
}

export const FRAMEWORK_STARTERS: FrameworkStarterOption[] = [
  {
    id: "html-css",
    frameworkKey: "HTML/CSS",
    name: "HTML / CSS",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["HTML5", "CSS3", "JavaScript", "Instant Preview", "Static Build"],
    defaultPort: 3000,
    defaultType: "website",
    kind: "website",
    defaultName: "Modern HTML/CSS Website",
    defaultNameUk: "Сучасний HTML/CSS сайт",
    defaultDesc: "Clean, responsive static website with modern HTML5, CSS3 layout, and instant live preview.",
    defaultDescUk: "Швидкий адаптивний статичний сайт із сучасним макетом на HTML5 та CSS3.",
  },
  {
    id: "nextjs",
    frameworkKey: "Next.js",
    name: "Next.js",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["App Router", "React 18", "TypeScript", "Server Actions", "API Routes"],
    defaultPort: 3000,
    defaultType: "website",
    kind: "website",
    defaultName: "Next.js Web Platform",
    defaultNameUk: "Веб-платформа Next.js",
    defaultDesc: "Full-stack web application powered by Next.js 14 App Router, TypeScript, and server components.",
    defaultDescUk: "Повнофункціональний веб-застосунок на Next.js 14 App Router з підтримкою TypeScript.",
  },
  {
    id: "vite",
    frameworkKey: "Vite",
    name: "Vite",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["React 18", "Vite HMR", "TypeScript", "SPA", "Tailwind CSS"],
    defaultPort: 5173,
    defaultType: "web_app",
    kind: "web_app",
    defaultName: "Vite React Studio",
    defaultNameUk: "Vite React Студія",
    defaultDesc: "Ultra-fast single page application with instant Vite HMR, React 18, and modular components.",
    defaultDescUk: "Ультрашвидкий SPA-застосунок з миттєвим гарячим перезавантаженням на Vite та React 18.",
  },
  {
    id: "vue",
    frameworkKey: "Vue 3 + Vite",
    kind: "web_app",
    name: "Vue",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["Vue 3","Vite HMR","Composition API","SPA"],
    defaultPort: 5173,
    defaultType: "web_app",
    defaultName: "Vue Web App",
    defaultNameUk: "Вебзастосунок на Vue",
    defaultDesc: "Single page application with Vue 3, the Composition API and instant Vite updates.",
    defaultDescUk: "Односторінковий застосунок на Vue 3 з Composition API та миттєвим оновленням Vite.",
  },
  {
    id: "astro",
    frameworkKey: "Astro",
    name: "Astro",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["Islands", "Zero JS", "Markdown / MDX", "Content Collections", "Multi-page"],
    defaultPort: 4321,
    defaultType: "website",
    kind: "website",
    defaultName: "Astro Content Hub",
    defaultNameUk: "Контент-хаб на Astro",
    defaultDesc: "High-performance content website with Astro islands architecture and zero unnecessary JavaScript.",
    defaultDescUk: "Високопродуктивний сайт з острівною архітектурою Astro та мінімальним завантаженням JS.",
  },
  {
    id: "nuxt",
    frameworkKey: "Nuxt",
    kind: "website",
    name: "Nuxt",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["Vue 3","SSR","File routing","Server routes"],
    defaultPort: 3000,
    defaultType: "website",
    defaultName: "Nuxt Website",
    defaultNameUk: "Сайт на Nuxt",
    defaultDesc: "Vue website with server-side rendering, file-based routes and server API routes.",
    defaultDescUk: "Сайт на Vue із серверним рендерингом, маршрутами за файлами та серверними API.",
  },
  {
    id: "sveltekit",
    frameworkKey: "SvelteKit",
    kind: "web_app",
    name: "SvelteKit",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["Svelte 5","SSR","Form actions","File routing"],
    defaultPort: 5173,
    defaultType: "web_app",
    defaultName: "SvelteKit App",
    defaultNameUk: "Застосунок на SvelteKit",
    defaultDesc: "Fast web application with Svelte, server rendering and form actions.",
    defaultDescUk: "Швидкий вебзастосунок на Svelte із серверним рендерингом і серверними формами.",
  },
  {
    id: "angular",
    frameworkKey: "Angular",
    kind: "web_app",
    name: "Angular",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["Angular 19","TypeScript","Standalone","SPA"],
    defaultPort: 3000,
    defaultType: "web_app",
    defaultName: "Angular App",
    defaultNameUk: "Застосунок на Angular",
    defaultDesc: "Structured TypeScript application for business dashboards and internal tools.",
    defaultDescUk: "Структурований застосунок на TypeScript для бізнес-панелей та внутрішніх сервісів.",
  },
  {
    id: "express-react",
    frameworkKey: "Express",
    kind: "web_app",
    name: "Express + React",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["Express","React 18","REST API","Vite"],
    defaultPort: 3000,
    defaultType: "web_app",
    defaultName: "Express React App",
    defaultNameUk: "Застосунок Express + React",
    defaultDesc: "React frontend with an Express REST API served from one project.",
    defaultDescUk: "Фронтенд на React і REST API на Express в одному проєкті.",
  },
  {
    id: "nestjs",
    frameworkKey: "NestJS",
    kind: "api",
    name: "API · NestJS",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["NestJS","TypeScript","REST API","Modules"],
    defaultPort: 3000,
    defaultType: "web_app",
    defaultName: "NestJS API",
    defaultNameUk: "API на NestJS",
    defaultDesc: "Modular TypeScript backend with controllers and dependency injection.",
    defaultDescUk: "Модульний бекенд на TypeScript із контролерами та впровадженням залежностей.",
  },
  {
    id: "fastapi",
    frameworkKey: "FastAPI",
    kind: "api",
    name: "API · FastAPI",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["Python","FastAPI","REST API","OpenAPI docs"],
    defaultPort: 8000,
    defaultType: "web_app",
    defaultName: "FastAPI Service",
    defaultNameUk: "Сервіс на FastAPI",
    defaultDesc: "Python API with automatic documentation, ready for services and AI backends.",
    defaultDescUk: "API на Python з автоматичною документацією для сервісів та AI-бекендів.",
  },
  {
    id: "shadcn",
    frameworkKey: "Vite",
    kind: "web_app",
    name: "React · shadcn/ui",
    runtimeLabel: "Shared NPATI Sandbox runtime",
    runtimeLabelUk: "Спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["React 18","Tailwind CSS","shadcn/ui","Vite"],
    defaultPort: 5173,
    defaultType: "web_app",
    defaultName: "shadcn/ui App",
    defaultNameUk: "Застосунок на shadcn/ui",
    defaultDesc: "React interface with Tailwind CSS and shadcn/ui style components.",
    defaultDescUk: "Інтерфейс на React із Tailwind CSS та компонентами в стилі shadcn/ui.",
  },
  {
    id: "game",
    frameworkKey: "HTML/CSS",
    kind: "game",
    name: "Game · HTML5 Canvas",
    runtimeLabel: "Browser game, shared NPATI Sandbox runtime",
    runtimeLabelUk: "Браузерна гра, спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["Canvas", "Game loop", "Keyboard", "Touch", "No dependencies"],
    defaultPort: 3000,
    defaultType: "website",
    defaultName: "Arcade Game",
    defaultNameUk: "Аркадна гра",
    defaultDesc: "A playable 2D browser game: catch stars, dodge rocks, score and lives. Extend it in chat.",
    defaultDescUk: "Готова 2D-гра в браузері: ловіть зірки, уникайте каміння, рахунок і життя. Розвивайте її в чаті.",
  },
  {
    id: "phaser",
    frameworkKey: "Vite",
    kind: "game",
    name: "Game · Phaser",
    runtimeLabel: "Browser game, shared NPATI Sandbox runtime",
    runtimeLabelUk: "Браузерна гра, спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["Phaser 3","Arcade physics","Platformer","Keyboard"],
    defaultPort: 5173,
    defaultType: "website",
    defaultName: "Phaser Platformer",
    defaultNameUk: "Платформер на Phaser",
    defaultDesc: "A playable Phaser platformer with arcade physics and keyboard controls. Extend it in chat.",
    defaultDescUk: "Готовий платформер на Phaser з аркадною фізикою та керуванням із клавіатури. Розвивайте його в чаті.",
  },
  {
    id: "three",
    frameworkKey: "Vite",
    kind: "web_app",
    name: "3D scene · Three.js",
    runtimeLabel: "WebGL, shared NPATI Sandbox runtime",
    runtimeLabelUk: "WebGL, спільне середовище NPATI Sandbox",
    verifiedLabel: "Verified",
    tags: ["Three.js","WebGL","OrbitControls","Lighting"],
    defaultPort: 5173,
    defaultType: "web_app",
    defaultName: "Three.js Scene",
    defaultNameUk: "3D-сцена на Three.js",
    defaultDesc: "An interactive 3D scene with objects, lighting and a mouse-controlled camera.",
    defaultDescUk: "Інтерактивна 3D-сцена з об'єктами, освітленням і камерою, що керується мишею.",
  },
  {
    id: "expo",
    frameworkKey: "Expo",
    kind: "mobile_app",
    name: "Mobile app · Expo",
    runtimeLabel: "React Native with web preview",
    runtimeLabelUk: "React Native з веб-превʼю",
    verifiedLabel: "Verified",
    tags: ["Expo", "React Native", "iOS", "Android", "Web preview"],
    defaultPort: 3000,
    defaultType: "mobile_app",
    defaultName: "Mobile App",
    defaultNameUk: "Мобільний застосунок",
    defaultDesc: "An Expo / React Native app with a web preview, connected to the project data backend.",
    defaultDescUk: "Застосунок на Expo / React Native з веб-превʼю та підключенням до даних проєкту.",
  },
  {
    id: "flutter",
    frameworkKey: "Flutter",
    kind: "mobile_app",
    name: "Mobile app · Flutter",
    runtimeLabel: "Flutter with web preview",
    runtimeLabelUk: "Flutter з веб-превʼю",
    verifiedLabel: "Verified",
    tags: ["Flutter","Dart","Material","iOS","Android","Web preview"],
    defaultPort: 3000,
    defaultType: "mobile_app",
    defaultName: "Flutter App",
    defaultNameUk: "Застосунок на Flutter",
    defaultDesc: "A Flutter app with a list, an add form and a web preview.",
    defaultDescUk: "Застосунок на Flutter зі списком, формою додавання та веб-превʼю.",
  },
];

export function frameworkStarterForProject(project: { framework?: string; kind?: ProjectKind; type?: string }) {
  const framework = project.framework?.trim().toLowerCase();
  let candidates = FRAMEWORK_STARTERS;
  if (framework) {
    candidates = FRAMEWORK_STARTERS.filter(starter =>
      [starter.id, starter.frameworkKey, starter.name].some(value => value.toLowerCase() === framework),
    );
    if (candidates.length === 0) {
      const canonical = canonicalFrameworkName(framework);
      if (canonical) candidates = FRAMEWORK_STARTERS.filter(starter => canonicalFrameworkName(starter.frameworkKey) === canonical);
    }
  }
  return candidates.find(starter => starter.kind === project.kind)
    ?? candidates.find(starter => starter.defaultType === project.type)
    ?? candidates[0];
}

/** Projects page labels for each project kind. */
export const PROJECT_KIND_LABELS: Record<ProjectKind, { en: string; uk: string }> = {
  website: { en: "Website", uk: "Сайт" },
  web_app: { en: "Web app", uk: "Вебзастосунок" },
  game: { en: "Game", uk: "Гра" },
  mobile_app: { en: "Mobile app", uk: "Мобільний застосунок" },
  api: { en: "API / backend", uk: "API / бекенд" },
};

export const websiteBuilderCopy = {
  en: {
    eyebrow: "Project Studio",
    title: "Projects",
    subtitle: "Create and edit websites, web apps, games and mobile apps with Coding Agent in chat and view changes in Live Preview.",
    newWebsite: "Create Project",
    searchPlaceholder: "Search projects by name or purpose...",
    filterAll: "All Frameworks",
    filterKindAll: "All Types",
    filterStatusAll: "All Statuses",
    statusActive: "Active Only",
    statusArchived: "Archived Only",
    emptyTitle: "No projects created yet",
    emptySubtitle: "Create your first website, game or mobile app from a starter, or ask the AI agent in Chat.",
    createNow: "Create Your First Project",
    openBuilder: "Edit in chat",
    preview: "Live Preview",
    duplicate: "Duplicate",
    rename: "Rename",
    archive: "Archive",
    delete: "Delete",
    restore: "Restore",
    loadError: "Failed to load projects",
    renamePrompt: "Enter new project name:",
    archivePrompt: "Archive this project? It will remain accessible under archived filter.",
    deletePrompt: "Permanently delete this project and all its files? This action cannot be undone.",
    drawerKicker: "PROJECT STARTER",
    drawerTitle: "Create New Project",
    drawerSubtitle: "Choose a website, game or mobile app starter and customize your project details.",
    sectionTemplate: "1. Choose Project Starter",
    sectionDomain: "2. Domain & SSL / Network",
    domainTitle: "Domain",
    domainDesc: "In this section you can edit a domain",
    domainWarning: "Whenever you make changes to domains, remember to redeploy your compose to apply the changes.",
    domainLabel: "Domain",
    domainPlaceholder: "example.com",
    technicalDomainNotice: "If no domain is entered, a temporary technical domain will be assigned automatically",
    pathLabel: "Path",
    pathDesc: 'The path where your application expects to receive requests internally (defaults to "/")',
    stripPathLabel: "Remove the external path from the request before forwarding to the application",
    portLabel: "Port",
    portDesc: "The port where your application is running inside the container (e.g., 3000 for Node.js, 80 for Nginx, 8080 for Java)",
    customEntrypointLabel: "Use custom entrypoint for domain",
    customEntrypointDesc: '"web" and/or "websecure" is used by default.',
    sslLabel: "Automatically provision SSL Certificate.",
    letsEncryptTitle: "Let's Encrypt",
    letsEncryptDesc: "Let's Encrypt auto-provisions a certificate automatically for this host.",
    nameLabel: "Project Name",
    descLabel: "Purpose & Description",
    frameworkLabel: "Framework",
    typeLabel: "Project Type",
    typeWebsite: "Multi-page Website",
    typeLanding: "Single-page Landing",
    typeWebApp: "Web Application",
    typeMobileApp: "Mobile app (Expo / React Native)",
    cancel: "Cancel",
    createBtn: "Create Project & Edit in chat →",
    creating: "Creating Project & Files...",
    pages: "pages",
    updated: "Updated",
    liveStatus: "Live Preview",
    readyStatus: "Ready",
    buildingStatus: "Building...",
  },
  uk: {
    eyebrow: "Студія проєктів",
    title: "Проєкти",
    subtitle: "Створюйте й редагуйте сайти, вебзастосунки, ігри та мобільні застосунки через Coding Agent у чаті й переглядайте зміни в Live Preview.",
    newWebsite: "Створити проєкт",
    searchPlaceholder: "Пошук проєктів за назвою чи описом...",
    filterAll: "Усі фреймворки",
    filterKindAll: "Усі типи",
    filterStatusAll: "Усі статуси",
    statusActive: "Тільки активні",
    statusArchived: "Тільки архівні",
    emptyTitle: "Проєктів ще не створено",
    emptySubtitle: "Створіть перший сайт, гру чи мобільний застосунок зі стартового шаблону або попросіть AI агента в Chat, наприклад «Створи гру змійка».",
    createNow: "Створити перший проєкт",
    openBuilder: "Редагувати в чаті",
    preview: "Live Preview",
    duplicate: "Дублювати",
    rename: "Перейменувати",
    archive: "Архівувати",
    delete: "Видалити",
    restore: "Відновити",
    loadError: "Не вдалося завантажити проєкти",
    renamePrompt: "Введіть нову назву проєкту:",
    archivePrompt: "Архівувати цей проєкт? Його можна буде переглянути через фільтр архівних.",
    deletePrompt: "Назавжди видалити цей проєкт і всі його файли? Цю дію неможливо скасувати.",
    drawerKicker: "СТАРТОВИЙ ПРОЄКТ",
    drawerTitle: "Створити новий проєкт",
    drawerSubtitle: "Оберіть стартовий шаблон сайту, гри чи мобільного застосунку.",
    sectionTemplate: "1. Оберіть стартовий шаблон",
    sectionDomain: "2. Домен, порт та SSL-сертифікат",
    domainTitle: "Домен",
    domainDesc: "У цьому розділі ви можете налаштувати прив'язку домену",
    domainWarning: "Кожного разу при зміні доменів не забудьте перерозгорнути compose, щоб застосувати зміни.",
    domainLabel: "Домен",
    domainPlaceholder: "example.com",
    technicalDomainNotice: "Якщо домен не вказано, автоматично буде створено технічний домен",
    pathLabel: "Шлях (Path)",
    pathDesc: 'Шлях, за яким застосунок очікує отримувати внутрішні запити (за замовчуванням "/")',
    stripPathLabel: "Видалити зовнішній шлях із запиту перед перенаправленням до застосунку",
    portLabel: "Порт (Port)",
    portDesc: "Порт, на якому працює застосунок усередині контейнера (наприклад, 3000 для Node.js, 80 для Nginx, 8080 для Java)",
    customEntrypointLabel: "Використовувати власну точку входу для домену",
    customEntrypointDesc: 'За замовчуванням використовуються "web" та/або "websecure".',
    sslLabel: "Автоматично згенерувати SSL-сертифікат.",
    letsEncryptTitle: "Let's Encrypt",
    letsEncryptDesc: "Let's Encrypt автоматично генерує та оновлює сертифікат для цього хоста.",
    nameLabel: "Назва проєкту",
    descLabel: "Призначення та опис",
    frameworkLabel: "Фреймворк",
    typeLabel: "Тип проєкту",
    typeWebsite: "Багатосторінковий сайт",
    typeLanding: "Односторінковий лендінг",
    typeWebApp: "Вебзастосунок",
    typeMobileApp: "Мобільний застосунок (Expo / React Native)",
    cancel: "Скасувати",
    createBtn: "Створити проєкт і редагувати в чаті →",
    creating: "Створення проєкту та файлів...",
    pages: "стор.",
    updated: "Оновлено",
    liveStatus: "Live Preview",
    readyStatus: "Готовий",
    buildingStatus: "Збірка...",
  },
};
