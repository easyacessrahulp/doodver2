# DOOD

A personal work-management app for running several companies: calls, follow-ups, discussions and tasks — with the Home page showing only **what needs your attention**.

## Run it (Node 22.13 or newer)

```bash
npm install
npm run build
npm start        # http://localhost:3000
```

Create the first account (it becomes the Admin), then *Settings → Load demo data* to look around. Next time only `npm start` is needed.

### Upgrading from an earlier version
1. Stop the app and copy the new files over the old folder (`apps/api/data` is not in the zip, so your data is untouched).
2. `npm install`, `npm run build`, `npm start`.
3. The database upgrades itself on first start; a copy of the previous file is kept in `apps/api/data/backups/`.

### Use it on your phone (same Wi-Fi)
Double-click **Start-DOOD-Phone.bat** in the DOOD folder. It starts DOOD and shows the address to type into your phone's browser (like `http://192.168.x.x:5173`). Close the two black windows to stop. If the phone cannot connect, allow Node.js through Windows Firewall on private networks.

### Moving to another computer
Copy only `apps/api/data` (a few MB) and install the app fresh — or use *Settings → Download full backup* and *Restore* on the new machine. Don't copy `node_modules`.

## What is in DOOD

**Home (Action Centre)** — quick buttons **+ Call · + Follow-up · + Discussion · + Task**; summary cards for Calls, Follow-ups, Discussions and Tasks (each opens the filtered list); **My Attention** (compact, scrollable, with chips: Overdue / Critical / High priority / Due today / Upcoming / Waiting and *View all*); Calls, Follow-ups and Discussions panels; important tasks; today's activities. Project health, completed-today and the daily briefing are tucked under "More".
**Navigation** — Action: Home, Calls, Follow-ups, Discussions, Tasks · Workspace: Companies, Projects, People, Drill-down, Notes, Kanban, Calendar · Productivity: My Attention, Pomodoro / Focus, Reports · System: Settings, Users. Search, company switcher, drafts and alerts live in the header. The sidebar never grows with the number of tasks.
**Kanban** — pick a company; columns Backlog → To do → In progress → Waiting → Completed; drag cards to change status; filters for project, person, priority, due date, task type and status; cards show subtasks, calls, follow-ups and discussions.
**Calls & mails** — finishing one needs feedback, copied into the task's notes; finished items leave the to-do list and stay in *Completed (activity history)*.
**Follow-ups** — real items (several per task) with dates, overdue/today/upcoming tabs, completion notes and "follow up again on".
**Discussions & meetings** — gathered per person into one meeting sheet; outcomes go to the task's notes.
**Paste a list** (from Word) into a subtask, call, follow-up, discussion point or task field and you are asked *"Multiple activities detected"* — add as multiple, keep as one, or cancel. Order and numbering are kept; empty lines and bullet symbols are dropped.
Also: subtasks with their own due date and person, attachments, recurring tasks, Calendar + Agenda, Pomodoro on tasks and subtasks, Search, daily/weekly reviews, Performance per delegate, Drafts, exports (Excel/CSV/PDF), backup & restore, importer for the old HTML prototype, shortcuts (N / T L F D K C A P).
Subtle motion is used where it helps: completion ticks, rows sliding away, draggable Kanban cards, toasts, hover lifts — and it respects the system "reduce motion" setting.

## AI features (OpenAI)

- **Status card** on every task and project: where things stand, what is done / pending, the next action (with a suggested date), risks and 3–6 key points. Saved in the database and marked **Out of date** when the record changes. The AI is called only when you press **Generate / Refresh summary** — never just because you opened a page.
- **Draft email** window (from a task, a project, a follow-up, or the **Emails** page): matter, recipient, company, tone, length and extra instructions; the summary's key points appear as tick-boxes; editable subject and body; Copy subject / body / all; Regenerate, Make shorter / firmer / softer; drafts are saved against the task or project. Missing facts appear as `[confirm: …]` with a warning until you fill them in. Without AI you get a plain template.
- **Exclude from AI** switch on tasks and projects (enforced on the server; tasks inherit it from their project).
- **Settings → AI**: enabled / "AI not set up", model, today's use vs the daily limit, this month's requests and tokens, and a **Test connection** button.

**Setup:** put your key in `apps\api\.env` (see `apps\api\.env.example`): `OPENAI_API_KEY=...` and `OPENAI_MODEL=gpt-4o-mini`, then restart. The key is read only by the server; it is never sent to the browser, never shown, never logged, and `.env` is git-ignored. OpenAI's own error messages are never passed on (they can echo part of a key). Optional: `AI_DAILY_LIMIT=50` (requests per person per day), `AI_TIMEOUT_MS=45000`.
Status check: `GET /api/v1/ai/status` (also `/api/ai/status`).

## Version 7.1 — colourful design and Notebook

- **Colourful look** across DOOD: teal top bar, a colour for each company (change them in Settings › Company colours), coloured number tiles on Today, tinted chips. Red, amber and green still mean only overdue, due today and done. Light, Dark and Auto all work.
- **Notes** (top bar) is now a digital notebook that is not tied to any task: notebooks (Daily journal, Meetings, Ideas, Loose notes, or your own), a page list, and the page on ruled paper. Tag each note to a company, pin it, link it to a task if you want, export to Word, see versions. The old task-notes list is under More › Task notes.
- **Quick note** on Today: jot, speak, or take a photo of handwriting, pick a company and notebook, Save.
- **Write up with AI**: give points and/or attach files (PDF, picture, Word, Excel, text/CSV), say what you want, choose Meeting note / Letter / Email / Summary / Report and English or Malayalam. The draft is only added when you press Add or Replace. Works in the Notes page and, via "+ From a file (AI)", in task notes. Notes or tasks marked Private · no AI are never sent.
- **Database**: migration 13 (new tables only; existing companies without a colour get one). Run `Update-DOOD-Database.bat` as before.

## Version 7 — new design and AI helpers

- **New look**: no left sidebar. Top bar (Today, Kanban, Calendar, Calls, Messages, Meetings, Notes, Reports, Ask Dood), company tabs and a **People** tab below it. Everything that used to be in the sidebar is under **More** and in the search box (Ctrl+K).
- **Task screen**: breadcrumb, Focus / Follow up / Delegate / Reschedule / Write email / Complete / More, AI summary, subtasks with tick boxes and "2 of 4 done", working notes, history, files.
- **Subtasks** have their own person, date, status and Follow up button (WhatsApp opens with the message typed; you press Send).
- **People tab**: tick people to see their pending tasks, subtasks and follow-ups across companies, overdue first; "Ask all for status"; Export to Word.
- **Settings › Appearance**: Light / Dark / Auto, Comfortable / Compact, Normal / Large text.
- **AI (needs your OpenAI key; it only suggests, you click)**: Quick add (N, typed or spoken), Read a letter (PDF/photo), smart follow-up messages (Gentle / Firm / Escalate, English / Malayalam), Reply reader, Ask Dood with sources. Items marked **Private · no AI** are never sent to OpenAI. Voice needs microphone permission in the browser.
- **Database**: one additive migration (v12). Nothing is removed or reset. Run `Update-DOOD-Database.bat` (or `npm run update-db`) — it makes its own backup in `apps\api\data\backups` and prints counts of companies, projects, tasks and subtasks before and after.

## Version 8 — ready for a multi-user trial
- **Phone app** — open DOOD in the phone browser and “Add to home screen”. Real install prompts and background alerts need an https address; on the office Wi-Fi (http) the site works normally and alerts show while it is open. (More ▸ Daily digest & phone)
- **Daily digest** — a morning and evening summary appears in the notification bell at the times each person sets. “Send to my WhatsApp” opens their own WhatsApp with the text ready. DOOD never sends WhatsApp by itself.
- **Templates & repeating tasks** — save a task with its steps, use it in one click, and set it to repeat (daily … yearly). (More ▸ Templates & repeats)
- **People to chase** — DOOD ranks who owes you something and suggests a gentle / firm / escalate message. You tap to send; it is logged as a follow-up. Snooze 1/3/7 days.
- **Document vault** — agreements, licences, insurance with expiry reminders (bell + Today card), file upload, search, and “Ask about this document” (AI, only on request, never for “Private · no AI” documents).
- **Approvals** — ask a colleague to approve a spend or decision; they approve or reject (with a reason) and you are notified.
- **Weekly review** — numbers per company and person, stuck and slipping tasks, optional AI summary.
- Needs **Update-DOOD-Database.bat** once (adds database version 14; nothing is deleted). Backups now include Notebook and Vault files.

## Version 8.3 — phone layout
- Slim top bar, bottom tab bar (Today, Tasks, Add, Activity, More), full-screen All-features grid, company switcher sheet. Desktop unchanged. No database change.

## Version 8.2 — Doodu the quokka
- Mascot added: welcome (Today), focus timer, task-complete pop-up, water, walk and briefing reminders. Web only; no database change.

## Version 8.1 — what changed
- **Floating + button** on every page (bottom-right): New task, New subtask, New project. Hidden for view-only users.
- **Activity tab** (after Notes): who you have given work to, per person, with overdue first and a Follow up button.
- **Export to Word** on AI text: Notebook AI draft, AI summary, email draft, weekly review (Ask Dood already had it).
- **Close buttons** added to Search, Notifications and reminder cards; **Esc** closes the top-most window.
- No new database step (still migration 14).

## Version 6.1 — what changed
- **Subtasks:** tick-box before each one (marks it done), a person each, and its own **🔄 Follow-up** button (it chases the person the subtask is given to; the follow-up shows under the subtask and on the Follow-ups page).
- **People** (top bar): pick a person to see all their pending tasks and subtasks, with overdue marked.
- **Messages** and **Kanban** moved to the top bar. The old People list is now called **Contacts** in the side menu.
- **Settings → Theme:** Auto / Light / Dark (remembered on each computer).
- Upgrade: close DOOD, extract the zip over the old folder (choose Replace), double-click **Start-DOOD-LAN.bat**. Your `apps\api\data` folder and `.env` are not in the zip and are not touched; the database gets one small addition and a backup is taken first.

## Version 6 — team test on your Wi-Fi (no email needed)
**New server, empty database:** run **Install-DOOD-Server.bat** once (right-click → Run as administrator so the firewall opens too). Next time use **Start-DOOD-LAN.bat**. The installer asks for your OpenAI key (press Enter to skip; add it later with **Set-AI-Key.bat**). The first person to open DOOD creates the owner account.
**Start it for everyone:** double-click **Start-DOOD-LAN.bat**. It shows two addresses: `http://localhost:3000` for you, and `http://192.168.x.x:3000` for everyone else on the same Wi-Fi. If others cannot open it, right-click **Allow-DOOD-Firewall.bat → Run as administrator** once (and make sure Windows calls your Wi-Fi "Private"). Keep the black DOOD window open while people are testing. This is plain `http` on your own network — fine for a trial, not for the internet.

**Give someone a login:** Users → **+ New user**. Type the name and a **User ID** (e.g. `priya`), keep the generated password, pick the company and the access level, press *Create login*, then **Copy** the box and send it to them. They type the User ID and password on the sign-in page and are asked to choose their own password. Forgot it? Users → **New password**.

**Access levels:** *Team member* sees only jobs they created or that were given to them (plus their own calls, notes, chats…). *User* sees the whole company. *Manager* can also announce to the company and manage masters. *Viewer* reads only. The owner (Admin) sees everything, can add companies and roles, and can **View as** (read-only) or **Act as** a person, sign them out, or see their login history. Private 1:1 chats are never shown to the owner.

**New screens (menu → Team):** 🔔 notifications bell with live updates · 💬 Messages (people, groups, and a chat on every task — open a task and press 💬 Task chat; mark messages as Decision or Action and turn an Action into a task) · 🎥 Chat Meetings (invite people, pick a time — it shows in their Calendar — talk in a shared chat, minutes written when you end it, by AI if enabled) · 📢 Announcements (importance, "I have read this", who has seen it, reminders, AI polish/translate, publish later) · 📰 Team feed (updates, announcements, finished work, meeting minutes, reactions, comments) · 🗂 Board (drag cards between columns; add or rename columns) · 📊 Usage (owner only: who is really using DOOD, logins, overdue, nudge, export to Excel). Finishing a task shows a congratulation and an optional one-minute self-review (AI gives a short note).

**Upgrading:** same steps as above — copy the new files over the old folder (your data in `apps/api/data` is kept; a backup is made automatically on first start). The database upgrades itself. An extra daily copy is also kept in `apps/api/data/backups/`.

## Earlier additions (v5)
1. **Drill-down** (Workspace → 🧭 Drill-down): Company → Project → Task → Subtask, with counts and a clickable trail.
2. **＋ New project from inside a task or subtask** — a link beside the *Project* box in the task form, and *“Create project from this subtask”* in the subtask windows (it then asks whether to move the task into it). Needs Manager/Admin rights in that company.
3. **Notes** (📝 on every subtask, plus a *Notes* section on every task and a *Notes* page): an editor for text or points with bullet/number buttons. *Make internal note* ties it to the company; **⬇ Word** exports it (with revision history); **Share to Discussions** raises a discussion item. After the discussion you can add its outcome to the note, save a new version (every version is kept) and share again — a pending discussion is updated, a settled one gets a fresh “Revised note” item.
4. **Emails from Calls**: a yellow notice lists emails waiting to be written. *✉ Write email* opens the email window (AI or plain template) right there; *Done — mark as sent* moves it to Completed and logs it in the task's notes. DOOD does not send mail itself — copy it or use *Open in mail app* first.
5. **“Today” message every 3 hours** (and when you open DOOD): an AI-written summary of what is pending, with the list. Items switched to “exclude from AI” are listed but never sent to the AI. Without an AI key you get the plain summary.
6. **Water + 5-minute break** pop-up every hour. 7. **Walk 10 minutes** pop-up every 45 minutes, counted from the first time DOOD is opened each day.
   Settings → *Reminders & health* switches each on/off, previews them, and pauses them (1 hour / rest of the day). Pop-ups show while DOOD is open in the browser; settings are kept per computer.
3b. **Proper note (AI)**: in the note editor press **✨ Make proper note**. The AI rewrites your rough points in the office note format (SUB line, “Dear Sir,”, numbered points with lettered sub-points, “For approval”, designation and date), using only your facts and marking anything missing as `[confirm: …]`. The draft opens in a window with an editable side and a paper preview; edit it, *Rewrite with AI* with an instruction if you like, *Save draft*, then **⬇ Word — final note**. Your original points are never changed. Without an AI key the points are laid out in the same format without rewriting. Tasks marked “exclude from AI” are refused.
8. **Pending jobs to Word**: Reports → Export (or Settings) → *Pending jobs — send to people*. One person or everyone (one page each), with a blank “Your update” column to forward and get filled in.

## Checks
`npm test` — 64 tests (7 cover AI, using a stand-in OpenAI server; 7 cover this version's features) · `npm run perf -w apps/api` — 10,000 tasks + 50,000 subtasks. The built interface was also exercised screen-by-screen in a simulated browser (83 checks, including the AI screens with AI off and on). This version's screens (drill-down, notes, email from Calls, reminders on a fast-forwarded clock, Word exports) were driven in a real Chromium browser — 18 checks.

## Honest limits
- Reminder pop-ups need DOOD open in a browser tab (no background service); after a long absence you get one reminder, not a pile.
- No email, no phone push, no HTTPS yet: alerts are in-app (bell + live), and meeting reminders appear while DOOD is open. The server must stay running on the host computer.
- Chat is text only (no video/voice). Chat Meetings are text conferences.
- Runs on SQLite; the SQL is Postgres-compatible but no Postgres adapter is written. Docker files are written, not run.
- Internally the code and backup files still use the id `command-centre`, so backups from earlier versions keep restoring.

- **Word notes** have a coloured banner with the company name (pick the company and colour in the note window; it is used for both the proper note and the raw points).
