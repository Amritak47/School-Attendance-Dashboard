# Moil Primary School — Attendance Management System
## Setup & User Guide

---

## QUICK START (Windows)

1. Install Python from https://python.org (tick "Add to PATH" during install)
2. Double-click **START.bat**
3. Your browser will open automatically at http://localhost:5000
4. Done!

---

## QUICK START (Mac)

1. Open Terminal
2. Navigate to this folder:  cd /path/to/moil_backend
3. Run:  bash start_mac.sh
4. Browser opens at http://localhost:5000

---

## HOW TO USE

### Uploading a New File
1. Go to the Control Panel (home page)
2. Drag and drop your XLS file onto the upload area (or click to browse)
3. Give it a label (e.g. "Week 7" or "Term 1 Cumulative")
4. Select the type and term
5. Click "Upload & Generate Dashboard"
6. The system parses the file and opens the dashboard automatically

### Managing Cases
- Open any dashboard from the Control Panel
- Change a student's status using the dropdown (Pending → Contacted → Meeting → Referred → Resolved)
- Add notes in the notes column
- **Everything saves to the database automatically** — no need to click save
- Notes and statuses persist across all future uploads

### Comparing Weeks
1. Go to "Compare Weeks" in the top navigation
2. Select an earlier upload and a later upload
3. Click "Compare Now"
4. See which students improved, worsened, or are new/removed

### Recording Departed Students
1. From the Control Panel, click "+ Add" next to Departed Students
2. Enter the student's reference number, name, form, and reason
3. They will be hidden from all dashboards but kept in the database
4. To restore a student, click the ↩ button next to their name

### Exporting Data
- From any dashboard, click "Export Excel/CSV" in the top right
- The file includes all current notes and statuses
- Great for sharing with your principal or welfare team

---

## WHO CAN ACCESS IT

The system runs on your computer. Anyone on your school's local network can access it by going to:
  http://YOUR-COMPUTER-IP:5000

To find your IP address:
- Windows: Open Command Prompt → type "ipconfig" → look for IPv4 Address
- Mac: System Settings → Network → look for IP Address

---

## FILE FORMATS SUPPORTED

- .XLS (standard Maze/school system export) ✅
- .XLSX ✅

The system expects the standard Maze attendance analysis export format
(Form headers, student rows with ref, name, year, form, attended, sessions, absences, %)

---

## DATA STORAGE

All data is stored in:  instance/attendance.db

This is a SQLite database file. Back it up regularly by copying the entire "instance" folder.

---

## TROUBLESHOOTING

**"Python not found"** — Install Python from python.org, make sure to tick "Add to PATH"

**"Port already in use"** — Another program is using port 5000. Edit app.py last line: change port=5000 to port=5001

**File won't parse** — Make sure it's a standard Maze attendance export. Check the column order matches the expected format.

**LibreOffice error with .xls files** — Install LibreOffice from https://libreoffice.org (free)
