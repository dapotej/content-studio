import Link from "next/link";
import { Wordmark } from "./Logo";
import { inkOn } from "@/templates/PostCanvas";
import type { Brand } from "@/lib/types";
import { getSession } from "@/lib/accounts";
import { blockedReason } from "@/lib/limits";
import { unreadCount } from "@/lib/notify";

type Section = "calendar" | "review" | "results" | "trends" | "media" | "kit";

const ICONS: Record<Section, React.ReactNode> = {
  calendar: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>,
  review: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 12l5 5L20 6" /></svg>,
  results: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>,
  trends: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 17l5-5 4 4 8-8" /><path d="M14 8h6v6" /></svg>,
  media: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>,
  kit: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /></svg>,
};

const TAB_LABELS: Partial<Record<Section, string>> = { review: "Review", results: "Results", trends: "Trends", media: "Media", kit: "Brand" };

export function BrandDot({ brand }: { brand: Brand }) {
  const c = brand.profile.colors.primary;
  return <span className="bdot" style={{ background: c, color: inkOn(c, "#111") }}>{brand.name.slice(0, 1).toUpperCase()}</span>;
}

export async function Shell({ brand, brands, current, reviewCount, children }: {
  brand: Brand; brands: Brand[]; current: Section; reviewCount: number; children: React.ReactNode;
}) {
  const session = await getSession();
  const internal = session?.workspace.plan === "internal";
  const unread = session ? await unreadCount(session.workspace.id).catch(() => 0) : 0;
  const blocked = session ? blockedReason(session) : null;
  const trialDays = session?.workspace.plan === "trial" && session.workspace.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(session.workspace.trial_ends_at).getTime() - Date.now()) / 86400_000)) : null;
  const links: [Section, string, string][] = [
    ["calendar", `/b/${brand.id}`, "Calendar"],
    ["review", `/b/${brand.id}/review`, "To review"],
    ["results", `/b/${brand.id}/results`, "Results"],
    ["trends", `/b/${brand.id}/trends`, "Trend radar"],
    ["media", `/b/${brand.id}/media`, "Photos & video"],
    ["kit", `/b/${brand.id}/kit`, "Brand kit"],
  ];
  return (
    <div className="app">
      <aside className="side" aria-label="Buzzbite">
        <div className="side-head">
          <Link href="/" className="logo"><Wordmark height={22} /></Link>
          <Link href="/notifications" className="bell" aria-label={unread ? `Notifications, ${unread} new` : "Notifications"}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
            {unread > 0 && <span className="bell-count">{unread > 9 ? "9+" : unread}</span>}
          </Link>
        </div>
        <details className="brand-pick">
          <summary><BrandDot brand={brand} /><span>{brand.name}<small>LinkedIn · Instagram</small></span></summary>
          <div className="menu">
            {brands.filter((b) => b.id !== brand.id).map((b) => <Link key={b.id} href={`/b/${b.id}`}><BrandDot brand={b} />{b.name}</Link>)}
            <Link href="/setup"><span className="bdot" style={{ background: "var(--sunk)" }}>+</span>Add a brand</Link>
            <div className="menu-extra">
              <a href="/settings">Settings</a>
              {internal && <a href="/leads">Website sign-ups</a>}
              {internal && <a href="/health">System health</a>}
              <a href="/logout">Sign out</a>
            </div>
          </div>
        </details>
        <nav className="nav" aria-label="Sections">
          {links.map(([key, href, label]) => (
            <Link key={key} href={href} aria-current={key === current ? "page" : undefined}>
              {ICONS[key]}{label}
              {key === "review" && reviewCount > 0 && <span className="count">{reviewCount}</span>}
            </Link>
          ))}
        </nav>
        <div className="side-foot">
          <span>Posts on {brand.settings.days.map((d) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d]).join(", ")} at {brand.settings.time}.</span>
          <a href="/settings">Settings{session ? ` · ${session.user.name || session.user.email}` : ""}</a>
          {internal && <a href="/leads">Website sign-ups</a>}
          {internal && <a href="/health">System health</a>}
          <a href="/logout">Sign out</a>
        </div>
      </aside>
      <main className="main" id="main">
        {blocked ? (
          <p className="plan-note warn" role="status">{blocked} <a href="/settings#billing">Choose a plan</a></p>
        ) : trialDays !== null && trialDays <= 7 ? (
          <p className="plan-note" role="status">Free trial: {trialDays} day{trialDays === 1 ? "" : "s"} left. <a href="/settings#billing">Choose a plan</a></p>
        ) : null}
        {children}
      </main>
      {/* Phones: the sections as a tab bar at the bottom of the screen. */}
      <nav className="tabs" aria-label="Sections">
        {links.map(([key, href, label]) => (
          <Link key={key} href={href} aria-current={key === current ? "page" : undefined}>
            <span className="tab-icon">{ICONS[key]}{key === "review" && reviewCount > 0 && <span className="tab-count">{reviewCount}</span>}</span>
            {TAB_LABELS[key] ?? label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
