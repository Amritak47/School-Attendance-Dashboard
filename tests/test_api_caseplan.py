"""
Tests for the Case Management Plan endpoints.

Endpoints covered:
  GET  /api/caseplan/<ref>
  POST /api/caseplan/<ref>

The case plan stores the entire form as a JSON blob — so tests verify
that arbitrary plan structures round-trip correctly through the API.
"""

import json


class TestGetCasePlan:
    def test_returns_null_for_student_with_no_plan(self, auth_admin):
        r = auth_admin.get('/api/caseplan/77001')
        assert r.status_code == 200
        assert json.loads(r.data)['plan'] is None

    def test_unauthenticated_denied(self, client):
        r = client.get('/api/caseplan/77001', follow_redirects=False)
        assert r.status_code in (301, 302)


class TestSaveCasePlan:
    def test_save_returns_success(self, auth_admin):
        r = auth_admin.post('/api/caseplan/77010',
                            json={'plan': {'goal': 'Attend 4 days/week'}})
        assert r.status_code == 200
        assert json.loads(r.data)['success'] is True

    def test_saved_plan_is_retrievable(self, auth_admin):
        ref = 77011
        plan = {'name': 'Smith, Jane', 'year': 'Year 3', 'goal': 'Attend 4 days/week'}
        auth_admin.post(f'/api/caseplan/{ref}', json={'plan': plan})
        r = auth_admin.get(f'/api/caseplan/{ref}')
        saved = json.loads(r.data)['plan']
        assert saved['goal'] == 'Attend 4 days/week'
        assert saved['name'] == 'Smith, Jane'

    def test_second_save_overwrites_first(self, auth_admin):
        ref = 77012
        auth_admin.post(f'/api/caseplan/{ref}', json={'plan': {'goal': 'original'}})
        auth_admin.post(f'/api/caseplan/{ref}', json={'plan': {'goal': 'updated'}})
        r = auth_admin.get(f'/api/caseplan/{ref}')
        assert json.loads(r.data)['plan']['goal'] == 'updated'

    def test_empty_plan_saves_successfully(self, auth_admin):
        r = auth_admin.post('/api/caseplan/77013', json={'plan': {}})
        assert r.status_code == 200

    def test_plan_with_all_standard_fields(self, auth_admin):
        ref = 77014
        full_plan = {
            'name':       'Jones, Tommy',
            'year':       'Year 2',
            'form':       'CATERPILLARS',
            'goal':       '3 days/week',
            'gender':     'Male',
            'atsi':       'Yes',
            'disability': 'No',
            'eald':       'N/A',
            'strengths':  'Loves art and sport',
            'barriers':   'Transport issues',
            'strategies': 'Morning phone call to parent',
            'rewards':    'Sticker chart',
        }
        auth_admin.post(f'/api/caseplan/{ref}', json={'plan': full_plan})
        r = auth_admin.get(f'/api/caseplan/{ref}')
        saved = json.loads(r.data)['plan']
        assert saved['strengths'] == 'Loves art and sport'
        assert saved['atsi'] == 'Yes'
        assert saved['barriers'] == 'Transport issues'

    def test_plan_preserves_unicode_text(self, auth_admin):
        ref = 77015
        plan = {'notes': 'Wäre schön — student improving 🎉'}
        auth_admin.post(f'/api/caseplan/{ref}', json={'plan': plan})
        r = auth_admin.get(f'/api/caseplan/{ref}')
        assert json.loads(r.data)['plan']['notes'] == plan['notes']

    def test_unauthenticated_cannot_save(self, client):
        r = client.post('/api/caseplan/77020',
                        json={'plan': {'goal': 'test'}},
                        follow_redirects=False)
        assert r.status_code in (301, 302)
