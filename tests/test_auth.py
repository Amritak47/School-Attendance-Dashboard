"""
Tests for authentication: login, logout, and route access control.

Covers the login/logout routes and the @login_required / @admin_required
decorators applied throughout app.py.
"""


class TestLoginPage:
    def test_login_page_loads(self, client):
        r = client.get('/login')
        assert r.status_code == 200

    def test_unauthenticated_root_redirects_to_login(self, client):
        r = client.get('/', follow_redirects=False)
        assert r.status_code in (301, 302)
        assert '/login' in r.headers['Location']

    def test_valid_admin_credentials_redirect_away_from_login(self, client):
        r = client.post(
            '/login',
            data={'username': 'admin', 'password': 'admin123'},
            follow_redirects=False,
        )
        assert r.status_code in (301, 302)
        assert '/login' not in r.headers.get('Location', '')

    def test_wrong_password_stays_on_login_with_error(self, client):
        r = client.post(
            '/login',
            data={'username': 'admin', 'password': 'wrongpassword'},
            follow_redirects=True,
        )
        assert r.status_code == 200
        assert b'Incorrect' in r.data

    def test_nonexistent_user_shows_error(self, client):
        r = client.post(
            '/login',
            data={'username': 'nobody_here', 'password': 'x'},
            follow_redirects=True,
        )
        assert r.status_code == 200
        assert b'Incorrect' in r.data

    def test_authenticated_user_redirected_away_from_login(self, auth_admin):
        r = auth_admin.get('/login', follow_redirects=False)
        assert r.status_code in (301, 302)


class TestLogout:
    def test_logout_redirects_to_login(self, auth_admin):
        r = auth_admin.post('/logout', follow_redirects=False)
        assert r.status_code in (301, 302)
        assert '/login' in r.headers['Location']

    def test_protected_route_blocked_after_logout(self, flask_app):
        with flask_app.test_client() as c:
            c.post('/login', data={'username': 'admin', 'password': 'admin123'})
            c.post('/logout')
            r = c.get('/api/cases/all', follow_redirects=False)
            assert r.status_code in (301, 302)


class TestAccessControl:
    def test_api_cases_requires_login(self, client):
        r = client.get('/api/cases/all', follow_redirects=False)
        assert r.status_code in (301, 302)

    def test_api_uploads_requires_login(self, client):
        r = client.get('/api/uploads', follow_redirects=False)
        assert r.status_code in (301, 302)

    def test_api_students_latest_requires_login(self, client):
        r = client.get('/api/students/latest', follow_redirects=False)
        assert r.status_code in (301, 302)

    def test_admin_users_page_blocked_for_teacher(self, auth_teacher):
        r = auth_teacher.get('/admin/users', follow_redirects=False)
        assert r.status_code in (301, 302, 403)

    def test_admin_users_page_accessible_by_admin(self, auth_admin):
        r = auth_admin.get('/admin/users')
        assert r.status_code == 200

    def test_depart_endpoint_blocked_for_teacher(self, auth_teacher):
        r = auth_teacher.post(
            '/api/depart',
            json={'student_ref': 1, 'student_name': 'X', 'form': 'Y'},
            follow_redirects=False,
        )
        assert r.status_code in (301, 302, 403)
