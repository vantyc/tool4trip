package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func testConfig(t *testing.T) *config {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte("s3cret"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	return &config{
		username:     "travel",
		passwordHash: hash,
		sessionKey:   []byte("0123456789abcdef0123456789abcdef"),
	}
}

func TestMintAndParseSession(t *testing.T) {
	c := testConfig(t)
	tok, err := c.mintSession("travel", time.Now().UTC().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	sess, ok := c.parseSession(tok)
	if !ok || sess.U != "travel" {
		t.Fatalf("expected valid travel session, got ok=%v sess=%v", ok, sess)
	}
}

func TestExpiredSessionRejected(t *testing.T) {
	c := testConfig(t)
	tok, err := c.mintSession("travel", time.Now().UTC().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := c.parseSession(tok); ok {
		t.Fatal("expired token should be rejected")
	}
}

func TestTamperedSessionRejected(t *testing.T) {
	c := testConfig(t)
	tok, err := c.mintSession("travel", time.Now().UTC().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(tok, ".")
	bad := parts[0] + ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	if _, ok := c.parseSession(bad); ok {
		t.Fatal("tampered token should be rejected")
	}
}

func TestLoginSetsCookie(t *testing.T) {
	c := testConfig(t)
	req := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader("username=travel&password=s3cret"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	c.handleLoginPost(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); loc != "/" {
		t.Fatalf("location=%s", loc)
	}
	found := false
	for _, ck := range rec.Result().Cookies() {
		if ck.Name == cookieName {
			found = true
			if !ck.HttpOnly || !ck.Secure || ck.Path != "/" || ck.SameSite != http.SameSiteStrictMode {
				t.Fatalf("cookie flags incorrect: %+v", ck)
			}
			if _, ok := c.parseSession(ck.Value); !ok {
				t.Fatal("cookie value not a valid session")
			}
		}
	}
	if !found {
		t.Fatal("missing session cookie")
	}
}

func TestVerifyRedirectsHTML(t *testing.T) {
	c := testConfig(t)
	req := httptest.NewRequest(http.MethodGet, "/_auth/verify", nil)
	req.Header.Set("X-Forwarded-Method", "GET")
	req.Header.Set("X-Forwarded-Uri", "/")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "tool4trip.com")
	req.Header.Set("Accept", "text/html")
	rec := httptest.NewRecorder()
	c.handleVerify(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("status=%d", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "https://tool4trip.com/login" {
		t.Fatalf("location=%s", loc)
	}
}

func TestVerifyOKWithCookie(t *testing.T) {
	c := testConfig(t)
	tok, err := c.mintSession("travel", time.Now().UTC().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/_auth/verify", nil)
	req.AddCookie(&http.Cookie{Name: cookieName, Value: tok})
	rec := httptest.NewRecorder()
	c.handleVerify(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
}

func TestBadPassword(t *testing.T) {
	c := testConfig(t)
	req := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader("username=travel&password=wrong"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	c.handleLoginPost(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", rec.Code)
	}
}

func TestApiPathNoHtmlRedirect(t *testing.T) {
	if shouldRedirectToLogin(http.MethodGet, "/api/agent/ask") {
		t.Fatal("API paths should not HTML-redirect")
	}
}

func guestConfig(t *testing.T) *config {
	t.Helper()
	c := testConfig(t)
	hash, err := bcrypt.GenerateFromPassword([]byte("invitada"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	c.guestUsername = "nane"
	c.guestPasswordHash = hash
	return c
}

func verifyAs(c *config, user, method, uri string) *httptest.ResponseRecorder {
	tok, _ := c.mintSession(user, time.Now().UTC().Add(time.Hour))
	req := httptest.NewRequest(http.MethodGet, "/_auth/verify", nil)
	req.AddCookie(&http.Cookie{Name: cookieName, Value: tok})
	req.Header.Set("X-Forwarded-Method", method)
	req.Header.Set("X-Forwarded-Uri", uri)
	rec := httptest.NewRecorder()
	c.handleVerify(rec, req)
	return rec
}

func TestGuestLogin(t *testing.T) {
	c := guestConfig(t)
	if !c.authenticate("nane", "invitada") {
		t.Fatal("guest should log in")
	}
	if c.authenticate("nane", "s3cret") || c.authenticate("travel", "invitada") {
		t.Fatal("passwords must not cross accounts")
	}
	if !c.authenticate("travel", "s3cret") {
		t.Fatal("owner must still log in")
	}
}

func TestGuestReadsOnly(t *testing.T) {
	c := guestConfig(t)
	rec := verifyAs(c, "nane", "GET", "/api/trips/filipinas-nov-2026")
	if rec.Code != http.StatusOK || rec.Header().Get("X-Viajes-User") != "nane" {
		t.Fatalf("guest read: status=%d user=%q", rec.Code, rec.Header().Get("X-Viajes-User"))
	}
	for _, m := range []string{"PUT", "POST", "PATCH", "DELETE"} {
		if rec := verifyAs(c, "nane", m, "/api/trips/filipinas-nov-2026"); rec.Code != http.StatusForbidden {
			t.Fatalf("guest %s: status=%d", m, rec.Code)
		}
	}
	for _, uri := range []string{"/api/agent", "/api/agent/ask", "/API/Agent/jobs?x=1"} {
		if rec := verifyAs(c, "nane", "GET", uri); rec.Code != http.StatusForbidden {
			t.Fatalf("guest agent %s: status=%d", uri, rec.Code)
		}
	}
	if rec := verifyAs(c, "travel", "PUT", "/api/trips/filipinas-nov-2026"); rec.Code != http.StatusOK {
		t.Fatalf("owner write: status=%d", rec.Code)
	}
}

func TestGuestSessionDiesWhenGuestRemoved(t *testing.T) {
	c := guestConfig(t)
	tok, _ := c.mintSession("nane", time.Now().UTC().Add(time.Hour))
	c.guestUsername = ""
	if _, ok := c.parseSession(tok); ok {
		t.Fatal("guest session must stop working once the guest is removed")
	}
}
