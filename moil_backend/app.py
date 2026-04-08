"""
=============================================================================
Moil Primary School — Attendance Management System
Backend Server (app.py)
=============================================================================

Built for the Attendance Officer role at Moil Primary School, Darwin NT.

Technology stack:
  - Flask   : Python web framework — handles all routes and API endpoints
  - SQLite  : Lightweight database stored as a single file (attendance.db)
  - Pandas  : Reads and parses XLS/XLSX attendance export files
  - Jinja2  : Template engine for rendering HTML pages (built into Flask)

How it works:
  1. Attendance Officer uploads an XLS file exported from the school system
  2. parse_xls_file() reads the file and extracts each student's data
  3. Data is stored in the SQLite database under a unique upload ID
  4. The dashboard route loads students + their saved case notes/statuses
  5. All case updates (status changes, notes) are saved back to the database
  6. The database persists everything — notes survive page refresh and new uploads

Database tables:
  uploads           — each XLS file that has been uploaded
  students          — each student row parsed from an upload
  cases             — case status + notes per student (persistent across uploads)
  case_history      — append-only log of every status change
  departed_students — students who have left school (hidden from dashboards)
  case_plans        — full case management plan data per student (JSON)

To run:
  cd moil_backend
  python app.py
  Then open http://localhost:5000 in your browser

Author: Built for Moil Primary School Attendance Officer
Version: 1.0 — Term 1 2026
=============================================================================
"""

from flask import Flask, request, jsonify, render_template, render_template_string, send_file, redirect, url_for, flash
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from functools import wraps
import sqlite3, os, json, re, tempfile
from datetime import datetime
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
import pandas as pd


# =============================================================================
# APP CONFIGURATION
# =============================================================================

app = Flask(__name__)

# Maximum upload file size: 32MB (large enough for any school XLS export)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 32 * 1024 * 1024
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-only-change-in-production')

# Database path — single file, easy to back up by copying
DB_PATH = 'instance/attendance.db'

# Allowed file extensions for upload
ALLOWED = {'.xls', '.xlsx'}

# Create required folders if they don't exist yet
os.makedirs('uploads', exist_ok=True)
os.makedirs('instance', exist_ok=True)


# =============================================================================
# FLASK-LOGIN SETUP
# =============================================================================

login_manager = LoginManager(app)
login_manager.login_view = 'login'          # redirect here when @login_required fails
login_manager.login_message = ''            # suppress default flash message (we handle it in template)


class User(UserMixin):
    """Lightweight user object loaded from the users table for Flask-Login."""
    def __init__(self, id, username, role, display_name):
        self.id           = id
        self.username     = username
        self.role         = role
        self.display_name = display_name

    @property
    def is_admin(self):
        return self.role == 'admin'


@login_manager.user_loader
def load_user(user_id):
    db  = get_db()
    row = db.execute("SELECT * FROM users WHERE id=?", (int(user_id),)).fetchone()
    db.close()
    if row:
        return User(row['id'], row['username'], row['role'], row['display_name'])
    return None


def admin_required(f):
    """Decorator: route is accessible only by admin users."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated or not current_user.is_admin:
            return redirect(url_for('index'))
        return f(*args, **kwargs)
    return decorated


# =============================================================================
# DATABASE SETUP
# =============================================================================

def get_db():
    """
    Open and return a connection to the SQLite database.

    row_factory = sqlite3.Row lets us access columns by name (row['name'])
    instead of by index (row[1]) — much more readable.

    Each request opens its own connection and closes it when done.
    SQLite handles concurrent reads fine; writes are serialised automatically.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """
    Create all database tables on first run (IF NOT EXISTS = safe to call every startup).

    Schema design notes:
      - students table has one row per student PER upload
        (same student appears multiple times as new weekly data is uploaded)
      - cases table has ONE row per student across ALL uploads
        (UNIQUE on student_ref) — this is where persistent notes/status lives
      - case_plans stores the entire form as a JSON blob — easy to extend
        without database migrations if new fields are added to the form
    """
    db = get_db()
    db.executescript("""

    -- One row per uploaded XLS file
    CREATE TABLE IF NOT EXISTS uploads (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        filename      TEXT NOT NULL,           -- filename saved on disk (timestamped)
        label         TEXT,                    -- human label e.g. "Week 7 Cumulative"
        week_number   INTEGER,                 -- optional week number
        term          TEXT DEFAULT 'Term 1 2026',
        date_from     TEXT,                    -- parsed from XLS e.g. "26 JAN 2026"
        date_to       TEXT,
        upload_date   TEXT DEFAULT CURRENT_TIMESTAMP,
        student_count INTEGER,
        parsed        INTEGER DEFAULT 0        -- 1 once successfully parsed
    );

    -- One row per student per upload
    -- Sessions = number of half-days (2 sessions = 1 full school day)
    CREATE TABLE IF NOT EXISTS students (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ref           INTEGER NOT NULL,        -- unique student ID from school system
        name          TEXT NOT NULL,           -- "Surname, Firstname" format
        year          TEXT,                    -- year level e.g. "05", "PR", "TR"
        form          TEXT,                    -- class e.g. "ACACIA", "BUSHBEES"
        upload_id     INTEGER,                 -- which upload this data came from
        attended      INTEGER,                 -- sessions attended (half-days)
        sessions      INTEGER,                 -- total sessions possible
        absences      INTEGER,                 -- sessions absent
        pct           REAL,                    -- attendance % rounded to 2dp
        days_attended REAL,                    -- attended / 2 (full days)
        days_total    REAL,                    -- sessions / 2
        days_absent   REAL,                    -- absences / 2
        FOREIGN KEY (upload_id) REFERENCES uploads(id)
    );

    -- Persistent case management — one row per student (UNIQUE on student_ref)
    -- This survives across uploads — updating student attendance data does NOT
    -- overwrite these records
    CREATE TABLE IF NOT EXISTS cases (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        student_ref   INTEGER NOT NULL,
        student_name  TEXT NOT NULL,
        form          TEXT,
        status        TEXT DEFAULT 'pending',  -- pending/contacted/meeting/welfare/referred/agency/resolved
        notes         TEXT DEFAULT '',         -- free-text case notes
        last_updated  TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_by    TEXT DEFAULT 'Officer',
        UNIQUE(student_ref)                    -- one case record per student, ever
    );

    -- Append-only audit log — every status change gets a row added here
    -- Never updated or deleted — provides full history for accountability
    CREATE TABLE IF NOT EXISTS case_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        student_ref   INTEGER,
        student_name  TEXT,
        action        TEXT,                    -- e.g. "status_change"
        old_status    TEXT,
        new_status    TEXT,
        notes         TEXT,
        timestamp     TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_by    TEXT DEFAULT 'Officer'
    );

    -- Students who have left the school
    -- Hidden from all dashboard views but records remain for accountability
    CREATE TABLE IF NOT EXISTS departed_students (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        student_ref    INTEGER,
        student_name   TEXT,
        form           TEXT,
        reason         TEXT DEFAULT 'Left school',
        departure_date TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Full case management plan per student — stored as a JSON blob
    -- Matches the official "Student Attendance Case Management Plan" form
    -- Storing as JSON means adding new form fields never requires a schema change
    CREATE TABLE IF NOT EXISTS case_plans (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        student_ref   INTEGER UNIQUE NOT NULL,
        plan_data     TEXT DEFAULT '{}',       -- entire form as JSON
        last_updated  TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Day-of-week absence analysis (parsed from Individual Absentee Report)
    CREATE TABLE IF NOT EXISTS day_analysis (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        upload_id INTEGER,
        day_data  TEXT DEFAULT '{}'
    );

    -- Performance indexes — queries filter/join on these columns most frequently
    CREATE INDEX IF NOT EXISTS idx_students_upload_id  ON students(upload_id);
    CREATE INDEX IF NOT EXISTS idx_students_ref        ON students(ref);
    CREATE INDEX IF NOT EXISTS idx_cases_student_ref   ON cases(student_ref);
    CREATE INDEX IF NOT EXISTS idx_case_history_ref    ON case_history(student_ref);
    CREATE INDEX IF NOT EXISTS idx_departed_ref        ON departed_students(student_ref);

    -- User accounts for authentication
    -- role: 'admin' | 'teacher'
    -- Admin can manage users; teachers access dashboards read/write
    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'teacher',  -- 'admin' | 'teacher'
        created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
        created_by    TEXT DEFAULT 'system',
        active        INTEGER DEFAULT 1                  -- 0 = disabled
    );

    """)
    db.commit()

    # Add visible_to_teachers column to uploads if it doesn't exist yet (safe migration)
    existing_cols = [row[1] for row in db.execute("PRAGMA table_info(uploads)").fetchall()]
    if 'visible_to_teachers' not in existing_cols:
        db.execute("ALTER TABLE uploads ADD COLUMN visible_to_teachers INTEGER DEFAULT 1")
        db.commit()

    # Add contact_method and contact_outcome to case_history (safe migration)
    ch_cols = [row[1] for row in db.execute("PRAGMA table_info(case_history)").fetchall()]
    if 'contact_method' not in ch_cols:
        db.execute("ALTER TABLE case_history ADD COLUMN contact_method TEXT DEFAULT ''")
        db.commit()
    if 'contact_outcome' not in ch_cols:
        db.execute("ALTER TABLE case_history ADD COLUMN contact_outcome TEXT DEFAULT ''")
        db.commit()

    # Seed a default admin account on first run if no users exist yet.
    # Admin should change this password immediately after first login.
    existing = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if existing == 0:
        db.execute(
            "INSERT INTO users (username, password_hash, display_name, role, created_by) VALUES (?,?,?,?,?)",
            ('admin', generate_password_hash('admin123'), 'Administrator', 'admin', 'system')
        )
        db.commit()
        print("✅ Default admin account created  →  username: admin  |  password: admin123")
        print("   ⚠️  Please change the default password after first login.")

    db.close()


# Run database setup every time the server starts (safe — uses IF NOT EXISTS)
init_db()


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def get_departed_refs():
    """
    Return a Python set of student ref numbers who have left the school.

    Using a set (not a list) gives O(1) lookup when checking if a student
    should be excluded — important when filtering hundreds of students.
    """
    db = get_db()
    rows = db.execute("SELECT student_ref FROM departed_students").fetchall()
    db.close()
    return {r['student_ref'] for r in rows}


def parse_xls_file(filepath):
    """
    Parse a Maze/school system attendance XLS or XLSX export file into
    a list of student dictionaries.

    Expected column layout (0-indexed) in the export:
      Col 0  — student ref number (or "Form: ACACIA" section headers)
      Col 1  — student name in "Surname, Firstname" format
      Col 3  — year level (e.g. "05", "PR", "TR")
      Col 4  — form/class name
      Col 8  — sessions attended
      Col 9  — total sessions possible
      Col 10 — sessions absent
      Col 11 — attendance percentage (0-100)

    The file has Form header rows like "Form: ACACIA" between student groups.
    We track current_form so students without a form value in col 4 still
    get the correct class assigned.

    Returns:
      tuple: (students, date_from, date_to)
        students  — list of dicts, one per student
        date_from — string e.g. "26 JAN 2026" (or None if not found)
        date_to   — string e.g. "26 MAR 2026" (or None if not found)
      Returns ([], None, None) on any parse error.
    """
    try:
        print(f"📂 Reading file: {filepath}")

        # Choose the correct pandas engine:
        #   xlrd   — handles legacy .xls (no LibreOffice needed)
        #   openpyxl — handles modern .xlsx
        engine = 'openpyxl' if filepath.lower().endswith('.xlsx') else 'xlrd'

        # Load all sheets, then take the first one
        df_dict = pd.read_excel(filepath, sheet_name=None, header=None, engine=engine)
        sheet = list(df_dict.values())[0]
        print(f"📋 Sheet loaded: {sheet.shape[0]} rows x {sheet.shape[1]} cols")

        students = []
        current_form = ''         # updated as we encounter "Form: X" header rows
        date_from, date_to = None, None

        for _, row in sheet.iterrows():
            val0 = str(row[0]).strip() if pd.notna(row[0]) else ''
            val1 = str(row[1]).strip() if pd.notna(row[1]) else ''

            # Detect form section header rows e.g. "Form: ACACIA"
            if val0.startswith('Form:'):
                current_form = val0.replace('Form:', '').strip()

            # Extract the reporting date range from the file header area
            # Handles both "Date Range : 26 JAN 2026 to 26 MAR 2026" (split across cells)
            # and combined single-cell formats
            if val0 == 'Date Range :' or 'Date Range' in val0:
                try:
                    dates = val1.split(' to ')
                    if len(dates) == 2:
                        date_from = dates[0].strip()
                        date_to   = dates[1].strip()
                except:
                    pass
            if not date_from and 'Date Range' in val0 and pd.notna(row[1]):
                try:
                    combined = val0 + ' ' + str(row[1])
                    m = re.search(r'(\d{1,2}\s+\w+\s+\d{4})\s+to\s+(\d{1,2}\s+\w+\s+\d{4})', combined)
                    if m:
                        date_from, date_to = m.group(1), m.group(2)
                except:
                    pass

            # Attempt to parse this row as student data
            # ValueError/TypeError is expected for header/label rows — skip silently
            try:
                ref      = int(float(str(row[0])))
                name     = str(row[1]).strip() if pd.notna(row[1]) else ''
                year     = str(row[3]).strip() if pd.notna(row[3]) else ''
                form     = str(row[4]).strip() if pd.notna(row[4]) else current_form
                attended = float(row[8])  if pd.notna(row[8])  else 0
                sessions = float(row[9])  if pd.notna(row[9])  else 0
                absences = float(row[10]) if pd.notna(row[10]) else 0
                pct      = round(float(row[11]), 2) if pd.notna(row[11]) else 0

                # Cross-validate the file's pct against the raw session counts.
                # The school system's percentage is the authoritative value,
                # but a large discrepancy often signals a misaligned column or
                # corrupted row — log a warning so it can be investigated.
                if sessions > 0:
                    calc_pct = round(attended / sessions * 100, 2)
                    if abs(calc_pct - pct) > 2:
                        print(f"⚠️  Pct mismatch for {name} (ref {ref}): "
                              f"file={pct}%  calculated={calc_pct}%  "
                              f"(attended={int(attended)} sessions={int(sessions)})")
                # Integrity: attended or absences should not exceed total sessions.
                if attended > sessions or absences > sessions:
                    print(f"⚠️  Invalid counts for {name} (ref {ref}): "
                          f"attended={int(attended)} absences={int(absences)} "
                          f"sessions={int(sessions)} — exceeds total")

                # ref > 1000 filters out header rows that parse as small numbers
                if name and name != 'nan' and ref > 1000:
                    students.append({
                        'ref':          ref,
                        'name':         name,
                        'year':         year,
                        'form':         form,
                        'attended':     int(attended),
                        'sessions':     int(sessions),
                        'absences':     int(absences),
                        'pct':          pct,
                        # Convert sessions to school days (2 sessions = 1 day)
                        'days_attended': attended / 2,
                        'days_total':    sessions / 2,
                        'days_absent':   absences / 2,
                    })
            except (ValueError, TypeError):
                pass   # Not a student row — skip

        print(f"✅ Parsed {len(students)} students | Date: {date_from} → {date_to}")
        return students, date_from, date_to

    except Exception as e:
        import traceback
        print(f"❌ Parse error: {e}")
        print(traceback.format_exc())
        return [], None, None


# =============================================================================
# ROUTES — AUTHENTICATION
# =============================================================================

@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))

    error = None
    if request.method == 'POST':
        username = request.form.get('username', '').strip().lower()
        password = request.form.get('password', '')
        db  = get_db()
        row = db.execute(
            "SELECT * FROM users WHERE username=? AND active=1", (username,)
        ).fetchone()
        db.close()

        if row and check_password_hash(row['password_hash'], password):
            user = User(row['id'], row['username'], row['role'], row['display_name'])
            login_user(user, remember=True)
            next_page = request.args.get('next')
            return redirect(next_page or url_for('index'))
        else:
            error = 'Incorrect username or password.'

    return render_template('login.html', error=error)


@app.route('/logout', methods=['POST'])
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))


# =============================================================================
# ROUTES — ADMIN USER MANAGEMENT
# =============================================================================

@app.route('/admin/users')
@login_required
@admin_required
def admin_users():
    db    = get_db()
    users = db.execute("SELECT * FROM users ORDER BY role DESC, created_at ASC").fetchall()
    db.close()
    return render_template('admin_users.html', users=users)


@app.route('/admin/users/create', methods=['POST'])
@login_required
@admin_required
def admin_create_user():
    username     = request.form.get('username', '').strip().lower()
    display_name = request.form.get('display_name', '').strip()
    password     = request.form.get('password', '').strip()
    role         = request.form.get('role', 'teacher')

    if not username or not display_name or not password:
        flash('All fields are required.', 'error')
        return redirect(url_for('admin_users'))
    if role not in ('admin', 'teacher'):
        flash('Invalid role.', 'error')
        return redirect(url_for('admin_users'))
    if len(password) < 6:
        flash('Password must be at least 6 characters.', 'error')
        return redirect(url_for('admin_users'))

    db = get_db()
    existing = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if existing:
        db.close()
        flash(f'Username "{username}" is already taken.', 'error')
        return redirect(url_for('admin_users'))

    db.execute(
        "INSERT INTO users (username, password_hash, display_name, role, created_by) VALUES (?,?,?,?,?)",
        (username, generate_password_hash(password), display_name, role, current_user.username)
    )
    db.commit()
    db.close()
    flash(f'Account created for {display_name} ({username}).', 'success')
    return redirect(url_for('admin_users'))


@app.route('/admin/users/<int:user_id>/reset-password', methods=['POST'])
@login_required
@admin_required
def admin_reset_password(user_id):
    new_password = request.form.get('new_password', '').strip()
    if len(new_password) < 6:
        flash('Password must be at least 6 characters.', 'error')
        return redirect(url_for('admin_users'))

    db  = get_db()
    row = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        db.close()
        flash('User not found.', 'error')
        return redirect(url_for('admin_users'))

    db.execute(
        "UPDATE users SET password_hash=? WHERE id=?",
        (generate_password_hash(new_password), user_id)
    )
    db.commit()
    db.close()
    flash(f'Password reset for {row["display_name"]}.', 'success')
    return redirect(url_for('admin_users'))


@app.route('/admin/users/<int:user_id>/toggle', methods=['POST'])
@login_required
@admin_required
def admin_toggle_user(user_id):
    """Enable or disable a user account. Admins cannot disable themselves."""
    if user_id == current_user.id:
        flash('You cannot disable your own account.', 'error')
        return redirect(url_for('admin_users'))

    db  = get_db()
    row = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if row:
        new_state = 0 if row['active'] else 1
        db.execute("UPDATE users SET active=? WHERE id=?", (new_state, user_id))
        db.commit()
        label = 'enabled' if new_state else 'disabled'
        flash(f'Account {label} for {row["display_name"]}.', 'success')
    db.close()
    return redirect(url_for('admin_users'))


@app.route('/admin/users/<int:user_id>/delete', methods=['POST'])
@login_required
@admin_required
def admin_delete_user(user_id):
    """Permanently delete a user. Admins cannot delete themselves."""
    if user_id == current_user.id:
        flash('You cannot delete your own account.', 'error')
        return redirect(url_for('admin_users'))

    db  = get_db()
    row = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if row:
        db.execute("DELETE FROM users WHERE id=?", (user_id,))
        db.commit()
        flash(f'Account deleted: {row["display_name"]}.', 'success')
    db.close()
    return redirect(url_for('admin_users'))


# =============================================================================
# ROUTES — HTML PAGE RENDERING
# =============================================================================

@app.route('/')
@login_required
def index():
    """
    Control Panel — the home/landing page.
    Shows the upload form, list of all uploads, summary stats,
    case status counts, and departed students manager.
    Stats are calculated from the most recently uploaded file.
    """
    db = get_db()

    # Admins see all uploads; teachers only see uploads marked visible
    if current_user.is_admin:
        uploads = db.execute("SELECT * FROM uploads ORDER BY upload_date DESC").fetchall()
    else:
        uploads = db.execute(
            "SELECT * FROM uploads WHERE visible_to_teachers=1 ORDER BY upload_date DESC"
        ).fetchall()

    departed = db.execute("SELECT * FROM departed_students ORDER BY departure_date DESC").fetchall()

    # Base stats on the most recent upload the current user can see
    if current_user.is_admin:
        latest = db.execute(
            "SELECT * FROM uploads WHERE parsed=1 ORDER BY upload_date DESC LIMIT 1"
        ).fetchone()
    else:
        latest = db.execute(
            "SELECT * FROM uploads WHERE parsed=1 AND visible_to_teachers=1 ORDER BY upload_date DESC LIMIT 1"
        ).fetchone()

    stats = {}
    if latest:
        departed_refs = get_departed_refs()
        students = db.execute(
            "SELECT * FROM students WHERE upload_id=?", (latest['id'],)
        ).fetchall()
        active = [s for s in students if s['ref'] not in departed_refs]
        stats = {
            'total':        len(active),
            'zero':         sum(1 for s in active if s['pct'] == 0),
            'below50':      sum(1 for s in active if s['pct'] < 50),
            'below80':      sum(1 for s in active if s['pct'] < 80),
            'below90':      sum(1 for s in active if s['pct'] < 90),
            'avg':          round(sum(s['pct'] for s in active) / len(active), 1) if active else 0,
            'last_updated': latest['upload_date'],
            'upload_label': latest['label'] or latest['filename'],
        }

    # Count cases by status for the summary pills
    cases       = db.execute("SELECT status, COUNT(*) as cnt FROM cases GROUP BY status").fetchall()
    case_counts = {r['status']: r['cnt'] for r in cases}
    db.close()

    return render_template('index.html', uploads=uploads, stats=stats,
                           case_counts=case_counts, departed=departed)


@app.route('/dashboard/<int:upload_id>')
@login_required
def dashboard(upload_id):
    """
    Render the main attendance dashboard for a specific upload.

    The dashboard has 5 layers (tabs):
      1. Universal Overview   — school-wide stats and charts
      2. Targeted Follow-Up   — 3-tier risk list with action buttons
      3. Case Management      — full caseload with detailed records
      4. Principal Report     — weekly summary for leadership meetings
      5. All Students         — searchable table of all students

    This route:
      1. Loads the upload metadata
      2. Gets all active students for this upload (departed students excluded)
      3. Merges each student's persistent case status + notes from the cases table
      4. Passes the merged data to dashboard.html where JS renders everything

    The JavaScript in dashboard.html also calls /api/cases/all on page load
    as a second guarantee that statuses are always current.
    """
    db = get_db()
    upload = db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
    if not upload:
        return "Upload not found", 404

    # Teachers can only view dashboards that admin has made visible
    if not current_user.is_admin and not upload['visible_to_teachers']:
        return redirect(url_for('index'))

    departed_refs   = get_departed_refs()
    students        = db.execute("SELECT * FROM students WHERE upload_id=?", (upload_id,)).fetchall()
    active_students = [dict(s) for s in students if s['ref'] not in departed_refs]

    # Merge persistent case data (notes, status) into each student dict
    # This ensures the dashboard always shows the latest case management state
    # even when viewing older uploads
    cases = {r['student_ref']: dict(r) for r in db.execute("SELECT * FROM cases").fetchall()}
    for s in active_students:
        case       = cases.get(s['ref'], {})
        s['status'] = case.get('status', 'pending')
        s['notes']  = case.get('notes', '')

    db.close()
    print(f"📊 Dashboard {upload_id}: serving {len(active_students)} students")
    return render_template('dashboard.html', upload=dict(upload), students=active_students)


@app.route('/compare')
@login_required
def compare():
    """
    Week vs Week comparison page.
    Loads the list of uploads for the dropdowns — actual comparison
    data is fetched via /api/compare/<id1>/<id2> when the user clicks Compare.
    """
    # Teachers cannot access the comparison tool — redirect to home
    if not current_user.is_admin:
        return redirect(url_for('index'))

    db = get_db()
    uploads = db.execute(
        "SELECT * FROM uploads WHERE parsed=1 ORDER BY upload_date ASC"
    ).fetchall()
    db.close()
    return render_template('compare.html', uploads=[dict(u) for u in uploads])


# =============================================================================
# API — FILE UPLOAD & MANAGEMENT
# =============================================================================

@app.route('/api/upload', methods=['POST'])
@login_required
@admin_required
def upload_file():
    """
    Handle XLS/XLSX file upload from the Control Panel upload form.

    Process:
      1. Validate file type (XLS or XLSX only)
      2. Save file to uploads/ folder with timestamp prefix
      3. Parse the file with parse_xls_file()
      4. Create a record in the uploads table
      5. Insert one row per student into the students table
         (departed students are automatically skipped)
      6. Return JSON with upload_id and redirect URL

    Form fields:
      file        — the XLS/XLSX file (multipart/form-data)
      label       — display name e.g. "Term 1 Cumulative 26 Mar"
      term        — e.g. "Term 1 2026"
      week_number — optional integer week number
    """
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    f        = request.files['file']
    label    = request.form.get('label', '')
    week_num = request.form.get('week_number', None)
    term     = request.form.get('term', 'Term 1 2026')

    if not f.filename:
        return jsonify({'error': 'No file selected'}), 400

    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED:
        return jsonify({'error': f'File type {ext} not supported. Use XLS or XLSX'}), 400

    # Timestamp prefix prevents filename collisions from repeated uploads
    filename = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{secure_filename(f.filename)}"
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    f.save(filepath)

    students, date_from, date_to = parse_xls_file(filepath)

    if not students:
        return jsonify({'error': 'Could not parse file. Check it is a valid attendance export.'}), 400

    db = get_db()

    # Create the upload record
    cur = db.execute(
        "INSERT INTO uploads (filename, label, week_number, term, date_from, date_to, student_count, parsed) VALUES (?,?,?,?,?,?,?,1)",
        (filename, label or filename, week_num, term, date_from, date_to, len(students))
    )
    upload_id = cur.lastrowid

    # Insert student rows — skip departed students
    departed_refs = get_departed_refs()
    for s in students:
        if s['ref'] not in departed_refs:
            db.execute(
                "INSERT INTO students (ref, name, year, form, upload_id, attended, sessions, absences, pct, days_attended, days_total, days_absent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (s['ref'], s['name'], s['year'], s['form'], upload_id,
                 s['attended'], s['sessions'], s['absences'], s['pct'],
                 s['days_attended'], s['days_total'], s['days_absent'])
            )

    db.commit()
    db.close()
    print(f"✅ Upload {upload_id}: saved {len(students)} students to DB")
    return jsonify({
        'success':         True,
        'upload_id':       upload_id,
        'students_parsed': len(students),
        'date_from':       date_from,
        'date_to':         date_to,
        'redirect':        f'/dashboard/{upload_id}'
    })


@app.route('/api/upload/<int:upload_id>', methods=['DELETE'])
@login_required
@admin_required
def delete_upload(upload_id):
    """
    Delete an upload and all its student attendance rows.

    Important: case notes and statuses in the cases table are NOT deleted.
    They are keyed by student_ref (not upload_id) so they persist and will
    reappear if the same student is in any future upload.
    """
    db = get_db()
    db.execute("DELETE FROM students WHERE upload_id=?", (upload_id,))
    db.execute("DELETE FROM uploads WHERE id=?", (upload_id,))
    db.commit()
    db.close()
    return jsonify({'success': True})


@app.route('/api/upload/<int:upload_id>/visibility', methods=['POST'])
@login_required
@admin_required
def toggle_upload_visibility(upload_id):
    """Toggle whether teachers can see this upload/dashboard."""
    db  = get_db()
    row = db.execute("SELECT visible_to_teachers FROM uploads WHERE id=?", (upload_id,)).fetchone()
    if not row:
        db.close()
        return jsonify({'error': 'Not found'}), 404
    new_val = 0 if row['visible_to_teachers'] else 1
    db.execute("UPDATE uploads SET visible_to_teachers=? WHERE id=?", (new_val, upload_id))
    db.commit()
    db.close()
    return jsonify({'success': True, 'visible': bool(new_val)})


@app.route('/api/uploads')
@login_required
def list_uploads():
    """Return all successfully parsed uploads as JSON, newest first."""
    db = get_db()
    uploads = db.execute("SELECT * FROM uploads WHERE parsed=1 ORDER BY upload_date DESC").fetchall()
    db.close()
    return jsonify([dict(u) for u in uploads])


# =============================================================================
# API — CASE MANAGEMENT
# =============================================================================

@app.route('/api/cases/all')
@login_required
def get_all_cases():
    """
    Return ALL case statuses and notes as a dict keyed by student_ref.

    This is called by the dashboard JavaScript on every page load.
    It guarantees that statuses saved in previous sessions are always
    loaded into the STUDENTS array before any rendering happens —
    even if the Jinja2 template merge somehow missed a record.

    Returns: { student_ref_integer: { "status": "...", "notes": "..." }, ... }

    This is a key part of the data persistence guarantee.
    """
    db = get_db()
    cases = db.execute("SELECT student_ref, status, notes FROM cases").fetchall()
    db.close()
    return jsonify({r['student_ref']: {'status': r['status'], 'notes': r['notes']} for r in cases})


@app.route('/api/case/update', methods=['POST'])
@login_required
def update_case():
    """
    Create or update the case record for a student.

    This is called every time a status button is clicked or notes are changed.
    It's designed to be called frequently (debounced to 500ms in the frontend).

    JSON body fields:
      student_ref  — integer (required)
      student_name — string (for history log display)
      form         — class name
      status       — new status string (optional — only status OR notes needed)
      notes        — case notes text (optional)
      updated_by   — staff identifier (defaults to 'Officer')

    Behaviour:
      - Upsert pattern: creates record if new, updates if exists
      - Only updates the provided fields (status and notes are independent)
      - Logs every status change to case_history for audit trail
      - Status changes from pending→anything and anything→pending are both logged
    """
    data            = request.json
    ref             = data.get('student_ref')
    name            = data.get('student_name', '')
    form            = data.get('form', '')
    new_status      = data.get('status')
    notes           = data.get('notes')
    updated_by      = data.get('updated_by', 'Officer')
    contact_method  = data.get('contact_method', '')
    contact_outcome = data.get('contact_outcome', '')

    if not ref:
        return jsonify({'error': 'student_ref required'}), 400

    db = get_db()
    existing   = db.execute("SELECT * FROM cases WHERE student_ref=?", (ref,)).fetchone()
    old_status = existing['status'] if existing else 'pending'

    if existing:
        # Whitelist of columns that callers are permitted to update.
        # Only these names can appear in the SET clause — no f-string column injection possible.
        ALLOWED_CASE_FIELDS = {'status', 'notes'}

        updates, vals = [], []
        if new_status is not None and 'status' in ALLOWED_CASE_FIELDS:
            updates.append("status=?");  vals.append(new_status)
        if notes is not None and 'notes' in ALLOWED_CASE_FIELDS:
            updates.append("notes=?");   vals.append(notes)
        updates.append("last_updated=?"); vals.append(datetime.now().isoformat())
        updates.append("updated_by=?");   vals.append(updated_by)
        vals.append(ref)
        # Safe: SET clause is built only from string literals in ALLOWED_CASE_FIELDS,
        # never from raw user input. All values remain parameterised.
        db.execute("UPDATE cases SET " + ", ".join(updates) + " WHERE student_ref=?", vals)
    else:
        # First case update for this student — create the record
        db.execute(
            "INSERT INTO cases (student_ref, student_name, form, status, notes, updated_by) VALUES (?,?,?,?,?,?)",
            (ref, name, form, new_status or 'pending', notes or '', updated_by)
        )

    # Log status changes for audit trail (notes-only updates don't create history entries)
    if new_status and new_status != old_status:
        db.execute(
            "INSERT INTO case_history (student_ref, student_name, action, old_status, new_status, notes, contact_method, contact_outcome, updated_by) VALUES (?,?,?,?,?,?,?,?,?)",
            (ref, name, 'status_change', old_status, new_status, notes or '', contact_method, contact_outcome, updated_by)
        )

    db.commit()
    db.close()
    return jsonify({'success': True})


@app.route('/api/case/<int:ref>')
@login_required
def get_case(ref):
    """
    Get the current case record and recent history for a single student.
    Returns the 20 most recent history entries (newest first).
    """
    db = get_db()
    case    = db.execute("SELECT * FROM cases WHERE student_ref=?", (ref,)).fetchone()
    history = db.execute(
        "SELECT * FROM case_history WHERE student_ref=? ORDER BY timestamp DESC", (ref,)
    ).fetchall()
    db.close()
    return jsonify({
        'case':    dict(case) if case else {},
        'history': [dict(h) for h in history]
    })


# =============================================================================
# API — CASE MANAGEMENT PLANS
# =============================================================================

@app.route('/api/caseplan/<int:ref>', methods=['GET'])
@login_required
def get_caseplan(ref):
    """
    Load the saved case management plan for a student.
    Called when the 📋 Case Plan modal is opened.
    Returns plan_data JSON if saved, or null if no plan exists yet.
    The frontend uses this to pre-populate all form fields.
    """
    db  = get_db()
    row = db.execute("SELECT * FROM case_plans WHERE student_ref=?", (ref,)).fetchone()
    db.close()
    if row:
        return jsonify({'plan': json.loads(row['plan_data'])})
    return jsonify({'plan': None})


@app.route('/api/caseplan/<int:ref>', methods=['POST'])
@login_required
def save_caseplan(ref):
    """
    Save or update the full case management plan for a student.

    The entire form is sent as a single JSON object from the frontend.
    Storing as JSON means new form fields can be added without any
    database schema changes — just update the frontend form and this
    route handles it automatically.

    Uses upsert pattern: update if exists, insert if new.
    """
    data     = request.json
    plan     = data.get('plan', {})
    db       = get_db()
    existing = db.execute("SELECT id FROM case_plans WHERE student_ref=?", (ref,)).fetchone()

    if existing:
        db.execute(
            "UPDATE case_plans SET plan_data=?, last_updated=? WHERE student_ref=?",
            (json.dumps(plan), datetime.now().isoformat(), ref)
        )
    else:
        db.execute(
            "INSERT INTO case_plans (student_ref, plan_data, last_updated) VALUES (?,?,?)",
            (ref, json.dumps(plan), datetime.now().isoformat())
        )

    db.commit()
    db.close()
    return jsonify({'success': True})


# =============================================================================
# API — DEPARTED STUDENTS
# =============================================================================

@app.route('/api/depart', methods=['POST'])
@login_required
@admin_required
def mark_departed():
    """
    Mark a student as departed (left the school).
    They disappear from all dashboards immediately.
    Their case notes, history and plans remain in the database permanently.
    Idempotent — marking the same student twice has no effect.
    """
    data   = request.json
    ref    = data.get('student_ref')
    name   = data.get('student_name', '')
    form   = data.get('form', '')
    reason = data.get('reason', 'Left school')

    db       = get_db()
    existing = db.execute("SELECT id FROM departed_students WHERE student_ref=?", (ref,)).fetchone()
    if not existing:
        db.execute(
            "INSERT INTO departed_students (student_ref, student_name, form, reason) VALUES (?,?,?,?)",
            (ref, name, form, reason)
        )
        db.commit()
    db.close()
    return jsonify({'success': True})


@app.route('/api/depart/<int:ref>', methods=['DELETE'])
@login_required
@admin_required
def unmark_departed(ref):
    """
    Restore a departed student to active enrolment.
    They will reappear in all dashboards on the next page load.
    """
    db = get_db()
    db.execute("DELETE FROM departed_students WHERE student_ref=?", (ref,))
    db.commit()
    db.close()
    return jsonify({'success': True})


@app.route('/api/depart/<int:ref>/permanent', methods=['DELETE'])
@login_required
@admin_required
def delete_departed_permanent(ref):
    """
    Permanently delete a departed student record and all case data.
    Removes the student from departed_students, cases, case_history,
    and case_plans. Raw attendance rows in students table are kept
    for historical reporting integrity.
    """
    db = get_db()
    db.execute("DELETE FROM departed_students WHERE student_ref=?", (ref,))
    db.execute("DELETE FROM case_history WHERE student_ref=?", (ref,))
    db.execute("DELETE FROM case_plans WHERE student_ref=?", (ref,))
    db.execute("DELETE FROM cases WHERE student_ref=?", (ref,))
    db.commit()
    db.close()
    return jsonify({'success': True})


# =============================================================================
# API — COMPARISON & EXPORT
# =============================================================================

@app.route('/api/compare/<int:id1>/<int:id2>')
@login_required
def compare_uploads(id1, id2):
    """
    Compare two uploads to reveal attendance trends per student.

    For each student:
      in both uploads  → pct_before, pct_after, diff, trend (improved/worsened/stable)
      only in id2      → trend = 'new' (new enrolment or re-enrolled)
      only in id1      → trend = 'removed' (may have left or been departed)

    Trend thresholds:
      improved  = attendance rose by more than 2%
      worsened  = attendance fell by more than 2%
      stable    = change within ±2% (normal weekly variation)

    Departed students are excluded from both sides of the comparison.
    Results sorted lowest attendance first (most urgent at top).
    """
    db            = get_db()
    departed_refs = get_departed_refs()

    def get_students(uid):
        """Load one upload's students as a ref→dict map for fast comparison."""
        rows = db.execute("SELECT * FROM students WHERE upload_id=?", (uid,)).fetchall()
        return {r['ref']: dict(r) for r in rows if r['ref'] not in departed_refs}

    s1 = get_students(id1)   # "before" upload
    s2 = get_students(id2)   # "after" upload
    u1 = dict(db.execute("SELECT * FROM uploads WHERE id=?", (id1,)).fetchone())
    u2 = dict(db.execute("SELECT * FROM uploads WHERE id=?", (id2,)).fetchone())
    db.close()

    comparison = []
    for ref in set(s1.keys()) | set(s2.keys()):
        a = s1.get(ref)
        b = s2.get(ref)
        if a and b:
            diff  = round(b['pct'] - a['pct'], 2)
            trend = 'improved' if diff > 2 else 'worsened' if diff < -2 else 'stable'
            comparison.append({
                'ref': ref, 'name': b['name'], 'form': b['form'], 'year': b['year'],
                'pct_before': a['pct'], 'pct_after': b['pct'],
                'diff': diff, 'trend': trend,
                'abs_before': a['absences'], 'abs_after': b['absences'],
            })
        elif b:
            comparison.append({'ref': ref, 'name': b['name'], 'form': b['form'],
                               'pct_before': None, 'pct_after': b['pct'], 'trend': 'new'})
        elif a:
            comparison.append({'ref': ref, 'name': a['name'], 'form': a['form'],
                               'pct_before': a['pct'], 'pct_after': None, 'trend': 'removed'})

    comparison.sort(key=lambda x: (x.get('pct_after') or 0))
    return jsonify({'upload1': u1, 'upload2': u2, 'students': comparison})


@app.route('/api/export/<int:upload_id>')
@login_required
def export_csv(upload_id):
    """
    Export attendance + case data for a specific upload as a downloadable CSV.

    Each row includes:
      Ref, Name, Form, Year, Days Attended, School Days, Days Absent,
      Term %, Risk (Zero/Critical/Concern/Watch/Good), Status, Notes

    Risk levels:
      Zero     — 0% attendance
      Critical — below 50%
      Concern  — 50% to 79%
      Watch    — 80% to 89%
      Good     — 90% and above

    Uses tempfile.gettempdir() for the temp file path — this is cross-platform
    and avoids /tmp/ which doesn't exist on Windows.
    """
    db            = get_db()
    departed_refs = get_departed_refs()
    students      = db.execute("SELECT * FROM students WHERE upload_id=?", (upload_id,)).fetchall()
    cases         = {r['student_ref']: dict(r) for r in db.execute("SELECT * FROM cases").fetchall()}
    upload        = db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
    db.close()

    lines = ['Ref,Name,Form,Year,Days Attended,School Days,Days Absent,Term %,Risk,Status,Notes']
    for s in students:
        if s['ref'] in departed_refs:
            continue
        case   = cases.get(s['ref'], {})
        status = case.get('status', 'pending')
        notes  = case.get('notes', '').replace(',', ';').replace('\n', ' ')
        pct    = s['pct']
        risk   = ('Zero' if pct == 0 else 'Critical' if pct < 50 else
                  'Concern' if pct < 80 else 'Watch' if pct < 90 else 'Good')
        lines.append(
            f"{s['ref']},\"{s['name']}\",{s['form']},{s['year']},"
            f"{s['days_attended']},{s['days_total']},{s['days_absent']},"
            f"{pct},{risk},{status},\"{notes}\""
        )

    label      = upload['label'] if upload else f'upload_{upload_id}'
    safe_label = re.sub(r'[^\w\-]', '_', label)
    out_path   = os.path.join(tempfile.gettempdir(), f'export_{safe_label}.csv')

    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        f.write('\n'.join(lines))

    return send_file(out_path, as_attachment=True,
                     download_name=f'Moil_Attendance_{safe_label}.csv')


@app.route('/api/export/student/<int:ref>')
@login_required
def export_student_csv(ref):
    """
    Export the full case history for a single student as a downloadable CSV.
    Includes student info header rows then every contact log entry.
    Used for referrals, meetings, or welfare reports.
    """
    db      = get_db()
    student = db.execute(
        """SELECT s.* FROM students s JOIN uploads u ON s.upload_id=u.id
           WHERE s.ref=? AND u.parsed=1 ORDER BY u.upload_date DESC LIMIT 1""",
        (ref,)
    ).fetchone()
    case    = db.execute("SELECT * FROM cases WHERE student_ref=?", (ref,)).fetchone()
    history = db.execute(
        "SELECT * FROM case_history WHERE student_ref=? ORDER BY timestamp ASC", (ref,)
    ).fetchall()
    db.close()

    name      = student['name'] if student else f'Student_{ref}'
    form      = student['form'] if student else ''
    year      = student['year'] if student else ''
    pct       = student['pct']  if student else ''
    status    = case['status']  if case    else 'pending'
    safe_name = re.sub(r'[^\w\-]', '_', name)

    lines = [
        f'"Student Case Export"',
        f'"Name","{name}"',
        f'"Ref","{ref}"',
        f'"Form","{form}"',
        f'"Year","{year}"',
        f'"Current Attendance","{pct}%"',
        f'"Current Status","{status}"',
        f'""',
        f'"Contact History"',
        f'"Date","Time","Old Status","New Status","Contact Method","Outcome","Notes","Updated By"',
    ]
    for h in history:
        ts      = h['timestamp'] or ''
        date    = ts[:10] if len(ts) >= 10 else ts
        time    = ts[11:16] if len(ts) >= 16 else ''
        method  = (h['contact_method']  or '') if 'contact_method'  in h.keys() else ''
        outcome = (h['contact_outcome'] or '') if 'contact_outcome' in h.keys() else ''
        notes   = (h['notes'] or '').replace('"', "'").replace('\n', ' ')
        lines.append(
            f'"{date}","{time}","{h["old_status"]}","{h["new_status"]}","{method}","{outcome}","{notes}","{h["updated_by"]}"'
        )

    out_path = os.path.join(tempfile.gettempdir(), f'case_{safe_name}_{ref}.csv')
    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        f.write('\n'.join(lines))

    return send_file(out_path, as_attachment=True,
                     download_name=f'Case_{safe_name}.csv')


@app.route('/api/students/latest')
@login_required
def latest_students():
    """
    Return students from the most recent upload with case statuses merged.
    Fallback endpoint for getting current data without knowing the upload ID.
    """
    db            = get_db()
    departed_refs = get_departed_refs()
    latest        = db.execute(
        "SELECT * FROM uploads WHERE parsed=1 ORDER BY upload_date DESC LIMIT 1"
    ).fetchone()

    if not latest:
        db.close()
        return jsonify({'students': [], 'upload': {}})

    students = db.execute("SELECT * FROM students WHERE upload_id=?", (latest['id'],)).fetchall()
    cases    = {r['student_ref']: dict(r) for r in db.execute("SELECT * FROM cases").fetchall()}
    db.close()

    result = []
    for s in students:
        if s['ref'] not in departed_refs:
            sd           = dict(s)
            case         = cases.get(s['ref'], {})
            sd['status'] = case.get('status', 'pending')
            sd['notes']  = case.get('notes', '')
            result.append(sd)

    return jsonify({'students': result, 'upload': dict(latest)})


# =============================================================================
# API — STUDENT TREND (Weekly History)
# =============================================================================

@app.route('/api/trend/<int:ref>')
@login_required
def student_trend(ref):
    """
    Return a student's attendance history across ALL uploads — ordered by date.
    Used to draw the weekly trend graph on each student card.

    Returns a list of data points, one per upload the student appears in:
      { label, upload_date, pct, attended, absences, sessions }

    This lets the dashboard show whether attendance is improving,
    declining or staying flat across weeks/uploads.
    """
    db = get_db()
    # Join students with uploads to get label + date alongside attendance data
    rows = db.execute("""
        SELECT s.pct, s.attended, s.absences, s.sessions,
               u.label, u.upload_date, u.date_from, u.date_to
        FROM students s
        JOIN uploads u ON s.upload_id = u.id
        WHERE s.ref = ? AND u.parsed = 1
        ORDER BY u.upload_date ASC
    """, (ref,)).fetchall()
    db.close()

    trend = []
    for r in rows:
        trend.append({
            'label':       r['label'] or r['upload_date'][:10],
            'upload_date': r['upload_date'][:10],
            'date_from':   r['date_from'],
            'date_to':     r['date_to'],
            'pct':         r['pct'],
            'attended':    r['attended'],
            'absences':    r['absences'],
            'sessions':    r['sessions'],
            'days_absent': round(r['absences'] / 2, 1),
        })

    return jsonify({'ref': ref, 'trend': trend})


def parse_absentee_file(filepath):
    """
    Parse the Individual Absentee Report XLS to extract day-of-week absence patterns.
    Returns a dict: { student_name: { Mon:N, Tue:N, Wed:N, Thu:N, Fri:N, form:X, total:N } }

    Absence codes counted as absent: U (Unnotified), N (Sanctioned), X (Unacceptable),
    H (Internal Suspension), Z (Suspended), K (Community Unrest), S (Notified sick)
    """
    try:
        print(f"📊 Parsing absentee file: {os.path.getsize(filepath)} bytes")
        engine = 'openpyxl' if filepath.lower().endswith('.xlsx') else 'xlrd'
        print(f"📊 Using engine: {engine}")
        df_dict = pd.read_excel(filepath, sheet_name=None, header=None, engine=engine)
        sheet = list(df_dict.values())[0]
        print(f"📊 Sheet loaded: {sheet.shape}")

        ABSENT_CODES = {'U', 'N', 'X', 'H', 'Z', 'K', 'S'}
        students_data = {}
        current_name = None
        in_absences = False

        for _, row in sheet.iterrows():
            val0 = str(row[0]).strip() if pd.notna(row[0]) else ''
            val6 = str(row[6]).strip() if pd.notna(row[6]) else ''

            # Detect student name row
            if 'Form:' in val6 and val0 and val0 not in ['Moil Primary School', 'Individual Absentee Report', 'Date Range :']:
                current_name = val0.strip()
                form = val6.replace('Form:', '').strip()
                in_absences = False
                if current_name not in students_data:
                    students_data[current_name] = {'form': form, 'Mon': 0, 'Tue': 0, 'Wed': 0, 'Thu': 0, 'Fri': 0, 'total': 0}

            if val0 == 'Day/Date':
                in_absences = True
                continue

            if 'Total Half-Days' in val0 or 'Attendance Codes:' in val0:
                in_absences = False
                continue

            if in_absences and current_name and val0:
                date_match = re.match(r'(\w+),\s+\d+\w*\s+\w+', val0)
                if date_match:
                    day = date_match.group(1)
                    am = str(row[2]).strip() if pd.notna(row[2]) else ''
                    pm = str(row[4]).strip() if pd.notna(row[4]) else ''
                    if (am in ABSENT_CODES or pm in ABSENT_CODES) and day in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']:
                        students_data[current_name][day] += 1
                        students_data[current_name]['total'] += 1

        print(f"✅ Absentee report: {len(students_data)} students parsed")
        return students_data
    except Exception as e:
        import traceback
        print(f"❌ Absentee parse error: {e}")
        print(traceback.format_exc())
        return {}


@app.route('/api/upload/absentee', methods=['POST'])
@login_required
@admin_required
def upload_absentee():
    """
    Upload and parse an Individual Absentee Report XLS.

    Two modes:
      term   — replaces existing day analysis with full term data
      week   — merges new week's data into existing analysis (adds counts)

    Weekly merging: if existing_data is sent in the request, the new
    week's absence counts are ADDED to the existing counts per student.
    This builds up a full picture over time from weekly uploads.
    """
    print(f"📥 /api/upload/absentee called, files: {list(request.files.keys())}, form: {list(request.form.keys())}")
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    f         = request.files['file']
    print(f"📥 File received: {f.filename}, size will be saved to disk")
    upload_id = request.form.get('upload_id')
    period    = request.form.get('period', 'term')  # 'term' or 'week'
    existing_json = request.form.get('existing_data', None)

    if not f.filename:
        return jsonify({'error': 'No file selected'}), 400

    filename = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{secure_filename(f.filename)}"
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    f.save(filepath)

    new_data = parse_absentee_file(filepath)
    if not new_data:
        return jsonify({'error': 'Could not parse absentee file'}), 400

    # Weekly mode: merge new week into existing data
    if period == 'week' and existing_json:
        try:
            existing = json.loads(existing_json)
            for name, new_counts in new_data.items():
                if name in existing:
                    # Add new week's counts to existing counts
                    for day in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']:
                        existing[name][day] = existing[name].get(day, 0) + new_counts.get(day, 0)
                    existing[name]['total'] = existing[name].get('total', 0) + new_counts.get('total', 0)
                else:
                    existing[name] = new_counts
            merged_data = existing
            print(f"✅ Weekly merge: {len(new_data)} new + existing = {len(merged_data)} total students")
        except Exception as e:
            print(f"Merge error: {e} — using new data only")
            merged_data = new_data
    else:
        merged_data = new_data

    # Save merged/new data to database
    if upload_id:
        db = get_db()
        existing_row = db.execute(
            "SELECT id FROM day_analysis WHERE upload_id=?", (upload_id,)
        ).fetchone()
        if existing_row:
            db.execute(
                "UPDATE day_analysis SET day_data=? WHERE upload_id=?",
                (json.dumps(merged_data), upload_id)
            )
        else:
            db.execute(
                "INSERT INTO day_analysis (upload_id, day_data) VALUES (?,?)",
                (upload_id, json.dumps(merged_data))
            )
        db.commit()
        db.close()

    day_totals = {d: sum(s.get(d, 0) for s in merged_data.values()) for d in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']}
    worst_day  = max(day_totals, key=day_totals.get)

    return jsonify({
        'success':   True,
        'students':  len(merged_data),
        'period':    period,
        'day_totals': day_totals,
        'worst_day': worst_day,
        'data':      merged_data
    })



def get_dayofweek(upload_id):
    """Return stored day-of-week absence data for this upload."""
    db = get_db()
    row = db.execute(
        "SELECT day_data FROM day_analysis WHERE upload_id=?", (upload_id,)
    ).fetchone()
    db.close()
    if row:
        return jsonify({'data': json.loads(row['day_data'])})
    return jsonify({'data': None})


@app.route('/api/dayofweek/<int:upload_id>', methods=['POST'])
@login_required
@admin_required
def save_dayofweek(upload_id):
    """Save parsed day-of-week absence data for an upload."""
    data = request.json.get('data', {})
    db = get_db()
    existing = db.execute(
        "SELECT id FROM day_analysis WHERE upload_id=?", (upload_id,)
    ).fetchone()
    if existing:
        db.execute(
            "UPDATE day_analysis SET day_data=? WHERE upload_id=?",
            (json.dumps(data), upload_id)
        )
    else:
        db.execute(
            "INSERT INTO day_analysis (upload_id, day_data) VALUES (?,?)",
            (upload_id, json.dumps(data))
        )
    db.commit()
    db.close()
    return jsonify({'success': True})


# =============================================================================
# SERVER STARTUP
# =============================================================================


@app.route('/dayanalysis/<int:upload_id>')
@login_required
def dayanalysis_page(upload_id):
    db = get_db()
    upload = db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
    existing = db.execute("SELECT day_data FROM day_analysis WHERE upload_id=?", (upload_id,)).fetchone()
    db.close()
    data = json.loads(existing['day_data']) if existing else None
    days = ['Mon','Tue','Wed','Thu','Fri']
    day_colors = {'Mon':'#1A4F7A','Tue':'#2E7D32','Wed':'#6B2FAA','Thu':'#D35400','Fri':'#C0392B'}
    patterns = {}
    day_totals = {}
    if data:
        day_totals = {d: sum(s.get(d,0) for s in data.values()) for d in days}
        worst = max(day_totals, key=day_totals.get)
        best_day = min(day_totals, key=day_totals.get)
        max_count = max(day_totals.values()) or 1
        for name, s in data.items():
            vals = {d: s.get(d,0) for d in days}
            total = s.get('total', sum(vals.values()))
            max_day = max(vals, key=vals.get)
            max_val = vals[max_day]
            fri = vals['Fri']
            mon = vals['Mon']
            fri_mon = fri + mon
            mid = vals['Tue'] + vals['Wed'] + vals['Thu']
            if max_val == 0: pat = 'none'
            elif fri >= 5 and fri == max_val: pat = 'friday_always'
            elif fri >= 3 and fri >= mon and fri >= vals['Wed']: pat = 'friday_often'
            elif mon >= 3 and mon == max_val: pat = 'monday_often'
            elif fri_mon >= 5 and fri_mon > mid: pat = 'weekend_extended'
            elif vals['Wed'] >= 3 and vals['Wed'] == max_val: pat = 'midweek'
            elif total >= 10 and max_val <= total // 5 + 1: pat = 'random'
            else: pat = 'spread'
            patterns[name] = {'pattern': pat, 'max_day': max_day, 'max_val': max_val,
                'fri': fri, 'mon': mon, 'total': total, 'form': s.get('form','--'), 'days': vals}

    # Build upload form
    upload_form = """<div class="upload-form"><details><summary style="cursor:pointer;font-weight:700;color:#1A5C1A;">+ Upload New File (click to expand)</summary><div style="margin-top:12px;"><form method="POST" action="/dayanalysis/{uid}" enctype="multipart/form-data"><div style="display:flex;gap:8px;margin-bottom:10px;"><div class="modebt on" id="bt" onclick="sel('term')">Full Term<div style="font-size:11px;color:#888;">Replaces previous</div></div><div class="modebt" id="bw" onclick="sel('week')">Weekly<div style="font-size:11px;color:#888;">Adds to existing</div></div></div><input type="hidden" name="period" id="pi" value="term"><div class="file-input"><input type="file" name="file" accept=".xls,.xlsx" required></div><button type="submit" class="sbtn">Analyse</button></form></div></details></div>""".format(uid=upload_id)

    if not data:
        # No data yet — show upload form prominently
        content = "<div class=\'topbar\'><a href=\'/dashboard/{uid}\'>Back to Dashboard</a><h2>Day of Week Analysis</h2></div><div class=\'content\'>{form}</div>".format(uid=upload_id, form=upload_form)
        content = upload_form
        return "<!DOCTYPE html><html><head><meta charset=\'UTF-8\'><title>Day Analysis</title></head><body>" + content + "</body></html>"

    # Has data - render full results
    worst = max(day_totals, key=day_totals.get)
    best_day = min(day_totals, key=day_totals.get)
    max_count = max(day_totals.values()) or 1

    # Bars
    bars = ""
    for d in days:
        pct = int(day_totals[d] / max_count * 100)
        clr = '#C0392B' if d == worst else day_colors[d]
        bld = 'bold' if d == worst else 'normal'
        bars += '<div class="bar-row"><span class="bar-label" style="color:' + clr + ';font-weight:' + bld + ';">' + d + '</span><div class="bar-track"><div class="bar-fill" style="background:' + clr + ';width:' + str(pct) + '%;">' + str(day_totals[d]) + '</div></div><span class="bar-count" style="color:' + clr + ';font-weight:' + bld + ';">' + str(day_totals[d]) + '</span></div>'

    # Pattern counts
    pats = {}
    for p in patterns.values():
        pats[p['pattern']] = pats.get(p['pattern'],0) + 1

    fri_n = pats.get('friday_always',0) + pats.get('friday_often',0)
    mon_n = pats.get('monday_often',0) + pats.get('weekend_extended',0)
    med_n = pats.get('random',0)

    insights = ""
    if fri_n > 0:
        insights += '<div class="pat-card" style="background:#FFEBEE;border-color:#C0392B;"><strong style="color:#C0392B">Friday Pattern — ' + str(fri_n) + ' students</strong><p>These students consistently miss Fridays — likely extending the weekend. Recommend: Friday morning engagement calls, attendance reward programs, family conversation about weekend activities planning.</p></div>'
    if mon_n > 0:
        insights += '<div class="pat-card" style="background:#FFF3E0;border-color:#D35400;"><strong style="color:#D35400">Monday/Weekend Pattern — ' + str(mon_n) + ' students</strong><p>Missing Mondays or Fri+Mon suggests weekend activities running long or difficulty transitioning. Recommend: Monday check-in programs, Sunday family engagement.</p></div>'
    if med_n > 0:
        insights += '<div class="pat-card" style="background:#E8F5E9;border-color:#2E7D32;"><strong style="color:#2E7D32">Spread/Medical Pattern — ' + str(med_n) + ' students</strong><p>Absences spread across all days — suggests illness, chronic conditions, or family circumstances rather than avoidance. Consider medical review or health/NDIS referral.</p></div>'
    insights += '<div class="pat-card" style="background:#E3F2FD;border-color:#1A4F7A;"><strong style="color:#1A4F7A">School-Wide: ' + worst + ' is the hardest day</strong><p>' + worst + ' has ' + str(day_totals[worst]) + ' absent sessions vs ' + best_day + ' (' + str(day_totals[best_day]) + ') — a difference of ' + str(day_totals[worst]-day_totals[best_day]) + ' sessions. What makes ' + best_day + ' more engaging?</p></div>'

    # Table rows
    pat_info = {
        'friday_always': ('Always misses Fri', '#FFEBEE', '#C0392B'),
        'friday_often': ('Often misses Fri', '#FFF3E0', '#D35400'),
        'monday_often': ('Often misses Mon', '#FFF3E0', '#D35400'),
        'weekend_extended': ('Extended weekend', '#FFF3E0', '#E65100'),
        'midweek': ('Midweek absences', '#F3E5F5', '#6B2FAA'),
        'random': ('Spread/Medical', '#E8F5E9', '#2E7D32'),
        'spread': ('General absences', '#F5F5F5', '#666'),
        'none': ('No pattern', '#F5F5F5', '#999'),
    }
    tbody = ""
    forms_set = set()
    for name, p in sorted(patterns.items(), key=lambda x: x[1]['total'], reverse=True):
        if p['total'] < 1: continue
        forms_set.add(p['form'])
        pl, pbg, pclr = pat_info.get(p['pattern'], ('?','#eee','#333'))
        dcells = ""
        for d in days:
            n = p['days'].get(d,0)
            clr = day_colors[d]
            if n >= 5: cs = 'background:' + clr + ';color:white;font-weight:bold;border-radius:4px;padding:2px 5px;display:inline-block;'
            elif n >= 3: cs = 'background:' + clr + '33;color:' + clr + ';font-weight:bold;border-radius:4px;padding:2px 5px;display:inline-block;'
            elif n >= 1: cs = 'color:' + clr + ';font-weight:600;'
            else: cs = 'color:#ccc;'
            dcells += '<td style="text-align:center;"><span style="' + cs + '">' + (str(n) if n > 0 else '-') + '</span></td>'
        tbody += '<tr data-pattern="' + p['pattern'] + '" data-form="' + p['form'] + '" data-total="' + str(p['total']) + '"><td><strong>' + name + '</strong></td><td style="color:#666;">' + p['form'] + '</td><td style="text-align:center;font-weight:700;">' + str(p['total']) + '</td>' + dcells + '<td><span style="font-size:11px;background:' + pbg + ';color:' + pclr + ';padding:2px 8px;border-radius:8px;font-weight:700;">' + pl + '</span></td></tr>'

    form_opts = '<option value="">All Forms</option>' + ''.join('<option value="' + f + '">' + f + '</option>' for f in sorted(forms_set))
    lbl = upload['label'] if upload else ''

    page = """<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Day Analysis</title><style>
*{{box-sizing:border-box;margin:0;padding:0;}}
body{{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#F3F6FB;color:#1A2638;font-size:13px;line-height:1.5;}}
.topbar{{background:#1A2638;color:white;padding:0 20px;height:52px;display:flex;align-items:center;gap:16px;border-bottom:1px solid rgba(255,255,255,0.08);}}
.topbar a{{color:rgba(255,255,255,0.6);text-decoration:none;font-size:12px;font-weight:500;}}
.topbar a:hover{{color:white;}}
.topbar h2{{font-size:14px;font-weight:700;letter-spacing:-0.2px;}}
.content{{padding:20px;max-width:1200px;margin:0 auto;}}
.card{{background:white;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,0.06),0 1px 2px rgba(0,0,0,0.04);border:1px solid #E8EDF3;}}
.card h3{{font-size:13px;font-weight:700;margin-bottom:14px;color:#64748B;text-transform:uppercase;letter-spacing:0.5px;}}
.g2{{display:grid;grid-template-columns:1fr 1fr;gap:16px;}}
.bar-row{{display:flex;align-items:center;gap:10px;margin-bottom:10px;}}
.bar-label{{width:36px;font-size:12px;font-weight:700;}}
.bar-track{{flex:1;background:#F1F5F9;border-radius:6px;height:30px;overflow:hidden;}}
.bar-fill{{height:100%;border-radius:6px;display:flex;align-items:center;padding-left:10px;color:white;font-weight:700;font-size:12px;min-width:24px;transition:width 0.6s ease;}}
.bar-count{{width:36px;text-align:right;font-size:12px;font-weight:700;}}
.pat-card{{border-radius:10px;padding:14px;border-left:3px solid;margin-bottom:10px;}}
.pat-card strong{{font-size:13px;font-weight:700;}}
.pat-card p{{font-size:12px;color:#64748B;margin-top:5px;line-height:1.6;}}
.filters{{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center;}}
.filters select,.filters input{{padding:7px 10px;border:1.5px solid #E2E8F0;border-radius:8px;font-size:12px;font-family:inherit;background:white;color:#1A2638;}}
.filters select:focus,.filters input:focus{{outline:none;border-color:#5B8DEF;}}
.tbl-wrap{{max-height:500px;overflow-y:auto;border-radius:8px;border:1px solid #E8EDF3;}}
table{{width:100%;border-collapse:collapse;font-size:12px;}}
th{{background:#1A2638;color:white;padding:9px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:0.3px;position:sticky;top:0;z-index:1;}}
td{{padding:8px 12px;border-bottom:1px solid #F1F5F9;}}
tr:hover td{{background:#F8FAFC;}}
.upload-form{{background:white;border-radius:12px;padding:18px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,0.06);border:1px solid #E8EDF3;}}
.modebt{{border:2px solid #E2E8F0;background:white;border-radius:8px;padding:10px;cursor:pointer;flex:1;text-align:center;font-weight:600;color:#64748B;transition:all 0.15s;}}
.modebt.on{{border-color:#166534;background:#F0FDF4;color:#166534;}}
.file-input{{border:2px dashed #CBD5E0;border-radius:10px;padding:16px;text-align:center;background:#F8FAFC;margin:10px 0;}}
.sbtn{{background:#1A2638;color:white;border:none;border-radius:8px;padding:11px;font-size:13px;font-weight:700;cursor:pointer;width:100%;margin-top:8px;transition:background 0.15s;}}
.sbtn:hover{{background:#2D3F55;}}
.reset-btn{{padding:6px 12px;border:1.5px solid #E2E8F0;border-radius:7px;cursor:pointer;font-size:12px;background:white;color:#64748B;font-family:inherit;}}
.reset-btn:hover{{border-color:#5B8DEF;color:#5B8DEF;}}
</style></head><body>
<div class="topbar"><a href="/dashboard/{uid}">&#8592; Back to Dashboard</a><div style="width:1px;height:20px;background:rgba(255,255,255,0.15);"></div><h2>Day of Week Analysis</h2><span style="font-size:12px;color:rgba(255,255,255,0.5);margin-left:auto;">{lbl}</span></div>
<div class="content">
<div class="upload-form"><details><summary style="cursor:pointer;font-weight:700;color:#1A5C1A;font-size:13px;">+ Upload New File (click to expand)</summary><div style="margin-top:12px;"><form method="POST" action="/dayanalysis/{uid}" enctype="multipart/form-data"><div style="display:flex;gap:8px;margin-bottom:10px;"><div class="modebt on" id="bt" onclick="sel('term')">Full Term<div style="font-size:11px;color:#888;font-weight:400;">Replaces previous</div></div><div class="modebt" id="bw" onclick="sel('week')">Weekly<div style="font-size:11px;color:#888;font-weight:400;">Adds to existing</div></div></div><input type="hidden" name="period" id="pi" value="term"><div class="file-input"><input type="file" name="file" accept=".xls,.xlsx" required></div><button type="submit" class="sbtn">Analyse</button></form></div></details></div>
<div class="g2">
<div class="card"><h3>Absences by Day of Week</h3>{bars}</div>
<div class="card"><h3>Why Students Are Absent — Pattern Analysis</h3>{insights}</div>
</div>
<div class="card">
<h3>Student Absence Patterns ({total} students)</h3>
<div class="filters">
<select id="fp" onchange="flt()"><option value="">All Patterns</option><option value="friday_always">Always misses Fri</option><option value="friday_often">Often misses Fri</option><option value="monday_often">Often misses Mon</option><option value="weekend_extended">Extended weekend</option><option value="midweek">Midweek absences</option><option value="random">Spread/Medical</option></select>
<select id="ff" onchange="flt()">{form_opts}</select>
<input type="number" id="fm" placeholder="Min absences" style="width:110px;" onchange="flt()">
<span id="fc" style="color:#888;">{total} shown</span>
<button class="reset-btn" onclick="document.getElementById('fp').value='';document.getElementById('ff').value='';document.getElementById('fm').value='';flt();">Reset filters</button>
</div>
<div class="tbl-wrap"><table><thead><tr><th>Student</th><th>Form</th><th style="text-align:center;">Total</th><th style="text-align:center;color:#A4C8E8;">Mon</th><th style="text-align:center;color:#A8DFB9;">Tue</th><th style="text-align:center;color:#CE93D8;">Wed</th><th style="text-align:center;color:#FFCC80;">Thu</th><th style="text-align:center;color:#EF9A9A;">Fri</th><th>Pattern</th></tr></thead><tbody id="tb">{tbody}</tbody></table></div>
</div>
</div>
<script>
function sel(m){{document.getElementById('pi').value=m;document.getElementById('bt').className='modebt'+(m=='term'?' on':'');document.getElementById('bw').className='modebt'+(m=='week'?' on':'');}}
function flt(){{var p=document.getElementById('fp').value,f=document.getElementById('ff').value,m=parseInt(document.getElementById('fm').value)||0,n=0;document.querySelectorAll('#tb tr').forEach(function(r){{var s=(!p||r.dataset.pattern==p)&&(!f||r.dataset.form==f)&&parseInt(r.dataset.total)>=m;r.style.display=s?'':'none';if(s)n++;}});document.getElementById('fc').textContent=n+' shown';}}
</script>
</body></html>""".format(uid=upload_id, lbl=lbl, bars=bars, insights=insights, total=len([p for p in patterns.values() if p['total']>=1]), form_opts=form_opts, tbody=tbody)
    return page


@app.route('/dayanalysis/<int:upload_id>', methods=['POST'])
@login_required
@admin_required
def dayanalysis_upload(upload_id):
    if 'file' not in request.files:
        return "<h1>No file</h1>"
    f = request.files['file']
    period = request.form.get('period', 'term')
    filename = datetime.now().strftime('%Y%m%d_%H%M%S') + '_' + secure_filename(f.filename)
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    f.save(filepath)
    print(f"Day analysis file saved: {filepath}")
    new_data = parse_absentee_file(filepath)
    if not new_data:
        return "<h1>Parse failed</h1><p><a href='/dayanalysis/{0}'>Try again</a></p>".format(upload_id)

    # Enrich with form data
    db2 = get_db()
    students_db = db2.execute("SELECT name, form FROM students WHERE upload_id=?", (upload_id,)).fetchall()
    db2.close()
    student_forms = {s['name']: s['form'] for s in students_db}
    for name in new_data:
        if name in student_forms:
            new_data[name]['form'] = student_forms[name]
        else:
            surname = name.split(',')[0].strip()
            for db_name, form in student_forms.items():
                if db_name.startswith(surname + ','):
                    new_data[name]['form'] = form
                    break

    # Weekly merge
    if period == 'week':
        db3 = get_db()
        existing_row = db3.execute("SELECT day_data FROM day_analysis WHERE upload_id=?", (upload_id,)).fetchone()
        db3.close()
        if existing_row:
            existing = json.loads(existing_row['day_data'])
            for name, nd in new_data.items():
                if name in existing:
                    for day in ['Mon','Tue','Wed','Thu','Fri']:
                        existing[name][day] = existing[name].get(day,0) + nd.get(day,0)
                    existing[name]['total'] = existing[name].get('total',0) + nd.get('total',0)
                else:
                    existing[name] = nd
            new_data = existing

    # Save
    db = get_db()
    existing = db.execute("SELECT id FROM day_analysis WHERE upload_id=?", (upload_id,)).fetchone()
    if existing:
        db.execute("UPDATE day_analysis SET day_data=? WHERE upload_id=?", (json.dumps(new_data), upload_id))
    else:
        db.execute("INSERT INTO day_analysis (upload_id, day_data) VALUES (?,?)", (upload_id, json.dumps(new_data)))
    db.commit()
    db.close()

    # Redirect back to GET to show results
    from flask import redirect
    return redirect('/dayanalysis/' + str(upload_id))


@app.route('/api/dayofweek/<int:upload_id>', methods=['GET'])
@login_required
def get_dayofweek_data(upload_id):
    """Return stored day-of-week analysis data for dashboard display"""
    db = get_db()
    row = db.execute("SELECT day_data FROM day_analysis WHERE upload_id=?", (upload_id,)).fetchone()
    db.close()
    if row:
        return jsonify({'data': json.loads(row['day_data'])})
    return jsonify({'data': None})

@app.route('/debug')
def debug():
    import os
    template_path = os.path.join(app.root_path, 'templates', 'dashboard.html')
    exists = os.path.exists(template_path)
    size = os.path.getsize(template_path) if exists else 0
    with open(template_path, 'r') as f:
        first_500 = f.read(500)
    return f"<pre>Template path: {template_path}\nExists: {exists}\nSize: {size} bytes\nFirst 500 chars:\n{first_500}</pre>"

if __name__ == '__main__':
    import os
    template_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'templates', 'dashboard.html')
    print("\n" + "=" * 50)
    print("  Moil Primary Attendance System")
    print("  Open your browser:  http://localhost:5000")
    print("  Share with others:  http://[YOUR-IP]:5000")
    print("=" * 50)
    print(f"  Template path: {template_path}")
    print(f"  Template exists: {os.path.exists(template_path)}")
    if os.path.exists(template_path):
        print(f"  Template size: {os.path.getsize(template_path)} bytes")
    print("=" * 50 + "\n")
    # host='0.0.0.0' makes the server accessible from other computers on the network
    # debug=False for stable production use (set True only during development)
    app.run(host='0.0.0.0', port=5000, debug=False)
