/* The clock the in-memory workspace store and its domain delegates share, split out in step 3j of
 * docs/refactoring/PLAN.md so the delegates do not have to import the store back (which would be a cycle).
 */

export const now = () => new Date().toISOString();