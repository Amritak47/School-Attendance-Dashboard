"""
Tests for the case management API.

Endpoints covered:
  GET  /api/cases/all
  POST /api/case/update
  GET  /api/case/<ref>
"""

import json


class TestGetAllCases:
    def test_returns_dict(self, auth_admin):
        r = auth_admin.get('/api/cases/all')
        assert r.status_code == 200
        data = json.loads(r.data)
        assert isinstance(data, dict)

    def test_unauthenticated_denied(self, client):
        r = client.get('/api/cases/all', follow_redirects=False)
        assert r.status_code in (301, 302)

    def test_created_case_appears_in_all_cases(self, auth_admin):
        ref = 8010
        auth_admin.post('/api/case/update',
                        json={'student_ref': ref, 'student_name': 'All, Cases',
                              'form': 'TESTFORM', 'status': 'contacted'})
        r = auth_admin.get('/api/cases/all')
        data = json.loads(r.data)
        assert str(ref) in data or ref in data


class TestUpdateCase:
    def test_creates_new_case_record(self, auth_admin):
        r = auth_admin.post('/api/case/update',
                            json={'student_ref': 8020,
                                  'student_name': 'Smith, John',
                                  'form': 'ACACIA',
                                  'status': 'contacted'})
        assert r.status_code == 200
        assert json.loads(r.data)['success'] is True

    def test_missing_student_ref_returns_400(self, auth_admin):
        r = auth_admin.post('/api/case/update', json={'status': 'contacted'})
        assert r.status_code == 400

    def test_status_update_persists(self, auth_admin):
        ref = 8021
        auth_admin.post('/api/case/update',
                        json={'student_ref': ref, 'student_name': 'Jones, Amy',
                              'form': 'BUSHBEES', 'status': 'pending'})
        auth_admin.post('/api/case/update',
                        json={'student_ref': ref, 'status': 'meeting'})
        r = auth_admin.get(f'/api/case/{ref}')
        assert json.loads(r.data)['case']['status'] == 'meeting'

    def test_notes_persist(self, auth_admin):
        ref = 8022
        note_text = 'Called parent — no answer.'
        auth_admin.post('/api/case/update',
                        json={'student_ref': ref, 'student_name': 'Brown, Lee',
                              'form': 'ACACIA', 'status': 'pending',
                              'notes': note_text})
        r = auth_admin.get(f'/api/case/{ref}')
        assert note_text in json.loads(r.data)['case']['notes']

    def test_notes_only_update_does_not_require_status(self, auth_admin):
        ref = 8023
        # First create with a status
        auth_admin.post('/api/case/update',
                        json={'student_ref': ref, 'student_name': 'Note, Only',
                              'form': 'ACACIA', 'status': 'contacted'})
        # Update notes only
        r = auth_admin.post('/api/case/update',
                            json={'student_ref': ref, 'notes': 'Follow-up booked.'})
        assert r.status_code == 200
        assert json.loads(r.data)['success'] is True

    def test_status_change_creates_history_entry(self, auth_admin):
        ref = 8024
        auth_admin.post('/api/case/update',
                        json={'student_ref': ref, 'student_name': 'History, Test',
                              'form': 'ACACIA', 'status': 'pending'})
        auth_admin.post('/api/case/update',
                        json={'student_ref': ref, 'status': 'referred'})
        r = auth_admin.get(f'/api/case/{ref}')
        history = json.loads(r.data)['history']
        assert any(h['new_status'] == 'referred' for h in history)

    def test_same_status_does_not_add_history_entry(self, auth_admin):
        ref = 8025
        auth_admin.post('/api/case/update',
                        json={'student_ref': ref, 'student_name': 'No, Dupe',
                              'form': 'ACACIA', 'status': 'pending'})
        r_before = auth_admin.get(f'/api/case/{ref}')
        count_before = len(json.loads(r_before.data)['history'])
        # Set same status again
        auth_admin.post('/api/case/update',
                        json={'student_ref': ref, 'status': 'pending'})
        r_after = auth_admin.get(f'/api/case/{ref}')
        count_after = len(json.loads(r_after.data)['history'])
        assert count_after == count_before


class TestGetCase:
    def test_unknown_ref_returns_empty(self, auth_admin):
        r = auth_admin.get('/api/case/99999')
        assert r.status_code == 200
        data = json.loads(r.data)
        assert data['case'] == {}
        assert data['history'] == []

    def test_returns_case_and_history_keys(self, auth_admin):
        ref = 8030
        auth_admin.post('/api/case/update',
                        json={'student_ref': ref, 'student_name': 'Keys, Test',
                              'form': 'TESTFORM', 'status': 'contacted'})
        r = auth_admin.get(f'/api/case/{ref}')
        assert r.status_code == 200
        data = json.loads(r.data)
        assert 'case' in data
        assert 'history' in data

    def test_unauthenticated_denied(self, client):
        r = client.get('/api/case/1', follow_redirects=False)
        assert r.status_code in (301, 302)
