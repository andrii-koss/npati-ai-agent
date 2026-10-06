import type { PoolClient } from "pg";

/**
 * Migration 080 — C9 goals, plan revisions and session todos (additive).
 *
 * C9 makes the agent plan before it acts and keeps that plan attached to the session. Four tables, and each
 * one exists because a guarantee had to become structural rather than a rule the application promises to
 * follow:
 *
 *   - `code_session_plans` holds **revisions** of a session plan. Editing a plan creates a new revision, so a
 *     plan that was approved and then changed is visible instead of silently overwritten. `execution_mode` is
 *     a column, never a field read out of the plan body: the plan is repository-facing data produced by the
 *     model, and data must not be able to choose the mode it is executed in. A CHECK enforces that an approved
 *     plan always carries a mode, and a partial unique index allows exactly one approved plan per session, so
 *     "approved" cannot drift into meaning "one of several".
 *   - `code_goals` is the goal-driven execution record. The transition to `completed` is guarded by a trigger
 *     (below) rather than by the service: a goal is not done because code was written, it is done when every
 *     acceptance criterion is verified.
 *   - `code_goal_criteria` are the acceptance criteria as **rows with their own status**, not prose inside the
 *     goal. That is what makes the completion rule checkable by the database.
 *   - `code_session_todos` is the agent-maintained task list. "At most one task in progress" is a partial
 *     unique index, so two parallel `in_progress` rows cannot exist even if two writers race; the service
 *     still refuses first with a structured error so the model gets a usable message instead of a constraint
 *     violation.
 *
 * Deliberate omissions:
 *   - no foreign key to `company_agent_runs`: a code run has no row there (established in C6a), and a FK to a
 *     row that never exists would make every goal insert fail.
 *   - no foreign key to C10/C12 structures: those steps do not exist yet, and inventing their shape here would
 *     be implementing a future step (rule 24).
 *   - every table carries `data_classification` and `retention_class` NOT NULL with the established CHECK
 *     vocabulary (rule 18), and `company_id` NOT NULL so each row is tenant-scoped.
 */
export async function runMigration080(client: PoolClient): Promise<void> {
  // --- session plans (revisioned) ---------------------------------------------------------------------
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_session_plans (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      project_id text NOT NULL,
      session_id text NOT NULL,
      run_id text,
      revision integer NOT NULL,
      status text NOT NULL CHECK (status IN ('draft','approved','rejected','superseded')),
      plan jsonb NOT NULL,
      execution_mode text CHECK (execution_mode IN ('plan','ask','auto_edit','full_auto_sandbox')),
      decision_note text,
      decided_by text,
      decided_at timestamptz,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      data_classification text NOT NULL DEFAULT 'confidential'
        CHECK (data_classification IN ('public','internal','confidential','restricted')),
      retention_class text NOT NULL DEFAULT 'standard'
        CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted')),
      CONSTRAINT code_session_plans_revision_unique UNIQUE (company_id, session_id, revision),
      CONSTRAINT code_session_plans_approved_needs_mode
        CHECK (status <> 'approved' OR execution_mode IS NOT NULL)
    )
  `);

  // Exactly one approved plan per session: the guarantee that "the plan in force" is a single object.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS code_session_plans_one_approved_idx
      ON code_session_plans (company_id, session_id) WHERE status = 'approved'
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_session_plans_session_idx
      ON code_session_plans (company_id, session_id, revision DESC)
  `);

  // --- goals ------------------------------------------------------------------------------------------
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_goals (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      project_id text NOT NULL,
      session_id text,
      run_id text,
      objective text NOT NULL,
      constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL CHECK (status IN ('planned','running','blocked','verifying','completed','failed')),
      blocked_reason text,
      question text,
      progress_completed integer NOT NULL DEFAULT 0,
      progress_total integer NOT NULL DEFAULT 0,
      revision integer NOT NULL DEFAULT 1,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      data_classification text NOT NULL DEFAULT 'confidential'
        CHECK (data_classification IN ('public','internal','confidential','restricted')),
      retention_class text NOT NULL DEFAULT 'standard'
        CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted'))
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_goals_company_idx
      ON code_goals (company_id, updated_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_goals_session_idx
      ON code_goals (company_id, session_id, updated_at DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS code_goal_criteria (
      id text PRIMARY KEY,
      goal_id text NOT NULL REFERENCES code_goals(id) ON DELETE CASCADE,
      company_id text NOT NULL,
      position integer NOT NULL,
      criterion text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending','verified','failed')),
      evidence text,
      verified_by text,
      verified_at timestamptz,
      CONSTRAINT code_goal_criteria_position_unique UNIQUE (goal_id, position)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS code_goal_criteria_goal_idx
      ON code_goal_criteria (company_id, goal_id, position)
  `);

  // --- session todos ----------------------------------------------------------------------------------
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_session_todos (
      id text PRIMARY KEY,
      company_id text NOT NULL,
      project_id text NOT NULL,
      session_id text NOT NULL,
      goal_id text,
      task_id text NOT NULL,
      content text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending','in_progress','completed')),
      position integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      data_classification text NOT NULL DEFAULT 'confidential'
        CHECK (data_classification IN ('public','internal','confidential','restricted')),
      retention_class text NOT NULL DEFAULT 'standard'
        CHECK (retention_class IN ('ephemeral','short','standard','extended','until_deleted'))
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS code_session_todos_task_idx
      ON code_session_todos (company_id, session_id, task_id)
  `);
  // Structural "at most one in_progress": two writers that both pass the service check cannot both commit.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS code_session_todos_single_in_progress_idx
      ON code_session_todos (company_id, session_id) WHERE status = 'in_progress'
  `);

  // --- structural goal-completion guarantee ------------------------------------------------------------
  // A goal whose acceptance criteria are not all verified must not be completable. The service refuses with a
  // structured `goal_acceptance_unverified` first — the trigger is the backstop that holds even if a future
  // code path, a migration script or an operator on the database tries to skip the service.
  await client.query(`
    CREATE OR REPLACE FUNCTION npati_code_goals_acceptance_guard()
    RETURNS trigger AS $$
    DECLARE
      unverified integer;
      total integer;
    BEGIN
      IF NEW.status = 'completed' THEN
        SELECT count(*) INTO total FROM code_goal_criteria WHERE goal_id = NEW.id;
        IF total = 0 THEN
          RAISE EXCEPTION 'goal_acceptance_unverified: goal has no acceptance criteria'
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT count(*) INTO unverified
          FROM code_goal_criteria WHERE goal_id = NEW.id AND status <> 'verified';
        IF unverified > 0 THEN
          RAISE EXCEPTION 'goal_acceptance_unverified: % criteria are not verified', unverified
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(`DROP TRIGGER IF EXISTS npati_code_goals_acceptance ON code_goals`);
  await client.query(`
    CREATE TRIGGER npati_code_goals_acceptance
      BEFORE INSERT OR UPDATE ON code_goals
      FOR EACH ROW EXECUTE FUNCTION npati_code_goals_acceptance_guard()
  `);

  // The reverse hole: a completed goal must not be un-verified afterwards, or "completed" would depend on when
  // you look. A criterion of a completed goal can only stay verified.
  await client.query(`
    CREATE OR REPLACE FUNCTION npati_code_goal_criteria_guard()
    RETURNS trigger AS $$
    DECLARE
      goal_status text;
    BEGIN
      IF NEW.status <> 'verified' THEN
        SELECT status INTO goal_status FROM code_goals WHERE id = NEW.goal_id;
        IF goal_status = 'completed' THEN
          RAISE EXCEPTION 'goal_acceptance_unverified: criterion of a completed goal cannot be un-verified'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(`DROP TRIGGER IF EXISTS npati_code_goal_criteria_guard ON code_goal_criteria`);
  await client.query(`
    CREATE TRIGGER npati_code_goal_criteria_guard
      BEFORE INSERT OR UPDATE ON code_goal_criteria
      FOR EACH ROW EXECUTE FUNCTION npati_code_goal_criteria_guard()
  `);
}
