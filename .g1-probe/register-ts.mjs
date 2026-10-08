/**
 * G1 (D1) probe bootstrap: register the extension-adding resolver hook.
 *
 * `--import <file>` only *imports* a module; a `resolve` export becomes a hook only when the module is passed
 * to `module.register`, which is what this file does.
 */
import { register } from "node:module";

register("./ts-resolve.mjs", import.meta.url);
