// Fills a read-only npm cache with packages agents add most often, so installing them needs little or no network.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cache = '/opt/npati-project-toolchain/npm-cache';
const groups = [
  ['typescript', '@types/node', '@types/react', '@types/react-dom', 'vite', '@vitejs/plugin-react', 'react', 'react-dom', 'react-router-dom', 'lucide-react', 'clsx'],
  ['tailwindcss', '@tailwindcss/vite', 'postcss', 'autoprefixer'],
  ['vue', 'vue-router', 'pinia', '@vitejs/plugin-vue', 'vue-tsc'],
  ['express', 'cors', 'helmet', 'dotenv', 'cookie-parser', 'morgan', 'bcryptjs', 'bcrypt', 'jsonwebtoken', 'better-sqlite3', 'sqlite3', 'pg', 'zod', 'uuid', 'nanoid', 'nodemon', 'concurrently', 'tsx'],
  ['vitest', 'jest', 'supertest', 'jsdom', '@testing-library/react', '@testing-library/jest-dom', '@testing-library/user-event', 'playwright'],
  ['eslint', '@eslint/js', 'typescript-eslint', 'prettier', 'axios', 'date-fns', 'lodash', 'three', 'phaser', 'chart.js', 'recharts', 'framer-motion', 'zustand'],
];

fs.mkdirSync(cache, { recursive: true });
for (const [index, packages] of groups.entries()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `npati-cache-${index}-`));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: `npati-cache-${index}`, version: '0.0.0', private: true }));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--legacy-peer-deps', `--cache=${cache}`, ...packages], { cwd: directory, stdio: 'inherit' });
  fs.rmSync(directory, { recursive: true, force: true });
}
fs.writeFileSync(path.join(cache, '.stamp'), String(Date.now()));
execFileSync('chmod', ['-R', 'a+rX,go-w', cache]);
