// Versioned, additive migrations. Existing data is never rewritten or dropped:
//  - schema.sql (v1) is idempotent (CREATE ... IF NOT EXISTS) and always runs first.
//  - each later migration runs once, recorded in schema_migrations.
//  - before the first pending migration touches a database that already holds data, the file is copied to ./backups/.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const COMMON = 'created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id TEXT, updated_by_id TEXT, archived_at TEXT';
const hasColumn = (raw: DatabaseSync, table: string, col: string) => (raw.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === col);

export const MIGRATIONS: { version: number; name: string; up: (raw: DatabaseSync) => void }[] = [
  {
    version: 2, name: 'calls to make; focus sessions can target a subtask',
    up(raw) {
      if (!hasColumn(raw, 'focus_sessions', 'subtask_id')) raw.exec('ALTER TABLE focus_sessions ADD COLUMN subtask_id TEXT REFERENCES subtasks(id)');
      raw.exec(`
        CREATE TABLE IF NOT EXISTS calls (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), subtask_id TEXT REFERENCES subtasks(id),
          person_id TEXT REFERENCES people(id), contact_name TEXT, phone TEXT, note TEXT, due_date TEXT, done_at TEXT, result TEXT, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_calls_task ON calls(task_id);
        CREATE INDEX IF NOT EXISTS idx_calls_pending ON calls(company_id, done_at, due_date);
        CREATE INDEX IF NOT EXISTS idx_focus_task ON focus_sessions(task_id, subtask_id);
      `);
    },
  },
  {
    version: 3, name: 'drafts (unfinished forms saved per user)',
    up(raw) {
      raw.exec(`
        CREATE TABLE IF NOT EXISTS drafts (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, title TEXT, data TEXT NOT NULL, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_id, archived_at);
      `);
    },
  },
  {
    version: 4, name: 'calls become communications (call/email/whatsapp); discussions & meetings; subtask attachments',
    up(raw) {
      if (!hasColumn(raw, 'calls', 'channel')) raw.exec("ALTER TABLE calls ADD COLUMN channel TEXT NOT NULL DEFAULT 'CALL'");
      if (!hasColumn(raw, 'calls', 'email')) raw.exec('ALTER TABLE calls ADD COLUMN email TEXT');
      if (!hasColumn(raw, 'attachments', 'subtask_id')) raw.exec('ALTER TABLE attachments ADD COLUMN subtask_id TEXT');
      if (!hasColumn(raw, 'followups', 'contact_name')) raw.exec('ALTER TABLE followups ADD COLUMN contact_name TEXT');
      raw.exec(`
        CREATE TABLE IF NOT EXISTS discussions (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), subtask_id TEXT REFERENCES subtasks(id),
          person_id TEXT REFERENCES people(id), contact_name TEXT, kind TEXT NOT NULL DEFAULT 'DISCUSSION', topic TEXT NOT NULL, agenda TEXT,
          due_date TEXT, meeting_time TEXT, discussion_notes TEXT, decisions TEXT, done_at TEXT, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_discussions_task ON discussions(task_id);
        CREATE INDEX IF NOT EXISTS idx_discussions_pending ON discussions(company_id, done_at, due_date);
        CREATE INDEX IF NOT EXISTS idx_discussions_person ON discussions(person_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_sub ON attachments(subtask_id);
        CREATE INDEX IF NOT EXISTS idx_subtasks_assignee ON subtasks(assignee_id);
        CREATE INDEX IF NOT EXISTS idx_comments_company ON comments(company_id, created_at);
      `);
    },
  },
  {
    version: 5, name: 'index for dependency lookups (fast attention scoring at 10,000+ tasks)',
    up(raw) { raw.exec('CREATE INDEX IF NOT EXISTS idx_tasks_depends ON tasks(depends_on_id); CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(archived_at, status, company_id);'); },
  },
  {
    version: 6, name: 'planned follow-ups become real items (one per row); kanban backlog; indexes',
    up(raw) {
      raw.exec(`
        CREATE INDEX IF NOT EXISTS idx_followups_task ON followups(task_id, done_at);
        CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(company_id, done_at, due_at);
        CREATE INDEX IF NOT EXISTS idx_calls_due ON calls(due_date);
        -- every task that already had a "next follow-up" date gets a matching pending follow-up item, so nothing you planned is lost
        INSERT INTO followups (id, task_id, company_id, type, due_at, notes, created_at, updated_at, created_by_id, updated_by_id)
          SELECT lower(hex(randomblob(16))), t.id, t.company_id, 'OTHER', t.next_followup_date, t.next_action, t.updated_at, t.updated_at, t.updated_by_id, t.updated_by_id
          FROM tasks t WHERE t.next_followup_date IS NOT NULL AND t.archived_at IS NULL AND t.status <> 'DONE'
            AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.task_id = t.id AND f.done_at IS NULL AND f.archived_at IS NULL);
      `);
    },
  },
  {
    version: 7, name: 'AI: cached summaries, saved email drafts, usage log, exclude-from-AI switches',
    up(raw) {
      if (!hasColumn(raw, 'tasks', 'ai_excluded')) raw.exec('ALTER TABLE tasks ADD COLUMN ai_excluded INTEGER NOT NULL DEFAULT 0');
      if (!hasColumn(raw, 'projects', 'ai_excluded')) raw.exec('ALTER TABLE projects ADD COLUMN ai_excluded INTEGER NOT NULL DEFAULT 0');
      raw.exec(`
        CREATE TABLE IF NOT EXISTS ai_summaries (
          id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, company_id TEXT NOT NULL, summary_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
          model TEXT, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, generated_at TEXT NOT NULL, ${COMMON},
          UNIQUE (entity_type, entity_id)
        );
        CREATE TABLE IF NOT EXISTS ai_email_drafts (
          id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, followup_id TEXT, company_id TEXT, title TEXT, subject TEXT NOT NULL, body TEXT NOT NULL, params_json TEXT, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_ai_drafts_entity ON ai_email_drafts(entity_type, entity_id);
        CREATE TABLE IF NOT EXISTS ai_usage (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL, kind TEXT NOT NULL, model TEXT,
          prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_usage_user_day ON ai_usage(user_id, day);
        CREATE INDEX IF NOT EXISTS idx_ai_usage_month ON ai_usage(month);
      `);
    },
  },
  {
    version: 8, name: 'Subtask/task notes with versions + Word export, emails composed from Calls',
    up(raw) {
      for (const [c, d] of [['email_subject', 'TEXT'], ['email_body', 'TEXT'], ['sent_at', 'TEXT']]) if (!hasColumn(raw, 'calls', c)) raw.exec(`ALTER TABLE calls ADD COLUMN ${c} ${d}`);
      raw.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), subtask_id TEXT REFERENCES subtasks(id),
          title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'DRAFT', version INTEGER NOT NULL DEFAULT 1,
          discussion_id TEXT REFERENCES discussions(id), shared_version INTEGER, shared_at TEXT, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_notes_task ON notes(task_id, subtask_id);
        CREATE INDEX IF NOT EXISTS idx_notes_company ON notes(company_id, kind);
        CREATE TABLE IF NOT EXISTS note_versions (
          id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id), company_id TEXT NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', change_note TEXT, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(note_id, version);
      `);
    },
  },
  {
    version: 9, name: 'Notes: AI-formatted "proper note" draft',
    up(raw) {
      if (!hasColumn(raw, 'notes', 'draft_json')) raw.exec('ALTER TABLE notes ADD COLUMN draft_json TEXT');
      if (!hasColumn(raw, 'notes', 'draft_from_version')) raw.exec('ALTER TABLE notes ADD COLUMN draft_from_version INTEGER');
    },
  },
  {
    version: 10, name: 'Team: user-id logins, scoped members, notifications, chat, meetings, announcements, boards, self-reviews',
    up(raw) {
      for (const [t, c, d] of [
        ['users', 'login_id', 'TEXT'], ['users', 'person_id', 'TEXT'], ['users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0'],
        ['users', 'login_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['sessions', 'view_as_user_id', 'TEXT'], ['sessions', 'act_as', 'INTEGER NOT NULL DEFAULT 0'],
        ['notifications', 'link', 'TEXT'], ['notifications', 'actor_id', 'TEXT'],
        ['tasks', 'board_list_id', 'TEXT'], ['tasks', 'board_pos', 'REAL NOT NULL DEFAULT 0'],
      ] as const) if (!hasColumn(raw, t, c)) raw.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
      raw.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users(login_id) WHERE login_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at, created_at);
        CREATE TABLE IF NOT EXISTS login_history (
          id TEXT PRIMARY KEY, user_id TEXT, login_id TEXT, kind TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 1, actor_id TEXT, ip TEXT, user_agent TEXT, at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_login_hist_user ON login_history(user_id, at);
        CREATE TABLE IF NOT EXISTS task_participants (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), user_id TEXT NOT NULL REFERENCES users(id), why TEXT, ${COMMON},
          UNIQUE (task_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_participants_user ON task_participants(user_id);
        CREATE TABLE IF NOT EXISTS chat_rooms (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, task_id TEXT, meeting_id TEXT, company_id TEXT, direct_key TEXT UNIQUE, ${COMMON}
        );
        CREATE TABLE IF NOT EXISTS chat_members (
          id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES chat_rooms(id), user_id TEXT NOT NULL REFERENCES users(id), last_read_at TEXT, muted INTEGER NOT NULL DEFAULT 0, ${COMMON},
          UNIQUE (room_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES chat_rooms(id), author_id TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'TEXT',
          ref_task_id TEXT, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_chat_messages_room ON chat_messages(room_id, created_at);
        CREATE TABLE IF NOT EXISTS meetings (
          id TEXT PRIMARY KEY, company_id TEXT, task_id TEXT, title TEXT NOT NULL, agenda TEXT, start_at TEXT NOT NULL, end_at TEXT, status TEXT NOT NULL DEFAULT 'SCHEDULED',
          room_id TEXT, organizer_id TEXT NOT NULL, minutes_json TEXT, started_at TEXT, ended_at TEXT, reminded_at TEXT, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_meetings_start ON meetings(start_at, status);
        CREATE TABLE IF NOT EXISTS meeting_participants (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id), user_id TEXT NOT NULL REFERENCES users(id), rsvp TEXT NOT NULL DEFAULT 'PENDING', joined_at TEXT, ${COMMON},
          UNIQUE (meeting_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_part_user ON meeting_participants(user_id);
        CREATE TABLE IF NOT EXISTS announcements (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'NORMAL', audience TEXT NOT NULL DEFAULT 'ALL', company_id TEXT,
          pinned INTEGER NOT NULL DEFAULT 0, requires_ack INTEGER NOT NULL DEFAULT 0, publish_at TEXT, expires_at TEXT, notified_at TEXT, ${COMMON}
        );
        CREATE TABLE IF NOT EXISTS announcement_targets (
          id TEXT PRIMARY KEY, announcement_id TEXT NOT NULL REFERENCES announcements(id), user_id TEXT NOT NULL REFERENCES users(id), ${COMMON},
          UNIQUE (announcement_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS announcement_reads (
          id TEXT PRIMARY KEY, announcement_id TEXT NOT NULL REFERENCES announcements(id), user_id TEXT NOT NULL REFERENCES users(id), seen_at TEXT, ack_at TEXT, ${COMMON},
          UNIQUE (announcement_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS feed_posts (
          id TEXT PRIMARY KEY, author_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'POST', body TEXT NOT NULL, company_id TEXT, task_id TEXT, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_feed_created ON feed_posts(created_at);
        CREATE TABLE IF NOT EXISTS post_comments (
          id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES feed_posts(id), author_id TEXT NOT NULL, body TEXT NOT NULL, ${COMMON}
        );
        CREATE TABLE IF NOT EXISTS reactions (
          id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), emoji TEXT NOT NULL, ${COMMON},
          UNIQUE (entity_type, entity_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS board_lists (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL, project_id TEXT, owner_id TEXT, name TEXT NOT NULL, position REAL NOT NULL DEFAULT 0, maps_to_status TEXT, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_board_lists ON board_lists(company_id, project_id);
        CREATE TABLE IF NOT EXISTS task_reviews (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), company_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), rating INTEGER,
          went_well TEXT, challenges TEXT, learned TEXT, next_time TEXT, ai_feedback TEXT, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_task_reviews_task ON task_reviews(task_id);
      `);
    },
  },
  {
    version: 11, name: 'Follow-ups can belong to a subtask',
    up(raw) {
      if (!hasColumn(raw, 'followups', 'subtask_id')) raw.exec('ALTER TABLE followups ADD COLUMN subtask_id TEXT');
      raw.exec('CREATE INDEX IF NOT EXISTS idx_followups_subtask ON followups(subtask_id)');
    },
  },
  {
    version: 12, name: 'Smart follow-up reminders and company colours (additive)',
    up(raw) {
      for (const [c, d] of [['reminder_count', 'INTEGER NOT NULL DEFAULT 0'], ['last_reminded_at', 'TEXT'], ['last_tone', 'TEXT'], ['last_message', 'TEXT'], ['last_sent_via', 'TEXT']] as const)
        if (!hasColumn(raw, 'followups', c)) raw.exec(`ALTER TABLE followups ADD COLUMN ${c} ${d}`);
      if (!hasColumn(raw, 'companies', 'color')) raw.exec('ALTER TABLE companies ADD COLUMN color TEXT');
    },
  },
  {
    version: 13, name: 'My notebooks: standalone notes with notebooks, company tag and versions (additive)',
    up(raw) {
      raw.exec(`
        CREATE TABLE IF NOT EXISTS notebooks (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, color TEXT, sort_order INTEGER NOT NULL DEFAULT 0, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_notebooks_owner ON notebooks(owner_id);
        CREATE TABLE IF NOT EXISTS journal_notes (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), notebook_id TEXT REFERENCES notebooks(id), company_id TEXT REFERENCES companies(id),
          task_id TEXT REFERENCES tasks(id), project_id TEXT REFERENCES projects(id), title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          pinned INTEGER NOT NULL DEFAULT 0, ai_excluded INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'typed', version INTEGER NOT NULL DEFAULT 1, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_journal_owner ON journal_notes(owner_id, archived_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_journal_company ON journal_notes(company_id);
        CREATE TABLE IF NOT EXISTS journal_note_versions (
          id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES journal_notes(id), version INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_journal_versions ON journal_note_versions(note_id, version);
        CREATE TABLE IF NOT EXISTS journal_files (
          id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES journal_notes(id), file_name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, storage_key TEXT NOT NULL, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_journal_files_note ON journal_files(note_id);
      `);
      // Give each company that has no colour yet its own (teal, blue, violet, pink, amber, cyan, green), in the order they were created. Colours already chosen are never touched.
      const palette = ['#0F766E', '#2563EB', '#7C3AED', '#DB2777', '#D97706', '#0E7490', '#4D7C0F'];
      const rows = raw.prepare('SELECT id FROM companies WHERE color IS NULL ORDER BY created_at, id').all() as { id: string }[];
      const taken = (raw.prepare('SELECT COUNT(*) n FROM companies WHERE color IS NOT NULL').get() as { n: number }).n;
      rows.forEach((r, i) => raw.prepare('UPDATE companies SET color = ? WHERE id = ?').run(palette[(taken + i) % palette.length], r.id));
    },
  },
  {
    version: 14, name: 'v8: templates, chase snooze, document vault, approvals, daily digest (additive)',
    up(raw) {
      raw.exec(`
        CREATE TABLE IF NOT EXISTS task_templates (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), company_id TEXT REFERENCES companies(id), name TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
          priority INTEGER NOT NULL DEFAULT 3, repeat_frequency TEXT, repeat_interval INTEGER NOT NULL DEFAULT 1, due_in_days INTEGER, remind_days_before INTEGER,
          subtasks TEXT NOT NULL DEFAULT '[]', shared INTEGER NOT NULL DEFAULT 0, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_templates_owner ON task_templates(owner_id, archived_at);
        CREATE TABLE IF NOT EXISTS chase_snooze (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), task_id TEXT NOT NULL REFERENCES tasks(id), subtask_id TEXT REFERENCES subtasks(id), until_date TEXT NOT NULL, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_chase_snooze ON chase_snooze(user_id, task_id);
        CREATE TABLE IF NOT EXISTS vault_docs (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), project_id TEXT REFERENCES projects(id), task_id TEXT REFERENCES tasks(id), title TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'Other', doc_number TEXT, party TEXT, issued_on TEXT, expires_on TEXT, remind_days INTEGER NOT NULL DEFAULT 30, notes TEXT,
          ai_excluded INTEGER NOT NULL DEFAULT 0, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_vault_company ON vault_docs(company_id, archived_at);
        CREATE INDEX IF NOT EXISTS idx_vault_expiry ON vault_docs(expires_on);
        CREATE TABLE IF NOT EXISTS vault_files (
          id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES vault_docs(id), file_name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, storage_key TEXT NOT NULL, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_vault_files_doc ON vault_files(doc_id);
        CREATE TABLE IF NOT EXISTS approvals (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), task_id TEXT REFERENCES tasks(id), requester_id TEXT NOT NULL REFERENCES users(id),
          approver_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, details TEXT, amount TEXT, status TEXT NOT NULL DEFAULT 'PENDING', decided_at TEXT, decision_note TEXT, ${COMMON}
        );
        CREATE INDEX IF NOT EXISTS idx_approvals_approver ON approvals(approver_id, status);
        CREATE INDEX IF NOT EXISTS idx_approvals_requester ON approvals(requester_id, status);
        CREATE TABLE IF NOT EXISTS digest_prefs (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, morning TEXT NOT NULL DEFAULT '08:30', evening TEXT NOT NULL DEFAULT '18:30',
          phone TEXT, last_morning TEXT, last_evening TEXT, ${COMMON}
        );
      `);
    },
  },
];

export function runMigrations(raw: DatabaseSync, path: string) {
  raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set((raw.prepare('SELECT version FROM schema_migrations').all() as any[]).map((r) => r.version));
  const pending = MIGRATIONS.filter((m) => !done.has(m.version)).sort((a, b) => a.version - b.version);
  if (!pending.length) return { applied: [] as number[], backup: null as string | null };

  let backup: string | null = null;
  const hasData = (raw.prepare('SELECT COUNT(*) n FROM users').get() as any).n > 0;
  if (path !== ':memory:' && hasData) {
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dir = join(dirname(path), 'backups'); mkdirSync(dir, { recursive: true });
    backup = join(dir, `before-v${pending[0].version}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    copyFileSync(path, backup);
  }
  for (const m of pending) {
    raw.exec('BEGIN IMMEDIATE');
    try { m.up(raw); raw.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)').run(m.version, m.name, new Date().toISOString()); raw.exec('COMMIT'); }
    catch (e) { raw.exec('ROLLBACK'); throw new Error(`Migration ${m.version} failed (${m.name}): ${(e as Error).message}. Your data is untouched${backup ? `; a backup is at ${backup}` : ''}.`); }
  }
  return { applied: pending.map((m) => m.version), backup };
}
