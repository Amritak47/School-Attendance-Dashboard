# Attendly Schools — SaaS Redesign Spec
**Date:** 2026-04-07  
**Status:** Approved  
**Stack:** Flask backend (unchanged) + Tailwind CDN + Alpine.js + Heroicons SVG

---

## 1. Product Identity
- **Name:** Attendly Schools
- **Tagline:** Smart attendance management for every school
- **Primary users:** Attendance Officers (daily, dense data) + Principals (summaries, reports)

---

## 2. Layout Architecture

### SaaS Shell
- Fixed left sidebar: 260px, deep navy `#0F172A`
- Top bar: 60px, white, page title + upload CTA + save indicator
- Content area: fills remaining space, bg `#F8FAFC`

### Sidebar Navigation (with Heroicons SVG)
1. Dashboard (home icon)
2. Students (users icon)
3. Cases (clipboard-list icon)
4. Reports (chart-bar icon)
5. Upload (cloud-upload icon)
— divider —
6. Settings (cog icon)

Footer: school name + last sync time

---

## 3. Pages

### Dashboard
- 4 KPI cards: Total Students, Critical (<50%), Below 80%, School Average
- Urgent action strip: students needing contact today (never contacted + overdue follow-up)
- Charts: Attendance Distribution (donut, Chart.js) + Trend Over Time (line, Chart.js)
- Case pipeline: 5 status pills with counts

### Students
- Filters (accurate, easy-to-use):
  - Search: name or ref number (instant, debounced)
  - Attendance range: All / At Risk (<50%) / Concern (50–79%) / Watch (80–89%) / Good (90%+)
  - Form/Class: dropdown of all forms from data
  - Year group: dropdown
  - Case status: All / Pending / Contacted / Meeting / Referred / Resolved
  - Sort: Name A–Z / Attendance ↑↓ / Last Updated
  - Clear all filters button
- Table: Ref, Name, Form, Year, Attendance %, bar, Case Status badge, Notes snippet, Actions
- Click row → slide-out drawer with full history, trend chart, notes editor

### Cases
- Left filter panel: status pills (All + each status with count)
- Additional filters: Form dropdown, Attendance tier, Date range for last updated
- Student cards (grid): name, %, status badge, last contact date, notes preview
- Expand card inline → edit status, notes, view history
- Auto-save with visual indicator

### Reports
- Inner tab strip: Summary · Compare Weeks · Day Analysis
- **Summary:** Principal-ready one-pager, printable, school logo, key stats
- **Compare Weeks:** Select 2 uploads → improved/worsened/stable/new stats + bar charts + full table
- **Day Analysis:** Upload absentee file → day-of-week patterns table + insights

### Upload
- Drag-drop zone (large, clear)
- Labelled form: Report Label*, Report Type, Term, Week Number
- Submit button with loading state
- Previous uploads table: Label, Term, Week, Students, Date, Actions (Open / Export CSV / Delete)

### Settings
- **Departed Students section:**
  - Table: Ref, Name, Form, Reason, Date, Actions
  - Actions: **Restore** (↩) + **Delete permanently** (🗑 with confirmation)
  - Add Departure button → modal with labelled form
- App info: version, last sync

---

## 4. Filters (detailed)

All filter bars follow this pattern:
- Search input with magnifier icon (left-aligned)
- Dropdown selects for categorical filters
- Active filter count badge on "Filters" label
- "Clear all" link appears only when filters are active
- Result count shown: "Showing 14 of 87 students"
- Filters persist within session (Alpine.js reactive state)

---

## 5. Buttons — All Must Work

| Button | Action |
|--------|--------|
| Upload & Generate | POST /api/upload → redirect to dashboard |
| Open Dashboard | GET /dashboard/<id> |
| Export CSV | GET /api/export/<id> |
| Delete Upload | DELETE /api/upload/<id> with confirm dialog |
| Print Report | window.print() with print stylesheet |
| Export PDF | window.print() (print-to-PDF) |
| Save Case Notes | POST /api/case/update (auto-save debounced) |
| View Case History | GET /api/case/<ref> → slide-out drawer |
| Add Departure | POST /api/depart |
| Restore Student | DELETE /api/depart/<ref> |
| Delete Departed | DELETE /api/depart/<ref>/permanent (new endpoint needed) OR soft-delete via existing |
| Run Comparison | GET /api/compare/<id1>/<id2> |
| Upload Day Analysis | POST /api/upload/absentee |
| Clear Filters | Reset Alpine.js reactive state |

---

## 6. Design Tokens

```css
--sidebar-bg: #0F172A
--sidebar-hover: rgba(255,255,255,0.06)
--sidebar-active-bg: rgba(99,102,241,0.18)
--sidebar-active-text: #FFFFFF
--sidebar-text: #94A3B8
--accent: #6366F1
--accent-dark: #4F46E5
--success: #10B981
--warning: #F59E0B
--danger: #EF4444
--content-bg: #F8FAFC
--surface: #FFFFFF
--text: #1E293B
--text-secondary: #64748B
--border: #E2E8F0
--radius: 10px
--shadow-sm: 0 1px 3px rgba(0,0,0,0.07)
--shadow: 0 4px 16px rgba(0,0,0,0.08)
Font: Inter (300,400,500,600,700,800) — Google Fonts
Icons: Heroicons SVG inline (no emojis in UI)
Charts: Chart.js 4.4.1 (existing)
JS: Alpine.js x-data for reactive state (no React needed)
```

---

## 7. What Does NOT Change
- All Flask routes (`/`, `/dashboard/<id>`, `/compare`, `/api/*`)
- All Python/SQLite backend logic
- All existing JS API calls (fetch endpoints stay identical)
- File upload parsing logic

---

## 8. New Backend Endpoint Needed
- `DELETE /api/depart/<ref>/permanent` — permanently deletes departed student record
