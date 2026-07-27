"""
Tests for the Part A post-case tracking engine:
  - baseline capture when a case opens (POST /api/case/update)
  - update_case_tracking() — current pct refresh, up/down/same change,
    term-boundary baseline reset, baseline backfill for pre-existing cases
  - POST /api/case/<ref>/review — outcome logging + escalation after two
    consecutive 'no_change'/'worse' reviews
  - resolved cases stop being tracked
"""

import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'moil_backend'))
import app as _app


def _cleanup(refs):
    db = _app.get_db()
    for ref in refs:
        db.execute("DELETE FROM cases WHERE student_ref=?", (ref,))
        db.execute("DELETE FROM case_history WHERE student_ref=?", (ref,))
        db.execute("DELETE FROM case_reviews WHERE student_ref=?", (ref,))
        db.execute("DELETE FROM students WHERE ref=?", (ref,))
    db.commit()
    db.close()


class TestBaselineCapture:
    def test_opening_a_case_captures_baseline(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']  # pct 80.0 in seeded_upload fixture
        r = auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'contacted', 'period_key': 'Term 1 2026',
        })
        assert r.status_code == 200

        case = json.loads(auth_admin.get(f'/api/case/{ref}').data)['case']
        assert case['baseline_period_key'] == 'Term 1 2026'
        assert case['baseline_ytd_pct'] == 80.0
        assert case['baseline_term_pct'] == 80.0
        assert case['opened_at'] is not None
        assert case['days_open'] == 0

    def test_baseline_only_captured_once(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'contacted', 'period_key': 'Term 1 2026',
        })
        first_opened_at = json.loads(auth_admin.get(f'/api/case/{ref}').data)['case']['opened_at']

        # A later status change should not re-stamp opened_at / baseline
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'status': 'meeting', 'period_key': 'Term 2 2026',
        })
        case = json.loads(auth_admin.get(f'/api/case/{ref}').data)['case']
        assert case['opened_at'] == first_opened_at
        assert case['baseline_period_key'] == 'Term 1 2026'


class TestUpdateCaseTracking:
    def test_term_pct_updates_and_change_direction(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'contacted', 'period_key': 'Term 1 2026',
        })

        db = _app.get_db()
        _app.update_case_tracking(db, 'Term 1 2026', [{'ref': ref, 'pct': 60.0}])
        db.commit()
        db.close()

        case = json.loads(auth_admin.get(f'/api/case/{ref}').data)['case']
        assert case['current_term_pct'] == 60.0
        assert case['term_change'] == 'down'

    def test_ytd_pct_updates_independently_of_term(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'contacted', 'period_key': 'Term 1 2026',
        })

        db = _app.get_db()
        _app.update_case_tracking(db, 'YTD 2026', [{'ref': ref, 'pct': 90.0}])
        db.commit()
        db.close()

        case = json.loads(auth_admin.get(f'/api/case/{ref}').data)['case']
        assert case['current_ytd_pct'] == 90.0
        assert case['ytd_change'] == 'up'
        # Term fields untouched by a YTD-period upload
        assert case['current_term_pct'] is None

    def test_term_boundary_resets_term_baseline(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'contacted', 'period_key': 'Term 1 2026',
        })

        db = _app.get_db()
        _app.update_case_tracking(db, 'Term 2 2026', [{'ref': ref, 'pct': 55.0}])
        db.commit()
        db.close()

        case = json.loads(auth_admin.get(f'/api/case/{ref}').data)['case']
        assert case['baseline_period_key'] == 'Term 2 2026'
        assert case['baseline_term_pct'] == 55.0
        assert case['term_change'] == 'same'  # current == freshly-reset baseline
        assert 'Term 2 2026' in case['term_baseline_reset_note']

    def test_resolved_cases_are_not_tracked(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'resolved', 'period_key': 'Term 1 2026',
            'closure_reason': 'attendance_improved',
        })

        db = _app.get_db()
        _app.update_case_tracking(db, 'Term 1 2026', [{'ref': ref, 'pct': 10.0}])
        db.commit()
        db.close()

        case = json.loads(auth_admin.get(f'/api/case/{ref}').data)['case']
        assert case['current_term_pct'] is None

    def test_baseline_backfilled_for_pre_existing_case(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        # Case created directly with no baseline — simulates a case opened
        # before this tracking engine existed.
        db = _app.get_db()
        db.execute(
            "INSERT INTO cases (student_ref, student_name, form, status) VALUES (?,?,?,?)",
            (ref, 'Test, Student', 'TESTFORM', 'contacted')
        )
        db.commit()

        _app.update_case_tracking(db, 'Term 1 2026', [{'ref': ref, 'pct': 80.0}])
        db.commit()
        db.close()

        case = json.loads(auth_admin.get(f'/api/case/{ref}').data)['case']
        assert case['baseline_ytd_pct'] == 80.0  # backfilled from seeded_upload's row
        assert 'backfilled' in case['term_baseline_reset_note']


class TestReviewLogging:
    def test_log_review_outcome(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'contacted', 'period_key': 'Term 1 2026',
        })
        r = auth_admin.post(f'/api/case/{ref}/review', json={'outcome': 'improved'})
        assert r.status_code == 200
        data = json.loads(r.data)
        assert data['success'] is True
        assert data['escalation_flag'] is False

    def test_unknown_outcome_rejected(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'contacted',
        })
        r = auth_admin.post(f'/api/case/{ref}/review', json={'outcome': 'bogus'})
        assert r.status_code == 400

    def test_review_for_nonexistent_case_404s(self, auth_admin):
        r = auth_admin.post('/api/case/99999/review', json={'outcome': 'improved'})
        assert r.status_code == 404

    def test_escalation_after_two_consecutive_bad_reviews(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'contacted',
        })

        r1 = auth_admin.post(f'/api/case/{ref}/review', json={'outcome': 'no_change'})
        assert json.loads(r1.data)['escalation_flag'] is False
        assert json.loads(r1.data)['consecutive_bad_reviews'] == 1

        r2 = auth_admin.post(f'/api/case/{ref}/review', json={'outcome': 'worse'})
        assert json.loads(r2.data)['escalation_flag'] is True
        assert json.loads(r2.data)['consecutive_bad_reviews'] == 2

    def test_improved_review_resets_escalation(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        auth_admin.post('/api/case/update', json={
            'student_ref': ref, 'student_name': 'Test, Student', 'form': 'TESTFORM',
            'status': 'contacted',
        })
        auth_admin.post(f'/api/case/{ref}/review', json={'outcome': 'no_change'})
        auth_admin.post(f'/api/case/{ref}/review', json={'outcome': 'worse'})
        r3 = auth_admin.post(f'/api/case/{ref}/review', json={'outcome': 'improved'})
        data = json.loads(r3.data)
        assert data['escalation_flag'] is False
        assert data['consecutive_bad_reviews'] == 0
