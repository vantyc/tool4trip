// tool4trip-auth: session gate for https://tool4trip.com/ (Traefik ForwardAuth).
// Serves a self-contained login form; does not serve the PWA.
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	cookieName  = "tool4trip_session"
	// Legacy cookie from /travel/ era — cleared on logout; not accepted for auth.
	legacyCookieName = "viajes_session"
	cookiePath       = "/"
	sessionTTL       = 30 * 24 * time.Hour
	realmLogin       = "/login"
	appHome          = "/"
	defaultAddr      = ":8080"
)

//go:embed login.html
var loginHTML string

type config struct {
	addr         string
	username     string
	passwordHash []byte
	sessionKey   []byte
}

type sessionPayload struct {
	U string `json:"u"`
	E int64  `json:"e"`
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /_auth/verify", cfg.handleVerify)
	mux.HandleFunc("GET /login", cfg.handleLoginGet)
	mux.HandleFunc("POST /api/login", cfg.handleLoginPost)
	mux.HandleFunc("POST /api/logout", cfg.handleLogout)
	mux.HandleFunc("GET /logout", cfg.handleLogout)
	// Temporary aliases during cutover from /travel/* paths.
	mux.HandleFunc("GET /travel/login", cfg.handleLoginGet)
	mux.HandleFunc("POST /travel/api/login", cfg.handleLoginPost)
	mux.HandleFunc("GET /travel/logout", cfg.handleLogout)
	mux.HandleFunc("POST /travel/api/logout", cfg.handleLogout)

	log.Printf("tool4trip-auth listening on %s", cfg.addr)
	if err := http.ListenAndServe(cfg.addr, mux); err != nil {
		log.Fatal(err)
	}
}

func loadConfig() (*config, error) {
	user := strings.TrimSpace(os.Getenv("AUTH_USERNAME"))
	hash := strings.TrimSpace(os.Getenv("AUTH_PASSWORD_HASH"))
	secret := strings.TrimSpace(os.Getenv("SESSION_SECRET"))
	addr := strings.TrimSpace(os.Getenv("LISTEN_ADDR"))
	if addr == "" {
		addr = defaultAddr
	}
	if user == "" {
		return nil, fmt.Errorf("AUTH_USERNAME is required")
	}
	if hash == "" {
		return nil, fmt.Errorf("AUTH_PASSWORD_HASH is required")
	}
	hash = strings.Replace(hash, "$2y$", "$2a$", 1)
	if secret == "" {
		return nil, fmt.Errorf("SESSION_SECRET is required")
	}
	if len(secret) < 32 {
		return nil, fmt.Errorf("SESSION_SECRET must be at least 32 bytes")
	}
	return &config{
		addr:         addr,
		username:     user,
		passwordHash: []byte(hash),
		sessionKey:   []byte(secret),
	}, nil
}

func handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}

func (c *config) handleLoginGet(w http.ResponseWriter, r *http.Request) {
	if _, ok := c.sessionFromRequest(r); ok {
		http.Redirect(w, r, appHome, http.StatusFound)
		return
	}
	c.writeLogin(w, http.StatusOK, "", "")
}

func (c *config) handleLoginPost(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		c.writeLogin(w, http.StatusBadRequest, "", "Solicitud inválida.")
		return
	}
	username := strings.TrimSpace(r.FormValue("username"))
	password := r.FormValue("password")

	userOK := subtle.ConstantTimeCompare([]byte(username), []byte(c.username)) == 1
	passOK := bcrypt.CompareHashAndPassword(c.passwordHash, []byte(password)) == nil
	if !userOK || !passOK {
		time.Sleep(200 * time.Millisecond)
		c.writeLogin(w, http.StatusUnauthorized, username, "Usuario o contraseña incorrectos.")
		return
	}

	token, err := c.mintSession(username, time.Now().UTC().Add(sessionTTL))
	if err != nil {
		log.Printf("mint session: %v", err)
		c.writeLogin(w, http.StatusInternalServerError, username, "No se pudo crear la sesión.")
		return
	}
	http.SetCookie(w, sessionCookie(token, int(sessionTTL.Seconds())))
	// Clear legacy Path=/travel cookie if present.
	http.SetCookie(w, clearCookie(legacyCookieName, "/travel"))
	http.Redirect(w, r, appHome, http.StatusFound)
}

func (c *config) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, clearCookie(cookieName, cookiePath))
	http.SetCookie(w, clearCookie(legacyCookieName, "/travel"))
	http.SetCookie(w, clearCookie(legacyCookieName, "/"))
	http.Redirect(w, r, realmLogin, http.StatusFound)
}

func sessionCookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     cookieName,
		Value:    value,
		Path:     cookiePath,
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	}
}

func clearCookie(name, path string) *http.Cookie {
	return &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     path,
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	}
}

func (c *config) handleVerify(w http.ResponseWriter, r *http.Request) {
	if sess, ok := c.sessionFromRequest(r); ok {
		w.Header().Set("X-Viajes-User", sess.U)
		w.WriteHeader(http.StatusOK)
		return
	}

	forwardedURI := r.Header.Get("X-Forwarded-Uri")
	forwardedMethod := r.Header.Get("X-Forwarded-Method")
	if forwardedMethod == "" {
		forwardedMethod = r.Method
	}
	if shouldRedirectToLogin(forwardedMethod, forwardedURI) {
		w.Header().Set("Location", publicLoginURL(r))
		w.WriteHeader(http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte("unauthorized\n"))
}

func publicLoginURL(r *http.Request) string {
	proto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
	host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if proto == "" {
		proto = "https"
	}
	if host != "" {
		return proto + "://" + host + realmLogin
	}
	return realmLogin
}

func shouldRedirectToLogin(method, uri string) bool {
	if method != http.MethodGet && method != http.MethodHead {
		return false
	}
	lower := strings.ToLower(uri)
	switch {
	case strings.HasPrefix(lower, "/api/"):
		return false
	case strings.HasPrefix(lower, "/assets/"):
		return false
	case strings.HasSuffix(lower, ".js"),
		strings.HasSuffix(lower, ".css"),
		strings.HasSuffix(lower, ".png"),
		strings.HasSuffix(lower, ".svg"),
		strings.HasSuffix(lower, ".ico"),
		strings.HasSuffix(lower, ".webmanifest"),
		strings.HasSuffix(lower, ".woff"),
		strings.HasSuffix(lower, ".woff2"):
		return false
	}
	return true
}

func (c *config) writeLogin(w http.ResponseWriter, status int, username, errMsg string) {
	page := loginHTML
	if errMsg != "" {
		page = strings.Replace(page, "{{ERROR}}",
			`<p class="error" role="alert">`+html.EscapeString(errMsg)+`</p>`, 1)
	} else {
		page = strings.Replace(page, "{{ERROR}}", "", 1)
	}
	page = strings.Replace(page, "{{USERNAME}}", html.EscapeString(username), 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(page))
}

func (c *config) mintSession(username string, exp time.Time) (string, error) {
	payload := sessionPayload{U: username, E: exp.Unix()}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, c.sessionKey)
	_, _ = mac.Write([]byte(body))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return body + "." + sig, nil
}

func (c *config) sessionFromRequest(r *http.Request) (*sessionPayload, bool) {
	cookie, err := r.Cookie(cookieName)
	if err != nil || cookie.Value == "" {
		return nil, false
	}
	return c.parseSession(cookie.Value)
}

func (c *config) parseSession(token string) (*sessionPayload, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return nil, false
	}
	body, sig := parts[0], parts[1]
	mac := hmac.New(sha256.New, c.sessionKey)
	_, _ = mac.Write([]byte(body))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(sig), []byte(expected)) != 1 {
		return nil, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return nil, false
	}
	var payload sessionPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, false
	}
	if payload.U == "" || payload.E == 0 {
		return nil, false
	}
	if time.Now().UTC().Unix() > payload.E {
		return nil, false
	}
	if subtle.ConstantTimeCompare([]byte(payload.U), []byte(c.username)) != 1 {
		return nil, false
	}
	return &payload, true
}
