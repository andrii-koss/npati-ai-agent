// TypeScript projects consuming workspace source do not all include the package-local
// wildcard declaration; tsup still bundles this import through its .sql text loader.
// @ts-ignore SQL is a text asset, not a JavaScript module.
import migration001 from "../migrations/001_business_workspace.sql";

export default migration001;
