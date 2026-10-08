#!/usr/bin/env node
// @ts-check
/**
 * C15 (owner decision 2) — the `npati` binary.
 *
 * Three lines on purpose: the dispatch, the token handling and the exit code live in `src/main.mjs`, which is a
 * module a test can import. A `bin` that contained the logic would be a `bin` that could only be tested by spawning
 * a process.
 *
 * Plain `.mjs`, not TypeScript: `npm install` links this file into `node_modules/.bin` and it must run under every
 * Node version the repository's `engines` field allows (`>=22.22.2 <23 || >=24 <27`). Node's type stripping covers
 * only the 22.6+ half of that range, so a `.ts` bin would work on some of the supported versions and not others.
 */
import { main } from "../src/main.mjs";

process.exitCode = await main();
