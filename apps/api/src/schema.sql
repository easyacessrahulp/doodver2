-- Command Centre schema v1. Portable SQL: runs unchanged on SQLite and PostgreSQL.
-- Timestamps/dates are ISO-8601 TEXT (UTC), booleans are INTEGER 0/1, ids are UUID TEXT.
-- Mirrors ../prisma/schema.prisma (the reference model). Soft delete = archived_at.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, last_login_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL, user_agent TEXT, ip TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, short_name TEXT, code TEXT NOT NULL UNIQUE, description TEXT,
  active INTEGER NOT NULL DEFAULT 1, contact TEXT, notes TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT
);
CREATE TABLE IF NOT EXISTS company_memberships (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), company_id TEXT NOT NULL REFERENCES companies(id),
  role TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT,
  UNIQUE (user_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_company ON company_memberships(company_id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), name TEXT NOT NULL, description TEXT,
  owner_id TEXT REFERENCES users(id), start_date TEXT, target_date TEXT, priority INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'ACTIVE', is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id, status);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, company_id TEXT REFERENCES companies(id), name TEXT NOT NULL, designation TEXT, department TEXT,
  email TEXT, phone TEXT, reports_to_id TEXT REFERENCES people(id), active INTEGER NOT NULL DEFAULT 1, notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_people_company ON people(company_id);

CREATE TABLE IF NOT EXISTS recurring_rules (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), frequency TEXT NOT NULL,
  interval_count INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL, description TEXT, additional_details TEXT, owner_id TEXT NOT NULL REFERENCES users(id),
  delegated_to_id TEXT REFERENCES people(id), delegated_at TEXT, delegation_instructions TEXT,
  reviewer_id TEXT REFERENCES people(id), priority INTEGER NOT NULL DEFAULT 3, status TEXT NOT NULL DEFAULT 'TODO',
  progress_override INTEGER, due_date TEXT, waiting_for TEXT, waiting_expected_date TEXT, next_action TEXT,
  next_followup_date TEXT, postpone_count INTEGER NOT NULL DEFAULT 0, last_activity_at TEXT NOT NULL,
  remind_days_before INTEGER, depends_on_id TEXT REFERENCES tasks(id), recurring_rule_id TEXT REFERENCES recurring_rules(id),
  next_occurrence_created INTEGER NOT NULL DEFAULT 0, focus_minutes INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT, completed_by_id TEXT, completion_note TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_delegated ON tasks(delegated_to_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_activity ON tasks(last_activity_at);
CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_tasks_followup ON tasks(next_followup_date);

CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), company_id TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT, assignee_id TEXT REFERENCES people(id), due_date TEXT, priority INTEGER NOT NULL DEFAULT 3,
  progress INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'TODO', position INTEGER NOT NULL DEFAULT 0,
  reminder_at TEXT, focus_minutes INTEGER NOT NULL DEFAULT 0, completed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id, position);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, body TEXT NOT NULL,
  author_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_entity ON comments(entity_type, entity_id, created_at);

-- Phase 3+ tables (structure only; no behaviour in Phase 1)
CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), company_id TEXT NOT NULL, person_id TEXT REFERENCES people(id),
  type TEXT NOT NULL, due_at TEXT NOT NULL, done_at TEXT, notes TEXT, result TEXT, next_date TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT
);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), company_id TEXT NOT NULL, user_id TEXT NOT NULL,
  kind TEXT NOT NULL, remind_at TEXT NOT NULL, sent_at TEXT, recurrence TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), company_id TEXT NOT NULL, file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT
);
CREATE TABLE IF NOT EXISTS task_relationships (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, from_task_id TEXT NOT NULL REFERENCES tasks(id),
  to_task_id TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT,
  UNIQUE (from_task_id, to_task_id, type)
);
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY, company_id TEXT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
  detail TEXT, auto INTEGER NOT NULL DEFAULT 0, user_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id, created_at);
CREATE TABLE IF NOT EXISTS focus_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), task_id TEXT NOT NULL REFERENCES tasks(id), company_id TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, planned_minutes INTEGER NOT NULL, actual_minutes INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0, session_number INTEGER NOT NULL DEFAULT 1, note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), company_id TEXT, task_id TEXT, kind TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT, group_key TEXT, channel TEXT NOT NULL DEFAULT 'IN_APP', read_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_settings (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), focus_minutes INTEGER NOT NULL DEFAULT 25,
  short_break_minutes INTEGER NOT NULL DEFAULT 5, long_break_minutes INTEGER NOT NULL DEFAULT 15,
  sessions_before_long INTEGER NOT NULL DEFAULT 4, stale_days INTEGER NOT NULL DEFAULT 3, due_soon_days INTEGER NOT NULL DEFAULT 3,
  escalate_days INTEGER NOT NULL DEFAULT 3, notify_mode TEXT NOT NULL DEFAULT 'DAILY',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT
);
