#!/usr/bin/env node
export * from "./lib/source-size-guard.mjs";
export { main } from "./lib/source-size-guard.mjs";
import { isEntryPoint, main } from "./lib/source-size-guard.mjs";

if (isEntryPoint(process.argv, import.meta.url)) process.exit(main(process.argv.slice(2)));
