"use client";

import { useActionState } from "react";
import { signIn } from "../actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState(signIn, undefined);
  return (
    <div className="panel" style={{ maxWidth: 420, margin: "40px auto" }}>
      <h1>Sign in</h1>
      <p className="sub">Demo operators: alpha.operator@demo.test and bravo.operator@demo.test. Each sees only their own organisation.</p>
      {state?.error && <div className="error">{state.error}</div>}
      <form action={action}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required defaultValue="alpha.operator@demo.test" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" required />
        </div>
        <button className="primary" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
