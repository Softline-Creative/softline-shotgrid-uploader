import { useState, type FormEvent } from "react";
import { api, type User } from "../api";

export function Login({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [showOtp, setShowOtp] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { user } = await api.login(username, password, showOtp ? otp : undefined);
      onSignedIn(user);
    } catch (err) {
      const message = (err as Error).message;
      if (/two.?factor|2fa|auth_token|one.?time/i.test(message)) setShowOtp(true);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <h1>ShotGrid Uploader</h1>
        <p className="hint">Sign in with your ShotGrid login. Uploads are credited to you.</p>
        <label>Login or email
          <input autoFocus autoComplete="username" value={username}
            onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>Password
          <input type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} />
        </label>
        {showOtp && (
          <label>Two-factor code
            <input inputMode="numeric" autoComplete="one-time-code" value={otp}
              onChange={(e) => setOtp(e.target.value)} />
          </label>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy || !username || !password}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
        {!showOtp && (
          <button type="button" className="link" onClick={() => setShowOtp(true)}>
            I use a two-factor code
          </button>
        )}
      </form>
    </main>
  );
}
