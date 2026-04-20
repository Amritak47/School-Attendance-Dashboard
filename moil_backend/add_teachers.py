"""
Run this once from the moil_backend folder to add all teacher accounts.
  Windows:  python add_teachers.py
  Mac/Linux: python3 add_teachers.py
"""
import sqlite3, os
from werkzeug.security import generate_password_hash

DB = os.path.join(os.path.dirname(__file__), 'instance', 'attendance.db')

teachers = [
    ("Rachel Birkin",      "rachel.birkin",      "rachel#7443",       "ACACIA"),
    ("Fiona Nixon",        "fiona.nixon",         "fiona#2197",        "BUSHBEES"),
    ("Aleasha Edis",       "aleasha.edis",        "aleasha#6852",      "BUSHBEES"),
    ("Neisha Schilling",   "neisha.schilling",    "neisha#2958",       "CATERPILLARS"),
    ("Angela Gahan",       "angela.gahan",        "angela#2698",       "DESERT ROSE"),
    ("Kathryn Downing",    "kathryn.downing",     "kathryn#0478",      "HIBISCUS."),
    ("Kristy Love",        "kristy.love",         "kristy#0478",       "IEC CYCAD"),
    ("Merran Kamitsis",    "merran.kamitsis",     "merran#6449",       "IEC DRAGONFLY"),
    ("Crystalbelle Guppy", "crystalbelle.guppy",  "crystalbelle#5513", "IEC FRANGIPANI"),
    ("Merryn Coughlan",    "merryn.coughlan",     "merryn#6847",       "IEC G/T FROGS"),
    ("Ruoyao Yang",        "ruoyao.yang",         "ruoyao#8030",       "IEC G/WATTLE"),
    ("Michelle Tippett",   "michelle.tippett",    "michelle#8415",     "PRE GECKOS"),
]

db = sqlite3.connect(DB)
added = 0
for display, username, pwd, form in teachers:
    existing = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if existing:
        print(f"  SKIP (already exists): {username}")
        continue
    db.execute(
        "INSERT INTO users (username, password_hash, display_name, role, form_access, created_by) VALUES (?,?,?,?,?,?)",
        (username, generate_password_hash(pwd), display, 'teacher', form, 'admin')
    )
    print(f"  ADDED: {display} ({username}) → {form}")
    added += 1

db.commit()
db.close()
print(f"\n✅ Done — {added} teacher accounts added.")
print("\nCredentials summary:")
print(f"{'Name':<25} {'Username':<22} {'Password':<20} Class")
print("-" * 85)
for display, username, pwd, form in teachers:
    print(f"{display:<25} {username:<22} {pwd:<20} {form}")
