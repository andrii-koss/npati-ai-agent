import { execFileSync, spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { codeSearchTypeArguments } from "../apps/agent-api/src/code-search-types";
const hasRg=spawnSync("rg",["--version"]).status===0;
it.skipIf(!hasRg).each(["tsx","jsx"])("supports the %s extension as a real ripgrep type",type=>{
 const result=spawnSync("rg",[...codeSearchTypeArguments(type).flat(),"--files","apps/web/src"],{encoding:"utf8"});
 expect([0,1]).toContain(result.status);expect(result.stderr).toBe("");
 const paths=result.stdout.trim().split(/\r?\n/).filter(Boolean);
 expect(paths.every(path=>path.endsWith("."+type))).toBe(true);
});
it.skipIf(!hasRg)("combines TSX with a path glob without broadening either filter",()=>{
 const paths=execFileSync("rg",[...codeSearchTypeArguments("tsx").flat(),"--glob","**/BusinessWorkspace*","--files","apps/web/src"],{encoding:"utf8"}).trim().split(/\r?\n/);
 expect(paths).toHaveLength(1);expect(paths[0]).toMatch(/BusinessWorkspace\.tsx$/);
});
it("maps language aliases and preserves native ripgrep type names",()=>{
 expect(codeSearchTypeArguments("typescript")).toEqual([["--type","ts"]]);expect(codeSearchTypeArguments("javascript")).toEqual([["--type","js"]]);expect(codeSearchTypeArguments("css")).toEqual([["--type","css"]]);
});
