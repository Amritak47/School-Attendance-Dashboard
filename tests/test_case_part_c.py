"""
Tests for Part C additions to the case management system:
  - closure_reason required to resolve a case (POST /api/case/update)
  - structured referrals CRUD (/api/case/<ref>/referrals, /api/referral/<id>)
  - consecutive_weeks_below_threshold() — Targeted Follow-Up escalation flag
  - case_tier() — Part D display tier mapping
  - case_needs_signoff() — sign-off compliance flag
  - /api/principal/case-metrics
"""

import json
import sys
import os
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'moil_backend'))
import app as _app


class TestClosureReason:
    def test_resolve_without_closure_reason_rejected(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'contacted',
        })
        r = auth_admin.post('/api/case/update', json={'student_ref': ref, 'status': 'resolved'})
        assert r.status_code == 400

    def test_resolve_with_closure_reason_succeeds(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'contacted',
        })
        r = auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'status': 'resolved', 'closure_reason': 'attendance_improved',
        })
        assert r.status_code == 200
        case = json.loads(auth_admin.get(f'/api/case/{ref}').data)['case']
        assert case['closure_reason'] == 'attendance_improved'
        assert case['resolved_at'] is not None

    def test_invalid_closure_reason_rejected(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'contacted',
        })
        r = auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'status': 'resolved', 'closure_reason': 'not_a_real_reason',
        })
        assert r.status_code == 400

    def test_reopening_resolved_case_clears_closure(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'resolved', 'closure_reason': 'family_disengaged',
        })
        auth_admin.post('/api/case/update', json={'student_ref': ref, 'status': 'contacted'})
        case = json.loads(auth_admin.get(f'/api/case/{ref}').data)['case']
        assert case['closure_reason'] is None
        assert case['resolved_at'] is None


class TestReferrals:
    def test_add_and_list_referral(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        r = auth_admin.post(f'/api/case/{ref}/referrals', json={
            'agency_name': 'Anglicare', 'referral_date': '2026-02-01',
        })
        assert r.status_code == 200
        rid = json.loads(r.data)['id']

        referrals = json.loads(auth_admin.get(f'/api/case/{ref}/referrals').data)
        assert any(x['id'] == rid and x['agency_name'] == 'Anglicare' for x in referrals)

    def test_add_referral_requires_agency_name(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        r = auth_admin.post(f'/api/case/{ref}/referrals', json={'agency_name': '  '})
        assert r.status_code == 400

    def test_update_referral_outcome(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        rid = json.loads(auth_admin.post(f'/api/case/{ref}/referrals',
            json={'agency_name': 'NTCAT'}).data)['id']
        r = auth_admin.post(f'/api/referral/{rid}', json={'outcome': 'Assessment booked'})
        assert r.status_code == 200
        referrals = json.loads(auth_admin.get(f'/api/case/{ref}/referrals').data)
        assert next(x for x in referrals if x['id'] == rid)['outcome'] == 'Assessment booked'

    def test_delete_referral(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        rid = json.loads(auth_admin.post(f'/api/case/{ref}/referrals',
            json={'agency_name': 'Temp Agency'}).data)['id']
        auth_admin.delete(f'/api/referral/{rid}')
        referrals = json.loads(auth_admin.get(f'/api/case/{ref}/referrals').data)
        assert not any(x['id'] == rid for x in referrals)


class TestTargetedFollowUpFlag:
    def test_no_consecutive_weeks_when_above_threshold(self, seeded_upload):
        ref = seeded_upload['student_ref']  # pct 80.0 — not below 80
        db = _app.get_db()
        weeks = _app.consecutive_weeks_below_threshold(ref, db)
        db.close()
        assert weeks == 0

    def test_counts_consecutive_weeks_below_threshold(self, seeded_upload):
        ref = seeded_upload['student_ref']
        db = _app.get_db()
        extra_upload_ids = []
        # Add two more (newer) uploads where this student is below 80%
        for label, pct in [('Week 2', 70.0), ('Week 3', 60.0)]:
            db.execute("INSERT INTO uploads (filename, label, parsed, student_count) VALUES (?,?,1,1)",
                       (f'{label}.xlsx', label))
            uid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
            extra_upload_ids.append(uid)
            db.execute("""INSERT INTO students
                (ref, name, year, form, upload_id, attended, sessions, absences, pct,
                 days_attended, days_total, days_absent)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (ref, 'Test, Student', '05', 'TESTFORM', uid, 7, 10, 3, pct, 3.5, 5.0, 1.5))
        db.commit()
        try:
            weeks = _app.consecutive_weeks_below_threshold(ref, db)
            # The 2 new below-80 uploads, but NOT the original 80.0 (at threshold, not below)
            assert weeks == 2
        finally:
            for uid in extra_upload_ids:
                db.execute("DELETE FROM uploads WHERE id=?", (uid,))
            db.commit()
            db.close()


class TestCaseTier:
    def test_tier_boundaries(self):
        assert _app.case_tier(95) == 'On Track'
        assert _app.case_tier(90) == 'On Track'
        assert _app.case_tier(85) == 'Tier 1/2 Monitor'
        assert _app.case_tier(65) == 'Tier 3 Intensive'
        assert _app.case_tier(59) == 'Tier 4 Severe'


class TestSignoffFlag:
    def test_no_flag_when_case_recent(self):
        case_row = {'opened_at': datetime.now().isoformat()}
        assert _app.case_needs_signoff(case_row, '{}') is False

    def test_flag_when_open_over_two_weeks_no_signature(self):
        opened = (datetime.now() - timedelta(days=20)).isoformat()
        case_row = {'opened_at': opened}
        assert _app.case_needs_signoff(case_row, '{}') is True

    def test_no_flag_when_signed(self):
        opened = (datetime.now() - timedelta(days=20)).isoformat()
        case_row = {'opened_at': opened}
        plan = json.dumps({'sig-parent': '2026-02-01'})
        assert _app.case_needs_signoff(case_row, plan) is False

    def test_no_flag_when_case_not_opened(self):
        assert _app.case_needs_signoff({'opened_at': None}, '{}') is False


class TestPrincipalCaseMetrics:
    def test_returns_expected_keys(self, auth_admin):
        r = auth_admin.get('/api/principal/case-metrics?period_key=Term 1 2026')
        assert r.status_code == 200
        data = json.loads(r.data)
        for key in ('opened_this_term', 'resolved_this_term', 'avg_days_to_resolution',
                    'pct_improved', 'tier4_count', 'escalation_rate'):
            assert key in data

    def test_teacher_denied(self, auth_teacher):
        r = auth_teacher.get('/api/principal/case-metrics', follow_redirects=False)
        assert r.status_code in (301, 302)
