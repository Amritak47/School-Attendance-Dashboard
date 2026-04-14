"""
Tests for student data, upload listing, trend, and depart endpoints.

Endpoints covered:
  GET    /api/uploads
  GET    /api/students/latest
  GET    /api/trend/<ref>
  POST   /api/depart
  DELETE /api/depart/<ref>
  DELETE /api/depart/<ref>/permanent
"""

import json


class TestListUploads:
    def test_returns_list_when_authenticated(self, auth_admin):
        r = auth_admin.get('/api/uploads')
        assert r.status_code == 200
        assert isinstance(json.loads(r.data), list)

    def test_unauthenticated_denied(self, client):
        r = client.get('/api/uploads', follow_redirects=False)
        assert r.status_code in (301, 302)

    def test_seeded_upload_appears_in_list(self, auth_admin, seeded_upload):
        r = auth_admin.get('/api/uploads')
        uploads = json.loads(r.data)
        ids = [u['id'] for u in uploads]
        assert seeded_upload['upload_id'] in ids


class TestLatestStudents:
    def test_returns_expected_structure_with_no_uploads(self, auth_admin):
        # Even with no uploads the endpoint returns the right shape
        r = auth_admin.get('/api/students/latest')
        assert r.status_code == 200
        data = json.loads(r.data)
        assert 'students' in data
        assert 'upload' in data

    def test_seeded_student_appears_in_latest(self, auth_admin, seeded_upload):
        r = auth_admin.get('/api/students/latest')
        students = json.loads(r.data)['students']
        refs = [s['ref'] for s in students]
        assert seeded_upload['student_ref'] in refs

    def test_student_row_has_required_fields(self, auth_admin, seeded_upload):
        r = auth_admin.get('/api/students/latest')
        students = json.loads(r.data)['students']
        student = next(
            (s for s in students if s['ref'] == seeded_upload['student_ref']), None
        )
        assert student is not None
        for field in ('ref', 'name', 'pct', 'days_absent', 'status'):
            assert field in student, f"Missing field: {field}"

    def test_student_default_status_is_pending(self, auth_admin, seeded_upload):
        r = auth_admin.get('/api/students/latest')
        students = json.loads(r.data)['students']
        student = next(s for s in students if s['ref'] == seeded_upload['student_ref'])
        assert student['status'] == 'pending'

    def test_unauthenticated_denied(self, client):
        r = client.get('/api/students/latest', follow_redirects=False)
        assert r.status_code in (301, 302)


class TestStudentTrend:
    def test_unknown_student_returns_empty_trend(self, auth_admin):
        r = auth_admin.get('/api/trend/99999')
        assert r.status_code == 200
        data = json.loads(r.data)
        assert data['ref'] == 99999
        assert data['trend'] == []

    def test_seeded_student_has_trend_entry(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        r = auth_admin.get(f'/api/trend/{ref}')
        assert r.status_code == 200
        data = json.loads(r.data)
        assert data['ref'] == ref
        assert len(data['trend']) >= 1

    def test_trend_entry_has_required_fields(self, auth_admin, seeded_upload):
        ref = seeded_upload['student_ref']
        r = auth_admin.get(f'/api/trend/{ref}')
        entry = json.loads(r.data)['trend'][0]
        for field in ('pct', 'attended', 'absences', 'sessions', 'label', 'days_absent'):
            assert field in entry, f"Missing field: {field}"

    def test_unauthenticated_denied(self, client):
        r = client.get('/api/trend/1', follow_redirects=False)
        assert r.status_code in (301, 302)


class TestDepartedStudents:
    def test_mark_departed_succeeds_for_admin(self, auth_admin):
        r = auth_admin.post('/api/depart',
                            json={'student_ref': 55010,
                                  'student_name': 'Gone, Student',
                                  'form': 'ACACIA'})
        assert r.status_code == 200
        assert json.loads(r.data)['success'] is True

    def test_unmark_departed_succeeds(self, auth_admin):
        ref = 55011
        auth_admin.post('/api/depart',
                        json={'student_ref': ref,
                              'student_name': 'Gone, Then Back',
                              'form': 'ACACIA'})
        r = auth_admin.delete(f'/api/depart/{ref}')
        assert r.status_code == 200
        assert json.loads(r.data)['success'] is True

    def test_mark_departed_is_idempotent(self, auth_admin):
        ref = 55012
        payload = {'student_ref': ref, 'student_name': 'Dup, Mark', 'form': 'ACACIA'}
        r1 = auth_admin.post('/api/depart', json=payload)
        r2 = auth_admin.post('/api/depart', json=payload)
        assert r1.status_code == 200
        assert r2.status_code == 200

    def test_teacher_cannot_mark_departed(self, auth_teacher):
        r = auth_teacher.post('/api/depart',
                              json={'student_ref': 55013,
                                    'student_name': 'Blocked, Depart',
                                    'form': 'ACACIA'},
                              follow_redirects=False)
        assert r.status_code in (301, 302, 403)

    def test_permanent_delete_removes_all_records(self, auth_admin):
        ref = 55014
        # Seed case data for this ref
        auth_admin.post('/api/case/update',
                        json={'student_ref': ref, 'student_name': 'Del, Permanent',
                              'form': 'ACACIA', 'status': 'pending'})
        auth_admin.post(f'/api/caseplan/{ref}', json={'plan': {'goal': 'test'}})
        auth_admin.post('/api/depart',
                        json={'student_ref': ref,
                              'student_name': 'Del, Permanent',
                              'form': 'ACACIA'})
        r = auth_admin.delete(f'/api/depart/{ref}/permanent')
        assert r.status_code == 200
        # Case plan should now be gone
        r2 = auth_admin.get(f'/api/caseplan/{ref}')
        assert json.loads(r2.data)['plan'] is None
