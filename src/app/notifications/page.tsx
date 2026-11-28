import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/accounts";
import { emailConfigured } from "@/lib/email";
import { listNotes, markAllRead, type NoteKind } from "@/lib/notify";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notifications · Buzzbite" };

const ICON: Record<NoteKind, string> = { posted: "✓", failed: "!", review: "✎", gap: "⏰" };
const when = (d: string) => new Date(d).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" });

/** What happened while you were away: posts that went out or failed, posts to review, empty days ahead. */
export default async function Notifications() {
  const s = await getSession();
  if (!s) redirect("/login?next=/notifications");
  const notes = await listNotes(s.workspace.id);
  await markAllRead(s.workspace.id); // seen now; the ones that were new keep their highlight on this visit
  return (
    <main className="wrap stack" style={{ maxWidth: 720, paddingTop: 24, paddingBottom: 64, paddingInline: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 className="title">Notifications</h1>
        <Link className="btn btn-ghost" href="/">← Back</Link>
      </div>
      <p className="sub" style={{ marginTop: 0 }}>
        Posts that went out or failed, posts waiting for you, and posting days with nothing approved.
        {emailConfigured() ? " Anything you haven't seen is also emailed to you once a day." : ""}
      </p>
      {notes.length === 0 ? (
        <div className="empty"><strong>Nothing yet</strong>You&rsquo;ll see posts going out, posts to review and gaps in your calendar here.</div>
      ) : (
        <ul className="notes">
          {notes.map((n) => {
            const inner = (
              <>
                <span className="note-icon" aria-hidden="true">{ICON[n.kind]}</span>
                <span>
                  <strong>{n.brand_name ? `${n.brand_name}: ` : ""}{n.title}</strong>
                  {n.body && <p>{n.body}</p>}
                  <time dateTime={n.created_at}>{when(n.created_at)}</time>
                </span>
              </>
            );
            const cls = `note note-${n.kind}${n.read_at ? "" : " unread"}`;
            return (
              <li key={n.id}>
                {n.link ? (n.link.startsWith("http")
                  ? <a className={cls} href={n.link} target="_blank" rel="noreferrer">{inner}</a>
                  : <Link className={cls} href={n.link}>{inner}</Link>)
                  : <div className={cls}>{inner}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
