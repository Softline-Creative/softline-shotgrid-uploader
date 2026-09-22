import { useState } from "react";

/** Why the last sign-in failed, handed back by /api/auth/callback. */
function takeAuthError(): string {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("auth_error") ?? "";
  if (error) window.history.replaceState(null, "", window.location.pathname);
  return error;
}

export function Login() {
  const [error] = useState(takeAuthError);

  return (
    <main className="login">
      <div className="card login-card">
        <h1>ShotGrid Uploader</h1>
        <p className="hint">Sign in with your Softline Google account. Uploads are credited
          to your ShotGrid user.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <a className="button primary" href="/api/auth/google">Sign in with Google</a>
      </div>
    </main>
  );
}
