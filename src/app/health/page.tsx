import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/accounts";
import { emailConfigured } from "@/lib/email";
import { PLANS, type PlanId } from "@/lib/plans";
import { health } from "@/lib/system";
import { costliestPosts, costsThisMonth } from "@/lib/usage";
import { postingConfigured } from "@/lib/zernio";
import { ConnectWebhooks } from "./ConnectWebhooks";
import { TestEmail } from "./TestEmail";

export const dynamic = "force-dynamic";
export const metadata = { title: "System health · Buzzbite" };

const when = (d: string) => new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" });

/** Internal: what needs a look across every workspace. */
export default async function HealthPage() {
  const s = await getSession();
  if (s?.workspace.plan !== "internal") notFound();
  const [h, costs, posts] = await Promise.all([health(), costsThisMonth(), costliestPosts()]);
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const checks: [string, boolean, string][] = [
    ["Photos and video finish with no tab open", process.env.VERCEL_ENV === "production", "fal.ai calls the app back when a job finishes (production only)."],
    ["Daily safety check", Boolean(process.env.CRON_SECRET), "Set CRON_SECRET in Vercel. Vercel then runs the check every morning."],
    ["Auto-posting", postingConfigured(), "Set ZERNIO_API_KEY in Vercel."],
    ["Email (digests, failed posts, password resets)", emailConfigured(), "Set ZOHO_SEND_TOKEN and EMAIL_FROM in Vercel (or RESEND_API_KEY)."],
  ];
  return (
    <main className="wrap stack" style={{ paddingTop: 32, paddingBottom: 48 }}>
      <p className="small"><Link href="/">← Back to Buzzbite</Link></p>
      <div className="head"><div>
        <h1 className="title">System health</h1>
        <p className="sub">{h.openAlerts} open alerts · {h.failedMedia7d} failed generations in the last 7 days</p>
      </div></div>

      <section className="card stack">
        <h2 style={{ margin: 0, fontSize: 18 }}>Set-up</h2>
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
          {checks.map(([label, ok, fix]) => (
            <li key={label}><b>{ok ? "On" : "Off"}</b> · {label}{ok ? "" : <span className="muted">. {fix}</span>}</li>
          ))}
        </ul>
        {postingConfigured() && <ConnectWebhooks />}
        {emailConfigured() && <TestEmail />}
      </section>

      <section className="card stack" style={{ overflowX: "auto" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>AI cost this month</h2>
        <p className="small muted" style={{ margin: 0 }}>Claude costs come from token counts; photo, video and sound costs are estimates per job.</p>
        <table className="health"><thead><tr><th>Workspace</th><th>Plan</th><th>Posts</th><th>Claude</th><th>Photos, video, sound</th><th>Total</th><th>Per post</th><th>Plan price</th><th>Cost share</th></tr></thead><tbody>
          {costs.map((c) => {
            const price = PLANS[c.plan as PlanId]?.usd ?? null;
            return (
              <tr key={c.workspace_id}>
                <td>{c.workspace}</td><td>{PLANS[c.plan as PlanId]?.name ?? c.plan}</td><td>{c.posts}</td>
                <td>{usd(c.claude)}</td><td>{usd(c.fal)}</td><td><b>{usd(c.total)}</b></td>
                <td>{c.posts ? usd(c.total / c.posts) : "–"}</td><td>{price ? `$${price}` : "–"}</td>
                <td>{price ? `${Math.round((c.total / price) * 100)}%` : "–"}</td>
              </tr>
            );
          })}
        </tbody></table>
        {posts.length > 0 && (<>
          <h3 style={{ margin: "8px 0 0", fontSize: 15 }}>Most expensive posts (photos, video and sound)</h3>
          <table className="health"><thead><tr><th>Post</th><th>Brand</th><th>Jobs</th><th>Cost</th></tr></thead><tbody>
            {posts.map((p) => <tr key={p.id}><td>{p.title}</td><td>{p.brand}</td><td>{p.jobs}</td><td>{usd(p.cost)}</td></tr>)}
          </tbody></table>
        </>)}
      </section>

      <section className="card stack" style={{ overflowX: "auto" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Stuck making photos or video (over an hour)</h2>
        {h.stuck.length === 0 ? <p className="muted" style={{ margin: 0 }}>None.</p> : (
          <table className="health"><thead><tr><th>Post</th><th>Brand</th><th>Workspace</th><th>Since</th></tr></thead><tbody>
            {h.stuck.map((p) => <tr key={p.id}><td>{p.title}</td><td>{p.brand}</td><td>{p.workspace}</td><td>{when(p.since)}</td></tr>)}
          </tbody></table>
        )}
      </section>

      <section className="card stack" style={{ overflowX: "auto" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Scheduled posts past their date</h2>
        {h.overdue.length === 0 ? <p className="muted" style={{ margin: 0 }}>None.</p> : (
          <table className="health"><thead><tr><th>Post</th><th>Brand</th><th>Workspace</th><th>Date</th><th>State</th></tr></thead><tbody>
            {h.overdue.map((p) => <tr key={p.id}><td>{p.title}</td><td>{p.brand}</td><td>{p.workspace}</td><td>{p.publish_on}</td><td>{p.state}</td></tr>)}
          </tbody></table>
        )}
      </section>
    </main>
  );
}
