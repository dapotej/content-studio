// Plans and their monthly limits. Prices are shown on the billing page; the amounts
// charged come from the Stripe prices and Paystack plans set in the environment.
export type PlanId = "internal" | "free" | "trial" | "starter" | "growth" | "agency";
export type PaidPlanId = "starter" | "growth" | "agency";
export type PlanStatus = "trialing" | "active" | "past_due" | "canceled";

export type Plan = {
  name: string;
  /** Monthly price in US dollars and naira; null for plans that are not sold. */
  usd: number | null;
  ngn: number | null;
  brands: number;
  posts: number;   // new posts created per calendar month, across the workspace
  videos: number;  // AI video clips per calendar month
  blurb: string;
  features: string[];
};

const UNLIMITED = 1_000_000;

export const PLANS: Record<PlanId, Plan> = {
  internal: { name: "Internal", usd: null, ngn: null, brands: UNLIMITED, posts: UNLIMITED, videos: UNLIMITED, blurb: "Buzzbite's own workspace.", features: [] },
  free: { name: "Complimentary", usd: null, ngn: null, brands: UNLIMITED, posts: UNLIMITED, videos: UNLIMITED, blurb: "No limits, never billed.", features: [] },
  trial: { name: "Free trial", usd: null, ngn: null, brands: 1, posts: 12, videos: 4, blurb: "14 days to try Buzzbite with one brand.", features: [] },
  starter: {
    name: "Starter", usd: 49, ngn: 35_000, brands: 1, posts: 12, videos: 4,
    blurb: "For a business that posts a few times a week.",
    features: ["1 brand", "12 posts a month", "4 videos a month", "Instagram and LinkedIn", "Photos, graphics and carousels"],
  },
  growth: {
    name: "Growth", usd: 99, ngn: 75_000, brands: 1, posts: 30, videos: 12,
    blurb: "Daily posting, with more video.",
    features: ["1 brand", "30 posts a month", "12 videos a month", "Every platform as it's added", "Weekly trend ideas"],
  },
  agency: {
    name: "Agency", usd: 249, ngn: 190_000, brands: 5, posts: 150, videos: 40,
    blurb: "For freelancers and agencies running several brands.",
    features: ["5 brands", "150 posts a month", "40 videos a month", "Team members", "Everything in Growth"],
  },
};

export const PAID_PLANS: PaidPlanId[] = ["starter", "growth", "agency"];
export const TRIAL_DAYS = 14;
export const isUnlimited = (n: number) => n >= UNLIMITED;
/** Plans that are never billed: Buzzbite's own admin workspace, and complimentary workspaces. */
export const isComplimentary = (p: PlanId) => p === "internal" || p === "free";

// How a workspace pays depends on its country: Paystack (naira) where it's set up, Stripe (USD cards) elsewhere.
export const PAYSTACK_COUNTRIES = (process.env.PAYSTACK_COUNTRIES || "NG").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
export const providerForCountry = (country: string | null | undefined): "stripe" | "paystack" =>
  country && PAYSTACK_COUNTRIES.includes(country.toUpperCase()) ? "paystack" : "stripe";
