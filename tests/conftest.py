"""
Shared pytest fixtures for the School Attendance Dashboard test suite.

Strategy
--------
The production app is a single-file Flask app (moil_backend/app.py) that
initialises its SQLite database at module-import time using a hardcoded
relative path.  We redirect DB_PATH to a temp file immediately after
import, then re-run init_db() so every test runs against a clean,
isolated schema — never the production database.

No production files are touched.
"""

import os
import sys
import tempfile

import pytest
from werkzeug.security import generate_password_hash

# ---------------------------------------------------------------------------
# Path setup — allow `import app` from the moil_backend package
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'moil_backend'))

# ---------------------------------------------------------------------------
# Redirect the DB to a temp file BEFORE any route is ever called.
#
# Importing the module runs init_db() with the real DB_PATH — that's fine,
# it just creates instance/ dirs wherever pytest's CWD is (not production).
# We immediately override DB_PATH and re-run init_db() for the test schema.
# ---------------------------------------------------------------------------
import app as _app                              # triggers module-level init

_tmp_db_fd, _TMP_DB = tempfile.mkstemp(suffix='_test.db', prefix='attendance_')
os.close(_tmp_db_fd)

_app.DB_PATH = _TMP_DB                          # all get_db() calls now use this
_app.init_db()                                  # build schema + seed default admin


# ---------------------------------------------------------------------------
# Session-scoped app fixture
# ---------------------------------------------------------------------------

@pytest.fixture(scope='session')
def flask_app():
    _tmp_uploads = tempfile.mkdtemp()
    _app.app.config.update({
        'TESTING': True,
        'WTF_CSRF_ENABLED': False,
        'SECRET_KEY': 'pytest-secret-key',
        'UPLOAD_FOLDER': _tmp_uploads,
    })
    yield _app.app
    # Teardown: remove temp DB after the full test session
    try:
        os.unlink(_TMP_DB)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Per-test client fixtures (each gets its own fresh client + session)
# ---------------------------------------------------------------------------

@pytest.fixture
def client(flask_app):
    """Unauthenticated test client."""
    with flask_app.test_client() as c:
        yield c


@pytest.fixture
def auth_admin(flask_app):
    """Test client pre-logged-in as the seeded admin user."""
    with flask_app.test_client() as c:
        c.post('/login',
               data={'username': 'admin', 'password': 'admin123'},
               follow_redirects=True)
        yield c


@pytest.fixture
def auth_teacher(flask_app):
    """Test client pre-logged-in as a teacher (created once via INSERT OR IGNORE)."""
    db = _app.get_db()
    db.execute(
        "INSERT OR IGNORE INTO users "
        "(username, password_hash, display_name, role) VALUES (?,?,?,?)",
        ('teacher1', generate_password_hash('pass1234'), 'Test Teacher', 'teacher'),
    )
    db.commit()
    db.close()

    with flask_app.test_client() as c:
        c.post('/login',
               data={'username': 'teacher1', 'password': 'pass1234'},
               follow_redirects=True)
        yield c


# ---------------------------------------------------------------------------
# Data fixture: a minimal upload + one student row
# ---------------------------------------------------------------------------

@pytest.fixture
def seeded_upload():
    """
    Insert one parsed upload and one student directly into the test DB.
    Cleaned up after each test that uses it.
    """
    db = _app.get_db()
    db.execute(
        "INSERT INTO uploads (filename, label, parsed, student_count) VALUES (?,?,1,1)",
        ('test_upload.xlsx', 'Test Week 1'),
    )
    upload_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    db.execute(
        """INSERT INTO students
           (ref, name, year, form, upload_id,
            attended, sessions, absences, pct,
            days_attended, days_total, days_absent)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (9001, 'Test, Student', '05', 'TESTFORM', upload_id,
         8, 10, 2, 80.0, 4.0, 5.0, 1.0),
    )
    db.commit()
    db.close()

    yield {'upload_id': upload_id, 'student_ref': 9001}

    # Teardown
    db = _app.get_db()
    for stmt, val in [
        ("DELETE FROM students WHERE ref=?",       (9001,)),
        ("DELETE FROM uploads WHERE id=?",          (upload_id,)),
        ("DELETE FROM cases WHERE student_ref=?",   (9001,)),
        ("DELETE FROM case_plans WHERE student_ref=?", (9001,)),
        ("DELETE FROM case_history WHERE student_ref=?", (9001,)),
    ]:
        db.execute(stmt, val)
    db.commit()
    db.close()
