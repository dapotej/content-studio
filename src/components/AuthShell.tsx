import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The sign-in, sign-up and password pages: Buzzbite's story on the left (a slim header on phones),
 * the form on the right.
 */
export function AuthShell({ title, lede, children, footer }: { title: string; lede?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-art" aria-label="Buzzbite">
        <a href="https://buzzbite.io" className="auth-logo"><img src="/brand/wordmark-white.png" alt="Buzzbite" width={150} height={30} /></a>
        <div className="auth-pitch">
          <h2>Your social media. <mark>Taken care of.</mark></h2>
          <ol className="auth-steps">
            <li><b>1</b><span><strong>We learn your brand</strong>From your website: colours, voice, what you sell.</span></li>
            <li><b>2</b><span><strong>We make the month</strong>Photos, videos, carousels and captions, planned around what&rsquo;s happening.</span></li>
            <li><b>3</b><span><strong>You approve, we post</strong>A few minutes a week. Instagram and LinkedIn, on time.</span></li>
          </ol>
        </div>
        <div className="auth-stack" aria-hidden="true">
          <div className="auth-card c1"><span>Tip</span><p>Post less. Say <i>more</i>.</p></div>
          <div className="auth-card c2"><span>✓ Posted</span><p>Your week is <i>ready</i>.</p></div>
          <div className="auth-card c3"><span>Reel</span><p>Behind the <i>scenes</i></p></div>
        </div>
      </aside>
      <main className="auth-main" id="main">
        <div className="auth-form">
          <h1>{title}</h1>
          {lede && <p className="auth-lede">{lede}</p>}
          {children}
          {footer && <div className="auth-foot">{footer}</div>}
        </div>
        <p className="auth-legal small muted">© {new Date().getFullYear()} Buzzbite · <Link href="https://buzzbite.io">buzzbite.io</Link></p>
      </main>
    </div>
  );
}
