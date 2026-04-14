"""
Tests for admin user management routes.

Endpoints covered:
  GET  /admin/users
  POST /admin/users/create
  POST /admin/users/<id>/reset-password
  POST /admin/users/<id>/toggle
  POST /admin/users/<id>/delete
"""

import app as _app


def _get_user(username):
    """Helper: fetch a user row by username directly from the test DB."""
    db = _app.get_db()
    row = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    db.close()
    return dict(row) if row else None


class TestAdminUsersPage:
    def test_admin_can_view_users_page(self, auth_admin):
        r = auth_admin.get('/admin/users')
        assert r.status_code == 200

    def test_teacher_cannot_view_users_page(self, auth_teacher):
        r = auth_teacher.get('/admin/users', follow_redirects=False)
        assert r.status_code in (301, 302, 403)

    def test_unauthenticated_cannot_view_users_page(self, client):
        r = client.get('/admin/users', follow_redirects=False)
        assert r.status_code in (301, 302)


class TestCreateUser:
    def test_admin_creates_teacher_account(self, auth_admin):
        r = auth_admin.post('/admin/users/create',
                            data={'username': 'newteacher',
                                  'display_name': 'New Teacher',
                                  'password': 'pass1234',
                                  'role': 'teacher'},
                            follow_redirects=True)
        assert r.status_code == 200
        assert _get_user('newteacher') is not None

    def test_created_user_can_login(self, flask_app, auth_admin):
        auth_admin.post('/admin/users/create',
                        data={'username': 'logintest',
                              'display_name': 'Login Test',
                              'password': 'secret99',
                              'role': 'teacher'},
                        follow_redirects=True)
        with flask_app.test_client() as c:
            r = c.post('/login',
                       data={'username': 'logintest', 'password': 'secret99'},
                       follow_redirects=False)
            assert r.status_code in (301, 302)
            assert '/login' not in r.headers.get('Location', '')

    def test_duplicate_username_rejected(self, auth_admin):
        data = {'username': 'dupuser99', 'display_name': 'Dup',
                'password': 'pass1234', 'role': 'teacher'}
        auth_admin.post('/admin/users/create', data=data, follow_redirects=True)
        r = auth_admin.post('/admin/users/create', data=data, follow_redirects=True)
        assert b'already taken' in r.data

    def test_short_password_rejected(self, auth_admin):
        r = auth_admin.post('/admin/users/create',
                            data={'username': 'shortpw99',
                                  'display_name': 'Short PW',
                                  'password': 'abc',
                                  'role': 'teacher'},
                            follow_redirects=True)
        assert b'6 characters' in r.data

    def test_invalid_role_rejected(self, auth_admin):
        r = auth_admin.post('/admin/users/create',
                            data={'username': 'badrole99',
                                  'display_name': 'Bad Role',
                                  'password': 'pass1234',
                                  'role': 'superuser'},
                            follow_redirects=True)
        assert b'Invalid role' in r.data

    def test_missing_fields_rejected(self, auth_admin):
        r = auth_admin.post('/admin/users/create',
                            data={'username': '', 'display_name': '',
                                  'password': '', 'role': 'teacher'},
                            follow_redirects=True)
        assert b'required' in r.data

    def test_teacher_cannot_create_user(self, auth_teacher):
        r = auth_teacher.post('/admin/users/create',
                              data={'username': 'blocked99',
                                    'display_name': 'Blocked',
                                    'password': 'pass1234',
                                    'role': 'teacher'},
                              follow_redirects=False)
        assert r.status_code in (301, 302, 403)


class TestToggleUser:
    def test_admin_can_disable_and_enable_user(self, auth_admin):
        auth_admin.post('/admin/users/create',
                        data={'username': 'toggleuser',
                              'display_name': 'Toggle Me',
                              'password': 'pass1234',
                              'role': 'teacher'},
                        follow_redirects=True)
        user = _get_user('toggleuser')
        assert user is not None
        # Toggle (disable)
        r = auth_admin.post(f'/admin/users/{user["id"]}/toggle',
                            follow_redirects=True)
        assert r.status_code == 200
        # Toggle again (re-enable)
        r2 = auth_admin.post(f'/admin/users/{user["id"]}/toggle',
                             follow_redirects=True)
        assert r2.status_code == 200


class TestDeleteUser:
    def test_admin_can_delete_non_admin_user(self, auth_admin):
        auth_admin.post('/admin/users/create',
                        data={'username': 'deleteuser',
                              'display_name': 'Delete Me',
                              'password': 'pass1234',
                              'role': 'teacher'},
                        follow_redirects=True)
        user = _get_user('deleteuser')
        assert user is not None
        r = auth_admin.post(f'/admin/users/{user["id"]}/delete',
                            follow_redirects=True)
        assert r.status_code == 200
