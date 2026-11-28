"use client";
import { useState } from "react";

/** A password field with a Show / Hide button. */
export function PasswordInput(props: { id: string; name: string; autoComplete: string; minLength?: number; required?: boolean; autoFocus?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="pw-wrap">
      <input {...props} type={shown ? "text" : "password"} />
      <button type="button" className="pw-toggle" onClick={() => setShown(!shown)} aria-pressed={shown} aria-label={shown ? "Hide password" : "Show password"}>{shown ? "Hide" : "Show"}</button>
    </span>
  );
}
