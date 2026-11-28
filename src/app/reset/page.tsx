import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { PasswordInput } from "@/components/PasswordInput";
import { setPassword } from "@/lib/accounts";
import { PASSWORD_RULE, hashPassword, passwordOk } from "@/lib/passwords";
import { resetTokenUser, useResetToken } from "@/lib/security";

export const dynamic = "force-dynamic";
export const metadata = { title: "Choose a new password · Buzzbite" };

async function reset(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const userId = await resetTokenUser(token);
  if (!userId) redirect("/reset?error=link");
  if (!passwordOk(password)) redirect(`/reset?token=${encodeURIComponent(token)}&error=short`);
  if (!(await useResetToken(token))) redirect("/reset?error=link");
  // A new password ends every session, on every device.
  await setPassword(userId, await hashPassword(password));
  redirect("/login?reset=1");
}

export default async function Reset({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token = "", error } = await searchParams;
  const valid = token ? Boolean(await resetTokenUser(token)) : false;
  if (!valid) {
    return (
      <AuthShell title="This link has expired" lede="Reset links work once, for a short time." footer={<><Link href="/login">Back to sign in</Link></>}>
        <Link className="btn btn-ink" href="/forgot">Get a new link</Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Choose a new password" lede="You'll be signed out everywhere else.">
      <form action={reset}>
        <input type="hidden" name="token" value={token} />
        <label className="field" htmlFor="password">New password<span className="hint">{PASSWORD_RULE}</span>
          <PasswordInput id="password" name="password" autoComplete="new-password" minLength={10} required autoFocus />
        </label>
        {error === "short" && <p className="error" role="alert">Choose a longer password. {PASSWORD_RULE}</p>}
        <button className="btn btn-ink" type="submit">Save new password</button>
      </form>
    </AuthShell>
  );
}
