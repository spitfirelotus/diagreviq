import { useState } from "react";

// ═══════════════════════════════════════════════════════════════════════════════
// DATA LINEAGE MAP
// Every field traces back to a source table + column.
// In a real system these would be SQL queries or API calls.
// ═══════════════════════════════════════════════════════════════════════════════
export const DATA_LINEAGE = {
  // FINANCIAL HEALTH signals
  denialRatePct:        { table:"claims",           field:"status",                  calc:"COUNT(status='denied') / COUNT(*) * 100",            filter:"WHERE period = current_month" },
  arBuckets:            { table:"accounts_receivable",field:"balance, aging_days",   calc:"SUM(balance) GROUP BY aging_bucket",                  filter:"WHERE account_id = :id" },
  avgDaysToCollect:     { table:"accounts_receivable",field:"aging_days, balance",   calc:"SUM(aging_midpoint * balance) / SUM(balance)",        filter:"WHERE account_id = :id" },
  // OPERATIONAL HEALTH signals
  studiesLastMonth:     { table:"orders",            field:"order_id, created_at",   calc:"COUNT(*)",                                            filter:"WHERE created_at >= date_trunc('month', now())" },
  studiesBaseline:      { table:"orders",            field:"order_id, created_at",   calc:"AVG(monthly_count) over prior 3 months",              filter:"WHERE account_id = :id" },
  manualOverrides:      { table:"billing_events",    field:"event_type",             calc:"COUNT(event_type='manual_override')",                  filter:"WHERE period = current_month" },
  priorAuthDenials:     { table:"prior_authorizations",field:"status",               calc:"COUNT(status='denied') / COUNT(*) * 100",             filter:"WHERE account_id = :id AND period = current_month" },
  // ADOPTION HEALTH signals
  onboardingPct:        { table:"feature_adoption",  field:"feature_id, activated_at",calc:"COUNT(activated) / COUNT(total_features) * 100",    filter:"WHERE account_id = :id" },
  activeUsersPct:       { table:"user_sessions",     field:"user_id, last_login",    calc:"COUNT(last_login >= 30d ago) / COUNT(total_users) * 100", filter:"WHERE account_id = :id" },
  featuresUnused:       { table:"feature_adoption",  field:"feature_id, activated_at",calc:"COUNT(activated_at IS NULL)",                        filter:"WHERE account_id = :id" },
  // RELATIONSHIP HEALTH signals
  daysSinceActivity:    { table:"activity_log",      field:"account_id, created_at", calc:"DATEDIFF(NOW(), MAX(created_at))",                    filter:"WHERE account_id = :id" },
  npsScore:             { table:"nps_responses",     field:"score, submitted_at",    calc:"AVG(score)",                                          filter:"WHERE account_id = :id AND submitted_at >= 90d ago" },
  executiveEngagement:  { table:"meeting_log",       field:"contact_level, meeting_date",calc:"COUNT(*) WHERE contact_level='executive'",        filter:"WHERE account_id = :id AND meeting_date >= 90d ago" },
  // SUPPORT HEALTH signals
  openTickets:          { table:"support_tickets",   field:"status, created_at",     calc:"COUNT(status IN ('open','pending'))",                  filter:"WHERE account_id = :id" },
  avgResolutionDays:    { table:"support_tickets",   field:"created_at, resolved_at",calc:"AVG(DATEDIFF(resolved_at, created_at))",               filter:"WHERE account_id = :id AND status='resolved'" },
  escalationCount:      { table:"support_tickets",   field:"priority, escalated_at", calc:"COUNT(priority='critical' OR escalated_at IS NOT NULL)",filter:"WHERE account_id = :id AND period = last_30d" },
};

// ═══════════════════════════════════════════════════════════════════════════════
// INDUSTRY BENCHMARKS  (source: MGMA, HFMA, HIMSS published benchmarks)
// ═══════════════════════════════════════════════════════════════════════════════
const BENCHMARKS = {
  denialRatePct:      { good:5,   warn:12,  label:"Claim Denial Rate",    unit:"%",  source:"MGMA 2024",  note:"National diagnostic avg: 8–12%" },
  avgDaysToCollect:   { good:30,  warn:50,  label:"Avg Days to Collect",  unit:"d",  source:"HFMA 2024",  note:"Best practice: <35 days" },
  avgResolutionDays:  { good:2,   warn:5,   label:"Ticket Resolution",    unit:"d",  source:"Internal",   note:"SaaS benchmark: <2 days" },
  activeUsersPct:     { good:80,  warn:55,  label:"Active User Rate",     unit:"%",  source:"HIMSS 2024", note:"High-adoption benchmark: >80%" },
};

function benchmarkStatus(metric, value) {
  const b = BENCHMARKS[metric];
  if (!b) return null;
  const better = ["denialRatePct","avgDaysToCollect","avgResolutionDays"].includes(metric);
  if (better) {
    if (value <= b.good) return "good";
    if (value <= b.warn) return "warn";
    return "bad";
  } else {
    if (value >= b.good) return "good";
    if (value >= b.warn) return "warn";
    return "bad";
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-LAYER HEALTH SCORE ENGINE
// 5 sub-scores → 1 composite score
// Each signal tagged with its source table for full lineage
// ═══════════════════════════════════════════════════════════════════════════════
const SUB_SCORE_WEIGHTS = { financial:0.30, operational:0.20, adoption:0.20, relationship:0.15, support:0.15 };

function calcFinancialHealth({ denialRatePct, ar, denialTrend }) {
  // SOURCE: claims table (denial rate) + accounts_receivable table (AR aging)
  const denialScore   = Math.round(Math.max(0, Math.min(100, (1 - denialRatePct / 25) * 100)));
  const total         = ar.d0_30 + ar.d31_60 + ar.d61_90 + ar.d90plus;
  const currentPct    = total > 0 ? ar.d0_30 / total : 1;
  const arScore       = Math.round(Math.max(0, Math.min(100, (currentPct - 0.4) / 0.4 * 100)));
  const trendBonus    = denialTrend === "improving" ? 5 : denialTrend === "worsening" ? -8 : 0;
  return { score: Math.min(100, Math.round(denialScore * 0.55 + arScore * 0.45 + trendBonus)), denialScore, arScore };
}

function calcOperationalHealth({ studiesLastMonth, studiesBaseline, manualOverrides, priorAuthDenialPct, studiesTrend }) {
  // SOURCE: orders table (volume) + billing_events table (overrides) + prior_authorizations table
  const usageRatio  = Math.min(studiesLastMonth / studiesBaseline, 1.5);
  const usageScore  = Math.round(Math.min(usageRatio / 1.5 * 100, 100));
  const overrideScore = Math.round(Math.max(0, 100 - manualOverrides * 4));
  const priorScore  = Math.round(Math.max(0, Math.min(100, (1 - priorAuthDenialPct / 30) * 100)));
  const trendBonus  = studiesTrend === "improving" ? 5 : studiesTrend === "worsening" ? -8 : 0;
  return { score: Math.min(100, Math.round(usageScore * 0.5 + overrideScore * 0.3 + priorScore * 0.2 + trendBonus)), usageScore, overrideScore, priorScore };
}

function calcAdoptionHealth({ onboardingPct, activeUsersPct, featuresUnused }) {
  // SOURCE: feature_adoption table + user_sessions table
  const onboardScore  = Math.round(onboardingPct);
  const activeScore   = Math.round(Math.min(activeUsersPct, 100));
  const featureScore  = Math.round(Math.max(0, 100 - featuresUnused * 12));
  return { score: Math.round(onboardScore * 0.45 + activeScore * 0.35 + featureScore * 0.20), onboardScore, activeScore, featureScore };
}

function calcRelationshipHealth({ daysSinceActivity, npsScore, executiveEngagement, activityTrend }) {
  // SOURCE: activity_log + nps_responses + meeting_log tables
  const activityScore   = Math.round(Math.max(0, Math.min(100, (1 - daysSinceActivity / 30) * 100)));
  const npsNorm         = npsScore !== null ? Math.round((npsScore / 10) * 100) : 50;
  const execScore       = Math.round(Math.min(executiveEngagement * 25, 100));
  const trendBonus      = activityTrend === "improving" ? 5 : activityTrend === "worsening" ? -8 : 0;
  return { score: Math.min(100, Math.round(activityScore * 0.4 + npsNorm * 0.35 + execScore * 0.25 + trendBonus)), activityScore, npsNorm, execScore };
}

function calcSupportHealth({ openTickets, avgResolutionDays, escalationCount }) {
  // SOURCE: support_tickets table
  const ticketScore     = Math.round(Math.max(0, 100 - openTickets * 7));
  const resolutionScore = Math.round(Math.max(0, Math.min(100, (1 - avgResolutionDays / 14) * 100)));
  const escalationScore = Math.round(Math.max(0, 100 - escalationCount * 20));
  return { score: Math.round(ticketScore * 0.4 + resolutionScore * 0.35 + escalationScore * 0.25), ticketScore, resolutionScore, escalationScore };
}

function buildHealthScore(a) {
  const financial    = calcFinancialHealth(a);
  const operational  = calcOperationalHealth(a);
  const adoption     = calcAdoptionHealth(a);
  const relationship = calcRelationshipHealth(a);
  const support      = calcSupportHealth(a);
  const composite    = Math.round(
    financial.score    * SUB_SCORE_WEIGHTS.financial +
    operational.score  * SUB_SCORE_WEIGHTS.operational +
    adoption.score     * SUB_SCORE_WEIGHTS.adoption +
    relationship.score * SUB_SCORE_WEIGHTS.relationship +
    support.score      * SUB_SCORE_WEIGHTS.support
  );
  // Risk drivers: find what's pulling score down most
  const drivers = [
    { label:"90+ Day A/R Rising",          impact: a.ar.d90plus > 30000 ? -Math.round(a.ar.d90plus/5000) : 0,  table:"accounts_receivable", field:"balance WHERE aging_days > 90" },
    { label:"Denial Rate Above Benchmark", impact: a.denialRatePct > 8  ? -Math.round((a.denialRatePct-8)*1.2) : 0, table:"claims", field:"status='denied'" },
    { label:"Executive Disengagement",     impact: a.executiveEngagement < 2 ? -10 : 0,                         table:"meeting_log", field:"contact_level='executive'" },
    { label:"Low Feature Adoption",        impact: a.featuresUnused > 1 ? -Math.round(a.featuresUnused*5) : 0,  table:"feature_adoption", field:"activated_at IS NULL" },
    { label:"Support Escalations",         impact: a.escalationCount > 0 ? -Math.round(a.escalationCount*6) : 0,table:"support_tickets", field:"priority='critical'" },
    { label:"Manual Billing Overrides",    impact: a.manualOverrides > 5 ? -Math.round((a.manualOverrides-5)*2): 0, table:"billing_events", field:"event_type='manual_override'" },
    { label:"Low User Activity",           impact: a.activeUsersPct < 60 ? -Math.round((60-a.activeUsersPct)/3): 0, table:"user_sessions", field:"last_login" },
    { label:"Prior Auth Denial Rate",      impact: a.priorAuthDenialPct > 10 ? -Math.round((a.priorAuthDenialPct-10)*0.8):0, table:"prior_authorizations", field:"status='denied'" },
  ].filter(d => d.impact < 0).sort((a,b) => a.impact - b.impact).slice(0,5);

  return { composite, financial, operational, adoption, relationship, support, drivers };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNT DATA  (raw signals — scores are computed, never hardcoded)
// ═══════════════════════════════════════════════════════════════════════════════
const accountsRaw = [
  {
    id:1, name:"Apex Diagnostic Imaging Center", city:"Houston, TX",
    specialties:["Radiology","Cardiology"], mrr:8400, arr:100800,
    studiesLastMonth:1240, studiesBaseline:1100, denialRatePct:4.2,
    onboardingPct:100, activeUsersPct:88, featuresUnused:1,
    openTickets:1, avgResolutionDays:1.2, escalationCount:0,
    daysSinceActivity:1, npsScore:9, executiveEngagement:3,
    manualOverrides:3, priorAuthDenialPct:6,
    ar:{ d0_30:142000, d31_60:18000, d61_90:6000, d90plus:2000 },
    churnRisk:"Low", upsellPotential:"High", onboardingStage:"Fully Adopted",
    csm:"Jordan Reyes",
    trends:{ denial:"stable", studies:"improving", ar:"stable", tickets:"stable", activity:"stable" },
    notes:"Top performer. Has not activated Nuclear Medicine module despite adding NM services 3 months ago. Champion is billing director Dana Cho.",
    flags:["upsell"],
    interventionStory: null,
  },
  {
    id:2, name:"Great Lakes Neurology & Diagnostics", city:"Cleveland, OH",
    specialties:["Neurology","Physiatry"], mrr:6200, arr:74400,
    studiesLastMonth:310, studiesBaseline:820, denialRatePct:18.7,
    onboardingPct:52, activeUsersPct:34, featuresUnused:4,
    openTickets:8, avgResolutionDays:6.8, escalationCount:2,
    daysSinceActivity:22, npsScore:5, executiveEngagement:0,
    manualOverrides:22, priorAuthDenialPct:24,
    ar:{ d0_30:28000, d31_60:31000, d61_90:27000, d90plus:44000 },
    churnRisk:"High", upsellPotential:"Low", onboardingStage:"Stalled",
    csm:"Morgan Lane",
    trends:{ denial:"worsening", studies:"worsening", ar:"worsening", tickets:"worsening", activity:"worsening" },
    notes:"EMG and EEG billing still being done manually outside platform. Denial rate spiked after coding specialist quit 6 weeks ago.",
    flags:["churn","support","blocker"],
    interventionStory: null,
  },
  {
    id:3, name:"Suncoast Heart & Vascular Diagnostics", city:"Tampa, FL",
    specialties:["Cardiology"], mrr:11600, arr:139200,
    studiesLastMonth:2180, studiesBaseline:1900, denialRatePct:2.9,
    onboardingPct:100, activeUsersPct:94, featuresUnused:0,
    openTickets:0, avgResolutionDays:0.8, escalationCount:0,
    daysSinceActivity:0, npsScore:10, executiveEngagement:4,
    manualOverrides:1, priorAuthDenialPct:3,
    ar:{ d0_30:198000, d31_60:22000, d61_90:5000, d90plus:1000 },
    churnRisk:"Low", upsellPotential:"High", onboardingStage:"Fully Adopted",
    csm:"Taylor Voss",
    trends:{ denial:"improving", studies:"improving", ar:"improving", tickets:"stable", activity:"stable" },
    notes:"Highest volume account. Dr. Ruiz mentioned two affiliated outpatient cath labs not yet on platform. Perfect NPS.",
    flags:["upsell","expansion","strategic"],
    interventionStory: null,
  },
  {
    id:4, name:"Rocky Mountain Diagnostic Center", city:"Denver, CO",
    specialties:["Radiology","Nuclear Medicine"], mrr:9100, arr:109200,
    studiesLastMonth:870, studiesBaseline:1200, denialRatePct:9.1,
    onboardingPct:68, activeUsersPct:61, featuresUnused:3,
    openTickets:4, avgResolutionDays:3.4, escalationCount:1,
    daysSinceActivity:6, npsScore:7, executiveEngagement:2,
    manualOverrides:11, priorAuthDenialPct:15,
    ar:{ d0_30:74000, d31_60:38000, d61_90:29000, d90plus:18000 },
    churnRisk:"Medium", upsellPotential:"Medium", onboardingStage:"In Progress",
    csm:"Jordan Reyes",
    trends:{ denial:"stable", studies:"worsening", ar:"worsening", tickets:"stable", activity:"stable" },
    notes:"PET/CT and SPECT billing stalled due to prior auth workflow confusion. Renewal in 75 days.",
    flags:["onboarding","renewal","blocker"],
    interventionStory: null,
  },
  {
    id:5, name:"Meridian Multi-Specialty Diagnostics", city:"Atlanta, GA",
    specialties:["Radiology","Neurology","Physiatry","Cardiology"], mrr:14800, arr:177600,
    studiesLastMonth:3600, studiesBaseline:3200, denialRatePct:3.8,
    onboardingPct:100, activeUsersPct:91, featuresUnused:0,
    openTickets:2, avgResolutionDays:1.5, escalationCount:0,
    daysSinceActivity:2, npsScore:9, executiveEngagement:4,
    manualOverrides:4, priorAuthDenialPct:5,
    ar:{ d0_30:312000, d31_60:41000, d61_90:12000, d90plus:5000 },
    churnRisk:"Low", upsellPotential:"High", onboardingStage:"Fully Adopted",
    csm:"Taylor Voss",
    trends:{ denial:"stable", studies:"improving", ar:"stable", tickets:"improving", activity:"stable" },
    notes:"Largest account. Interested in enterprise analytics tier. Budget conversation in Q3.",
    flags:["upsell","strategic"],
    interventionStory: null,
  },
  {
    id:6, name:"Valley Spine & Neurology Diagnostics", city:"Phoenix, AZ",
    specialties:["Neurology","Physiatry"], mrr:4700, arr:56400,
    studiesLastMonth:640, studiesBaseline:600, denialRatePct:7.4,
    onboardingPct:100, activeUsersPct:72, featuresUnused:2,
    openTickets:2, avgResolutionDays:2.9, escalationCount:0,
    daysSinceActivity:4, npsScore:8, executiveEngagement:2,
    manualOverrides:8, priorAuthDenialPct:11,
    ar:{ d0_30:52000, d31_60:19000, d61_90:14000, d90plus:8000 },
    churnRisk:"Medium", upsellPotential:"Medium", onboardingStage:"Fully Adopted",
    csm:"Morgan Lane",
    trends:{ denial:"stable", studies:"stable", ar:"stable", tickets:"stable", activity:"stable" },
    notes:"Denial rate above benchmark for nerve conduction studies. NCS-specific coding rules module could help.",
    flags:["upsell"],
    interventionStory: null,
  },
  {
    id:7, name:"Capitol Nuclear & Cardiac Imaging", city:"Washington, DC",
    specialties:["Nuclear Medicine","Cardiology"], mrr:12300, arr:147600,
    studiesLastMonth:95, studiesBaseline:980, denialRatePct:31.2,
    onboardingPct:35, activeUsersPct:18, featuresUnused:6,
    openTickets:14, avgResolutionDays:11.2, escalationCount:4,
    daysSinceActivity:38, npsScore:3, executiveEngagement:0,
    manualOverrides:38, priorAuthDenialPct:41,
    ar:{ d0_30:18000, d31_60:24000, d61_90:38000, d90plus:91000 },
    churnRisk:"Critical", upsellPotential:"None", onboardingStage:"Stalled",
    csm:"Jordan Reyes",
    trends:{ denial:"worsening", studies:"worsening", ar:"worsening", tickets:"worsening", activity:"worsening" },
    notes:"Ownership transition 8 weeks ago. New management has not engaged. Radiopharmaceutical billing never completed. Escalation required.",
    flags:["churn","escalation"],
    interventionStory: null,
  },
  {
    id:8, name:"Northshore Radiology Associates", city:"Chicago, IL",
    specialties:["Radiology"], mrr:5500, arr:66000,
    studiesLastMonth:1050, studiesBaseline:950, denialRatePct:3.1,
    onboardingPct:100, activeUsersPct:87, featuresUnused:0,
    openTickets:0, avgResolutionDays:1.0, escalationCount:0,
    daysSinceActivity:3, npsScore:9, executiveEngagement:3,
    manualOverrides:2, priorAuthDenialPct:4,
    ar:{ d0_30:89000, d31_60:11000, d61_90:3000, d90plus:1000 },
    churnRisk:"Low", upsellPotential:"Medium", onboardingStage:"Fully Adopted",
    csm:"Taylor Voss",
    trends:{ denial:"stable", studies:"improving", ar:"stable", tickets:"stable", activity:"stable" },
    notes:"Consistently strong. Recently added contrast-enhanced mammography. Advanced analytics add-on opportunity.",
    flags:["upsell"],
    interventionStory: null,
  },
  // ── INTERVENTION STORY ACCOUNT ──────────────────────────────────────────────
  {
    id:9, name:"Lakewood Spine & Rehab Diagnostics", city:"Dallas, TX",
    specialties:["Physiatry","Neurology"], mrr:7200, arr:86400,
    studiesLastMonth:920, studiesBaseline:880, denialRatePct:6.1,
    onboardingPct:97, activeUsersPct:83, featuresUnused:1,
    openTickets:1, avgResolutionDays:1.8, escalationCount:0,
    daysSinceActivity:2, npsScore:9, executiveEngagement:3,
    manualOverrides:4, priorAuthDenialPct:7,
    ar:{ d0_30:118000, d31_60:14000, d61_90:4000, d90plus:2000 },
    churnRisk:"Low", upsellPotential:"High", onboardingStage:"Fully Adopted",
    csm:"Jordan Reyes",
    trends:{ denial:"improving", studies:"improving", ar:"improving", tickets:"improving", activity:"improving" },
    notes:"Full recovery after near-churn event 90 days ago. Now one of the strongest accounts in the portfolio.",
    flags:["upsell","strategic"],
    interventionStory: {
      accountName: "Lakewood Spine & Rehab Diagnostics",
      triggeredAt: "90 days ago",
      beforeState: {
        composite: 31,
        denialRatePct: 22.4,
        arD90plus: 68000,
        openTickets: 11,
        activeUsersPct: 29,
        onboardingPct: 41,
        notes:"New billing director hired without platform training. EMG/NCS claims being submitted manually with wrong modifier codes. AR collapsing."
      },
      interventions:[
        { week:"Week 1", action:"CSM escalated to VP of CS. Emergency workflow audit conducted with billing director.", outcome:"Root cause identified: modifier 59 applied incorrectly on NCS bundles." },
        { week:"Week 2", action:"Activated NCS-specific coding rules module. Live training session with billing team (4 staff).", outcome:"Manual overrides dropped from 31 to 8 per week." },
        { week:"Week 3", action:"Submitted corrected claims for 90-day backlog via platform batch resubmission tool.", outcome:"$41K in previously denied claims recovered within 14 days." },
        { week:"Week 4–8", action:"Weekly check-in cadence established. Executive sponsor (COO) re-engaged with QBR.", outcome:"Denial rate fell from 22.4% to 8.1%. AR current bucket rose from 28% to 71%." },
      ],
      afterState: {
        composite: 84,
        denialRatePct: 6.1,
        arD90plus: 2000,
        openTickets: 1,
        activeUsersPct: 83,
        onboardingPct: 97,
        notes:"Account stabilized. NPS improved from 4 to 9. Now being considered as a reference customer."
      },
      arRecovered: 41000,
      revenueRetained: 86400,
    },
  },
];

const accounts = accountsRaw.map(a => ({ ...a, health: buildHealthScore(a) }));

// ═══════════════════════════════════════════════════════════════════════════════
// STYLE CONFIGS
// ═══════════════════════════════════════════════════════════════════════════════
const specialtyColors = { Radiology:"#6366f1", Neurology:"#0891b2", Physiatry:"#059669", Cardiology:"#e11d48", "Nuclear Medicine":"#d97706" };
const riskConfig = { Low:{color:"#16a34a",bg:"#f0fdf4",label:"Low Risk"}, Medium:{color:"#d97706",bg:"#fffbeb",label:"Med Risk"}, High:{color:"#dc2626",bg:"#fef2f2",label:"High Risk"}, Critical:{color:"#be123c",bg:"#fff1f2",label:"Critical"} };
const flagConfig = { churn:{bg:"#fef2f2",color:"#dc2626",label:"⚠ Churn"}, upsell:{bg:"#f0fdf4",color:"#16a34a",label:"↑ Upsell"}, onboarding:{bg:"#eff6ff",color:"#2563eb",label:"◎ Onboard"}, renewal:{bg:"#fefce8",color:"#ca8a04",label:"↻ Renew"}, expansion:{bg:"#f5f3ff",color:"#7c3aed",label:"⊕ Expand"}, support:{bg:"#fff7ed",color:"#ea580c",label:"✉ Support"}, blocker:{bg:"#fff1f2",color:"#be123c",label:"⛔ Blocker"}, escalation:{bg:"#fdf2f8",color:"#9d174d",label:"🔺 Escalate"}, strategic:{bg:"#f0f9ff",color:"#0369a1",label:"★ Strategic"} };
const AR_BUCKETS = [{ key:"d0_30",label:"0–30d",color:"#22c55e" },{ key:"d31_60",label:"31–60d",color:"#f59e0b" },{ key:"d61_90",label:"61–90d",color:"#ef4444" },{ key:"d90plus",label:"90d+",color:"#be123c" }];
const SUB_SCORE_META = [
  { key:"financial",    label:"Financial",    icon:"💰", weight:0.30, tables:["claims","accounts_receivable"],      description:"Denial rate + AR aging health" },
  { key:"operational",  label:"Operational",  icon:"⚙",  weight:0.20, tables:["orders","billing_events","prior_authorizations"], description:"Study volume + manual overrides + prior auth" },
  { key:"adoption",     label:"Adoption",     icon:"◎",  weight:0.20, tables:["feature_adoption","user_sessions"], description:"Onboarding % + active users + unused features" },
  { key:"relationship", label:"Relationship", icon:"🤝", weight:0.15, tables:["activity_log","nps_responses","meeting_log"], description:"Recency + NPS + executive engagement" },
  { key:"support",      label:"Support",      icon:"🎫", weight:0.15, tables:["support_tickets"],                   description:"Open tickets + resolution time + escalations" },
];

function arTotal(ar) { return ar.d0_30+ar.d31_60+ar.d61_90+ar.d90plus; }
function arDaysToCollect(ar) { const t=arTotal(ar); if(!t) return 0; return Math.round((ar.d0_30*15+ar.d31_60*45+ar.d61_90*75+ar.d90plus*105)/t); }
function trendIcon(t) { return t==="improving"?"↑":t==="worsening"?"↓":"↔"; }
function trendColor(t) { return t==="improving"?"#16a34a":t==="worsening"?"#dc2626":"#64748b"; }
function scoreColor(s) { return s>=75?"#16a34a":s>=55?"#f59e0b":s>=35?"#ef4444":"#be123c"; }

// ─── SHARED COMPONENTS ────────────────────────────────────────────────────────
function Ring({ score, size=60, stroke=5 }) {
  const r=size/2-stroke, cx=size/2, cy=size/2, circ=2*Math.PI*r, c=scoreColor(score);
  return (
    <svg width={size} height={size}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e2e8f0" strokeWidth={stroke}/>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={c} strokeWidth={stroke}
        strokeDasharray={`${(score/100)*circ} ${circ}`} strokeLinecap="round"
        style={{transform:`rotate(-90deg)`,transformOrigin:`${cx}px ${cy}px`,transition:"stroke-dasharray 0.7s ease"}}/>
      <text x={cx} y={cy+size*0.09} textAnchor="middle" fill={c} style={{fontSize:`${size*0.22}px`,fontWeight:"800",fontFamily:"inherit"}}>{score}</text>
    </svg>
  );
}

function ARBar({ ar, compact }) {
  const total=arTotal(ar), days=arDaysToCollect(ar), overduePct=Math.round(((ar.d61_90+ar.d90plus)/total)*100);
  return (
    <div>
      {!compact&&<div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}><span style={{fontSize:11,fontWeight:700,color:"#0f172a"}}>AR Aging</span><span style={{fontSize:10,color:days>45?"#dc2626":"#64748b"}}>~{days}d avg collect</span></div>}
      <div style={{height:compact?7:11,display:"flex",borderRadius:6,overflow:"hidden",marginBottom:compact?0:7}}>
        {AR_BUCKETS.map(b=>{ const p=total>0?(ar[b.key]/total)*100:0; return p>0?<div key={b.key} title={`${b.label}: $${ar[b.key].toLocaleString()}`} style={{width:`${p}%`,background:b.color}}/>:null; })}
      </div>
      {!compact&&(
        <>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:6,marginBottom:7}}>
            {AR_BUCKETS.map(b=>(
              <div key={b.key} style={{background:b.color+"15",borderRadius:6,padding:"5px 6px",borderLeft:`3px solid ${b.color}`}}>
                <div style={{fontSize:9,color:"#94a3b8"}}>{b.label}</div>
                <div style={{fontSize:11,fontWeight:700,color:b.color}}>${(ar[b.key]/1000).toFixed(0)}K</div>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            <span style={{fontSize:10,padding:"2px 8px",borderRadius:10,background:"#f1f5f9",color:"#475569"}}>Total: <strong>${(total/1000).toFixed(0)}K</strong></span>
            {overduePct>20&&<span style={{fontSize:10,padding:"2px 8px",borderRadius:10,background:"#fef2f2",color:"#dc2626"}}>⚠ {overduePct}% overdue 60d+</span>}
            {ar.d90plus>20000&&<span style={{fontSize:10,padding:"2px 8px",borderRadius:10,background:"#fff1f2",color:"#be123c"}}>${(ar.d90plus/1000).toFixed(0)}K at 90d+</span>}
          </div>
        </>
      )}
    </div>
  );
}

function TrendPill({ trend }) {
  return <span style={{fontSize:10,fontWeight:700,color:trendColor(trend)}}>{trendIcon(trend)}</span>;
}

function BenchmarkBadge({ metric, value }) {
  const b=BENCHMARKS[metric]; if(!b) return null;
  const status=benchmarkStatus(metric,value);
  const colors={good:{bg:"#f0fdf4",color:"#16a34a"},warn:{bg:"#fffbeb",color:"#d97706"},bad:{bg:"#fef2f2",color:"#dc2626"}};
  const c=colors[status];
  return <span title={b.note} style={{fontSize:9,padding:"1px 6px",borderRadius:8,background:c.bg,color:c.color,cursor:"help"}}>vs {b.source}</span>;
}

// ─── RISK DRIVERS PANEL ───────────────────────────────────────────────────────
function RiskDrivers({ drivers, onClose }) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.65)",backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1001,padding:20}}>
      <div style={{background:"#fff",borderRadius:22,width:"100%",maxWidth:620,boxShadow:"0 32px 80px rgba(0,0,0,0.3)",overflow:"hidden"}}>
        <div style={{background:"linear-gradient(135deg,#0f172a,#7c1d1d)",padding:"18px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{color:"#94a3b8",fontSize:10,letterSpacing:"0.12em",textTransform:"uppercase"}}>Operational Risk Intelligence</div>
            <div style={{color:"#fff",fontSize:17,fontWeight:800,marginTop:2}}>Risk Driver Analysis</div>
          </div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.12)",border:"none",color:"#fff",width:32,height:32,borderRadius:"50%",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
        </div>
        <div style={{padding:"20px 24px"}}>
          <div style={{fontSize:12,color:"#64748b",marginBottom:16,lineHeight:1.6}}>Each factor below is actively reducing this account's composite health score. Click any row to see the exact database source.</div>
          {drivers.length===0
            ? <div style={{textAlign:"center",padding:"30px",color:"#94a3b8",fontSize:14}}>✓ No significant risk drivers detected</div>
            : drivers.map((d,i)=>(
              <details key={i} style={{marginBottom:10,borderRadius:10,border:"1px solid #fecaca",overflow:"hidden"}}>
                <summary style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",background:"#fef2f2",cursor:"pointer",listStyle:"none"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:18,fontWeight:900,color:"#dc2626",minWidth:36}}>{d.impact}</span>
                    <span style={{fontSize:13,fontWeight:600,color:"#0f172a"}}>{d.label}</span>
                  </div>
                  <span style={{fontSize:10,color:"#94a3b8"}}>▼ data source</span>
                </summary>
                <div style={{padding:"10px 14px",background:"#fff",borderTop:"1px solid #fecaca"}}>
                  <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:"4px 12px",fontSize:12}}>
                    <span style={{color:"#94a3b8",fontWeight:600}}>Table:</span>
                    <code style={{color:"#0369a1",background:"#f0f9ff",padding:"1px 6px",borderRadius:4}}>{d.table}</code>
                    <span style={{color:"#94a3b8",fontWeight:600}}>Field/Filter:</span>
                    <code style={{color:"#7c3aed",background:"#f5f3ff",padding:"1px 6px",borderRadius:4}}>{d.field}</code>
                    <span style={{color:"#94a3b8",fontWeight:600}}>Lineage:</span>
                    <span style={{color:"#475569"}}>{DATA_LINEAGE[Object.keys(DATA_LINEAGE).find(k=>DATA_LINEAGE[k].table===d.table)]?.calc || "Aggregated count / ratio"}</span>
                  </div>
                </div>
              </details>
            ))
          }
        </div>
      </div>
    </div>
  );
}

// ─── SCORE EXPLAINER MODAL ────────────────────────────────────────────────────
function ScoreExplainer({ account, onClose }) {
  const h = account.health;
  const [activeLayer, setActiveLayer] = useState(null);
  const layerDetail = {
    financial:    [{ label:"Claim Denial Rate",   value:`${account.denialRatePct}%`,  trend:account.trends.denial,  table:"claims",             field:"status='denied'",        bench:"denialRatePct",  benchVal:account.denialRatePct },{ label:"AR Current %",        value:`${Math.round(account.ar.d0_30/arTotal(account.ar)*100)}%`, trend:account.trends.ar, table:"accounts_receivable", field:"aging_days 0–30" }],
    operational:  [{ label:"Studies vs Baseline", value:`${account.studiesLastMonth} / ${account.studiesBaseline}`, trend:account.trends.studies, table:"orders",          field:"COUNT(order_id)" },{ label:"Manual Overrides",    value:account.manualOverrides,     trend:"stable", table:"billing_events",   field:"event_type='manual_override'" },{ label:"Prior Auth Denials",  value:`${account.priorAuthDenialPct}%`, trend:"stable", table:"prior_authorizations", field:"status='denied'" }],
    adoption:     [{ label:"Onboarding Complete",  value:`${account.onboardingPct}%`,  trend:"stable", table:"feature_adoption",  field:"activated_at IS NOT NULL" },{ label:"Active Users",        value:`${account.activeUsersPct}%`,  trend:"stable", table:"user_sessions",    field:"last_login >= 30d ago" },{ label:"Unused Features",     value:account.featuresUnused,       trend:"stable", table:"feature_adoption",  field:"activated_at IS NULL" }],
    relationship: [{ label:"Days Since Activity",  value:`${account.daysSinceActivity}d`,trend:account.trends.activity,table:"activity_log",    field:"MAX(created_at)" },{ label:"NPS Score",           value:`${account.npsScore}/10`,    trend:"stable", table:"nps_responses",    field:"AVG(score)" },{ label:"Executive Meetings",  value:`${account.executiveEngagement} (90d)`,trend:"stable",table:"meeting_log",  field:"contact_level='executive'" }],
    support:      [{ label:"Open Tickets",         value:account.openTickets,          trend:account.trends.tickets, table:"support_tickets",  field:"status='open'" },{ label:"Avg Resolution",      value:`${account.avgResolutionDays}d`, trend:"stable", table:"support_tickets",  field:"AVG(resolved_at - created_at)" , bench:"avgResolutionDays", benchVal:account.avgResolutionDays },{ label:"Escalations (30d)",   value:account.escalationCount,      trend:"stable", table:"support_tickets",  field:"priority='critical'" }],
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.65)",backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:20}}>
      <div style={{background:"#fff",borderRadius:22,width:"100%",maxWidth:760,maxHeight:"92vh",display:"flex",flexDirection:"column",boxShadow:"0 32px 80px rgba(0,0,0,0.3)",overflow:"hidden"}}>
        <div style={{background:"linear-gradient(135deg,#0f172a,#1a3456)",padding:"18px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{color:"#64748b",fontSize:10,letterSpacing:"0.12em",textTransform:"uppercase"}}>Operational Risk Intelligence · Full Data Lineage</div>
            <div style={{color:"#fff",fontSize:17,fontWeight:800,marginTop:2}}>{account.name}</div>
          </div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.12)",border:"none",color:"#fff",width:32,height:32,borderRadius:"50%",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
        </div>

        <div style={{overflowY:"auto",flex:1,padding:"20px 24px"}}>
          {/* Composite */}
          <div style={{display:"flex",gap:20,alignItems:"center",marginBottom:22,padding:"16px 20px",background:"#f8fafc",borderRadius:14,border:"1px solid #e2e8f0"}}>
            <Ring score={h.composite} size={72} stroke={6}/>
            <div style={{flex:1}}>
              <div style={{fontSize:20,fontWeight:800,color:scoreColor(h.composite)}}>{h.composite} / 100 — Composite Score</div>
              <div style={{fontSize:12,color:"#64748b",marginTop:3}}>Weighted average of 5 operational health layers · Score = Σ(layer_score × layer_weight)</div>
              <div style={{fontSize:11,color:"#94a3b8",marginTop:4,fontFamily:"monospace"}}>{SUB_SCORE_META.map(s=>`${h[s.key].score}×${Math.round(s.weight*100)}%`).join(" + ")} = {h.composite}</div>
            </div>
          </div>

          {/* Sub-score layers */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:20}}>
            {SUB_SCORE_META.map(layer=>{
              const sc=h[layer.key].score; const isActive=activeLayer===layer.key;
              return (
                <div key={layer.key} onClick={()=>setActiveLayer(isActive?null:layer.key)}
                  style={{border:`2px solid ${isActive?"#2563eb":"#e2e8f0"}`,borderRadius:12,padding:"12px 14px",cursor:"pointer",transition:"all 0.2s",background:isActive?"#eff6ff":"#fff"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <div style={{fontSize:13,fontWeight:700,color:"#0f172a"}}>{layer.icon} {layer.label}</div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{fontSize:16,fontWeight:800,color:scoreColor(sc)}}>{sc}</span>
                      <span style={{fontSize:10,color:"#94a3b8"}}>×{Math.round(layer.weight*100)}%</span>
                    </div>
                  </div>
                  <div style={{height:6,background:"#f1f5f9",borderRadius:10,overflow:"hidden",marginBottom:6}}>
                    <div style={{height:"100%",width:`${sc}%`,background:scoreColor(sc),borderRadius:10,transition:"width 0.5s ease"}}/>
                  </div>
                  <div style={{fontSize:10,color:"#94a3b8"}}>{layer.description}</div>
                  <div style={{fontSize:9,color:"#cbd5e1",marginTop:3}}>Tables: {layer.tables.join(", ")}</div>
                  {isActive&&(
                    <div style={{marginTop:10,borderTop:"1px solid #bfdbfe",paddingTop:10}}>
                      {layerDetail[layer.key].map((sig,i)=>(
                        <div key={i} style={{display:"grid",gridTemplateColumns:"1fr auto",gap:4,marginBottom:8,padding:"6px 8px",background:"#f8fafc",borderRadius:8}}>
                          <div>
                            <div style={{display:"flex",alignItems:"center",gap:5}}>
                              <span style={{fontSize:11,fontWeight:600,color:"#0f172a"}}>{sig.label}</span>
                              <TrendPill trend={sig.trend}/>
                              {sig.bench&&<BenchmarkBadge metric={sig.bench} value={sig.benchVal}/>}
                            </div>
                            <div style={{fontSize:10,color:"#64748b",marginTop:1}}>
                              <code style={{background:"#e0f2fe",color:"#0369a1",padding:"0 4px",borderRadius:3}}>{sig.table}</code>
                              <span style={{color:"#94a3b8",marginLeft:4}}>{sig.field}</span>
                            </div>
                          </div>
                          <span style={{fontSize:14,fontWeight:700,color:"#0f172a",alignSelf:"center"}}>{sig.value}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Risk drivers */}
          {h.drivers.length>0&&(
            <div style={{padding:"14px 16px",background:"#fef2f2",borderRadius:12,border:"1px solid #fecaca"}}>
              <div style={{fontSize:12,fontWeight:700,color:"#dc2626",marginBottom:10}}>⚠ Active Risk Drivers</div>
              {h.drivers.map((d,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:i<h.drivers.length-1?"1px solid #fecaca":"none"}}>
                  <div>
                    <span style={{fontSize:12,color:"#0f172a"}}>{d.label}</span>
                    <span style={{fontSize:10,color:"#94a3b8",marginLeft:8}}>
                      <code style={{background:"#e0f2fe",color:"#0369a1",padding:"0 4px",borderRadius:3}}>{d.table}</code>
                    </span>
                  </div>
                  <span style={{fontSize:13,fontWeight:800,color:"#dc2626"}}>{d.impact}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── INTERVENTION STORY MODAL ─────────────────────────────────────────────────
function InterventionModal({ story, onClose }) {
  const b=story.beforeState, a=story.afterState;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.65)",backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:20}}>
      <div style={{background:"#fff",borderRadius:22,width:"100%",maxWidth:740,maxHeight:"92vh",display:"flex",flexDirection:"column",boxShadow:"0 32px 80px rgba(0,0,0,0.3)",overflow:"hidden"}}>
        <div style={{background:"linear-gradient(135deg,#064e3b,#065f46)",padding:"18px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{color:"#6ee7b7",fontSize:10,letterSpacing:"0.12em",textTransform:"uppercase"}}>Saved by Intervention · Case Study</div>
            <div style={{color:"#fff",fontSize:17,fontWeight:800,marginTop:2}}>{story.accountName}</div>
            <div style={{color:"#a7f3d0",fontSize:12,marginTop:2}}>${(story.arRecovered/1000).toFixed(0)}K AR recovered · ${(story.revenueRetained/1000).toFixed(0)}K ARR retained</div>
          </div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.12)",border:"none",color:"#fff",width:32,height:32,borderRadius:"50%",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
        </div>
        <div style={{overflowY:"auto",flex:1,padding:"22px 26px"}}>
          {/* Before / After */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:22}}>
            {[{label:"Before Intervention",state:b,color:"#dc2626",bg:"#fef2f2"},{label:"90 Days Later",state:a,color:"#16a34a",bg:"#f0fdf4"}].map(({label,state,color,bg})=>(
              <div key={label} style={{background:bg,borderRadius:14,padding:"16px 18px",border:`1px solid ${color}30`}}>
                <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",color,marginBottom:12}}>{label}</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10,marginBottom:10}}>
                  {[
                    {label:"Composite Score", val:state.composite},
                    {label:"Denial Rate",     val:`${state.denialRatePct}%`},
                    {label:"AR 90d+",         val:`$${(state.arD90plus/1000).toFixed(0)}K`},
                    {label:"Open Tickets",    val:state.openTickets},
                    {label:"Active Users",    val:`${state.activeUsersPct}%`},
                    {label:"Onboarding",      val:`${state.onboardingPct}%`},
                  ].map(m=>(
                    <div key={m.label} style={{background:"rgba(255,255,255,0.6)",borderRadius:8,padding:"6px 10px"}}>
                      <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase"}}>{m.label}</div>
                      <div style={{fontSize:15,fontWeight:800,color}}>{m.val}</div>
                    </div>
                  ))}
                </div>
                <div style={{fontSize:11,color:"#475569",lineHeight:1.6,fontStyle:"italic"}}>{state.notes}</div>
              </div>
            ))}
          </div>
          {/* Intervention timeline */}
          <div style={{fontSize:13,fontWeight:700,color:"#0f172a",marginBottom:12}}>CSM Intervention Timeline</div>
          {story.interventions.map((step,i)=>(
            <div key={i} style={{display:"flex",gap:14,marginBottom:16}}>
              <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                <div style={{width:32,height:32,borderRadius:"50%",background:"#2563eb",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{i+1}</div>
                {i<story.interventions.length-1&&<div style={{width:2,flex:1,background:"#e2e8f0",marginTop:4}}/>}
              </div>
              <div style={{flex:1,paddingBottom:i<story.interventions.length-1?16:0}}>
                <div style={{fontSize:11,fontWeight:700,color:"#2563eb",marginBottom:3}}>{step.week}</div>
                <div style={{fontSize:13,color:"#0f172a",marginBottom:4}}>{step.action}</div>
                <div style={{fontSize:12,color:"#16a34a",background:"#f0fdf4",padding:"5px 10px",borderRadius:8,borderLeft:"3px solid #16a34a"}}>✓ {step.outcome}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── AI COPILOT MODAL ─────────────────────────────────────────────────────────
function CopilotModal({ account, onClose }) {
  const [tab, setTab] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState("");
  const h=account.health, tot=arTotal(account.ar);
  const ctx=`Account: ${account.name} (${account.city})
Specialties: ${account.specialties.join(", ")}
Composite Risk Score: ${h.composite}/100
Sub-scores: Financial ${h.financial.score} | Operational ${h.operational.score} | Adoption ${h.adoption.score} | Relationship ${h.relationship.score} | Support ${h.support.score}
MRR: $${account.mrr.toLocaleString()} | ARR: $${account.arr.toLocaleString()}
Churn Risk: ${account.churnRisk} | Upsell: ${account.upsellPotential}
Claims Denial Rate: ${account.denialRatePct}% (trend: ${account.trends.denial})
AR Total: $${(tot/1000).toFixed(0)}K | Current (0-30d): ${Math.round(account.ar.d0_30/tot*100)}% | 90d+: $${(account.ar.d90plus/1000).toFixed(0)}K
Avg Days to Collect: ${arDaysToCollect(account.ar)}
Studies/Month: ${account.studiesLastMonth} vs baseline ${account.studiesBaseline} (trend: ${account.trends.studies})
Onboarding: ${account.onboardingPct}% | Active Users: ${account.activeUsersPct}% | Unused Features: ${account.featuresUnused}
Open Tickets: ${account.openTickets} | Avg Resolution: ${account.avgResolutionDays}d | Escalations: ${account.escalationCount}
Days Since Activity: ${account.daysSinceActivity} | NPS: ${account.npsScore}/10 | Executive Meetings (90d): ${account.executiveEngagement}
Manual Overrides: ${account.manualOverrides}/mo | Prior Auth Denial: ${account.priorAuthDenialPct}%
Top Risk Drivers: ${h.drivers.map(d=>`${d.label} (${d.impact}pts)`).join(", ")||"None"}
CSM Notes: ${account.notes}`;

  const prompts = {
    narrative:`You are an AI Customer Success Copilot for a B2B healthcare SaaS platform serving outpatient diagnostic testing centers. Write ONE cinematic executive-level narrative paragraph (4-5 sentences) about this account's current operational risk posture. Sound like a senior healthcare consultant, not a chatbot. Then provide 3 specific actions.

${ctx}

**Executive Risk Narrative**
[4-5 sentence paragraph. Lead with the most urgent signal. Reference specific metrics. Sound expensive.]

**Immediate Actions**
1. [Action with specific metric target]
2. [Action with specific metric target]
3. [Action with specific metric target]`,
    churn:`You are a churn prevention specialist for a healthcare SaaS company. Focus on the data signals showing operational deterioration.

${ctx}

**Why They Will Leave**
[Root cause tied to specific metrics and their trajectory]

**48-Hour Actions**
[What the CSM does TODAY and TOMORROW]

**30-Day Recovery Protocol**
[Week-by-week]

**Escalation Threshold**
[Exact metric thresholds that trigger leadership involvement]`,
    ar:`You are an AR recovery specialist. Analyze the aging buckets and create a concrete plan.

${ctx}

**AR Health Assessment**
[What the buckets reveal]

**Root Cause of Aging**
[Why money is stuck — tie to denial rate, prior auth, manual overrides]

**30-Day Collections Plan**
1. [Week 1]
2. [Week 2]
3. [Weeks 3-4]

**Expected Recovery**
[Realistic dollar amount recoverable and timeline]`,
    upsell:`You are a revenue expansion AI.

${ctx}

**Best Expansion Opportunity**
[What to sell, why now, which sub-score supports the case]

**ROI Argument**
[2 sentences, specific to their denial rate / AR situation]

**Ready-to-Send Email**
Subject: [subject]
[4-6 sentence email]`,
    qbr:`You are a QBR prep AI. This customer judges product success by speed of collections and ease of use.

${ctx}

**30-Min QBR Agenda**
[Time-blocked]

**Lead With These Wins**
[Specific metrics to celebrate]

**AR & Collections Slide**
[How to frame the aging data — position the platform as the reason for improvement or recovery path]

**Talking Points on Support**
[How to frame ticket volume and resolution time]

**Strategic Ask**
[What you want them to commit to before they leave the room]`,
  };

  const tabs=[{key:"narrative",icon:"✦",label:"Executive"},{key:"churn",icon:"⚠",label:"Churn Plan"},{key:"ar",icon:"💰",label:"AR Recovery"},{key:"upsell",icon:"↑",label:"Upsell"},{key:"qbr",icon:"📊",label:"QBR Prep"}];

  async function runPrompt(key) {
    setTab(key); setLoading(true); setResult("");
    try {
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,messages:[{role:"user",content:prompts[key]}]})});
      const data=await res.json();
      setResult(data.content?.map(b=>b.text||"").join("")||"No response.");
    } catch { setResult("Error. Please try again."); }
    setLoading(false);
  }

  function render(text) {
    return text.split("\n").map((line,i)=>{
      if(/^\*\*(.+)\*\*$/.test(line)) return <div key={i} style={{marginTop:18,marginBottom:6,fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",color:"#0f172a"}}>{line.replace(/\*\*/g,"")}</div>;
      if(/^\d+\./.test(line)) return <div key={i} style={{paddingLeft:14,marginBottom:5,fontSize:13.5,color:"#334155",lineHeight:1.65}}>{line}</div>;
      if(line.trim()==="") return <div key={i} style={{height:5}}/>;
      return <div key={i} style={{fontSize:13.5,color:"#475569",lineHeight:1.75}}>{line}</div>;
    });
  }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.65)",backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999,padding:20}}>
      <div style={{background:"#fff",borderRadius:22,width:"100%",maxWidth:720,maxHeight:"90vh",display:"flex",flexDirection:"column",boxShadow:"0 32px 80px rgba(0,0,0,0.3)"}}>
        <div style={{background:"linear-gradient(135deg,#0f172a,#1a3456)",padding:"18px 24px",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{color:"#64748b",fontSize:10,letterSpacing:"0.12em",textTransform:"uppercase"}}>AI Copilot · Operational Risk Intelligence</div>
            <div style={{color:"#fff",fontSize:17,fontWeight:800,marginTop:2}}>{account.name}</div>
            <div style={{display:"flex",gap:6,marginTop:6,flexWrap:"wrap"}}>
              {account.specialties.map(s=><span key={s} style={{background:specialtyColors[s]+"30",color:specialtyColors[s],border:`1px solid ${specialtyColors[s]}50`,fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:20}}>{s}</span>)}
            </div>
          </div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,0.12)",border:"none",color:"#fff",width:32,height:32,borderRadius:"50%",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
        </div>
        <div style={{display:"flex",background:"#f8fafc",borderBottom:"1px solid #e2e8f0"}}>
          {tabs.map(t=><button key={t.key} onClick={()=>runPrompt(t.key)} style={{flex:1,padding:"10px 4px",border:"none",cursor:"pointer",fontSize:11,fontWeight:600,background:tab===t.key?"#fff":"transparent",color:tab===t.key?"#0f172a":"#94a3b8",borderBottom:tab===t.key?"2px solid #2563eb":"2px solid transparent",transition:"all 0.15s"}}>{t.icon} {t.label}</button>)}
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"20px 24px"}}>
          {!tab&&<div style={{textAlign:"center",padding:"40px 0",color:"#94a3b8"}}><div style={{fontSize:40,marginBottom:10}}>✦</div><div style={{fontSize:14}}>Select an insight tab to generate AI analysis.</div></div>}
          {loading&&<div style={{textAlign:"center",padding:"40px 0"}}><div style={{display:"inline-block",width:36,height:36,border:"3px solid #e2e8f0",borderTopColor:"#2563eb",borderRadius:"50%",animation:"spin 0.75s linear infinite"}}/><div style={{color:"#94a3b8",fontSize:13,marginTop:12}}>Generating insight…</div><style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style></div>}
          {result&&!loading&&<div>{render(result)}</div>}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════
export default function DiagRevIQ() {
  const [copilotAccount, setCopilotAccount] = useState(null);
  const [scoreAccount, setScoreAccount] = useState(null);
  const [interventionStory, setInterventionStory] = useState(null);
  const [filter, setFilter] = useState("All");
  const [sort, setSort] = useState("health");

  const totalARR  = accounts.reduce((s,a)=>s+a.arr,0);
  const atRiskARR = accounts.filter(a=>["High","Critical"].includes(a.churnRisk)).reduce((s,a)=>s+a.arr,0);
  const avgHealth = Math.round(accounts.reduce((s,a)=>s+a.health.composite,0)/accounts.length);
  const totalAR90 = accounts.reduce((s,a)=>s+a.ar.d90plus,0);
  const totalAR   = accounts.reduce((s,a)=>s+arTotal(a.ar),0);

  const filterOpts=["All","Critical / High Risk","AR Overdue","Upsell Targets","Onboarding","Has Intervention"];
  const filtered = accounts
    .filter(a=>{
      if(filter==="Critical / High Risk") return ["High","Critical"].includes(a.churnRisk);
      if(filter==="AR Overdue") return (a.ar.d61_90+a.ar.d90plus)/arTotal(a.ar)>0.20;
      if(filter==="Upsell Targets") return a.upsellPotential==="High";
      if(filter==="Onboarding") return a.onboardingPct<100;
      if(filter==="Has Intervention") return !!a.interventionStory;
      return true;
    })
    .sort((a,b)=>{
      if(sort==="health") return a.health.composite-b.health.composite;
      if(sort==="arr") return b.arr-a.arr;
      if(sort==="ar_aging") return (b.ar.d61_90+b.ar.d90plus)-(a.ar.d61_90+a.ar.d90plus);
      if(sort==="tickets") return b.openTickets-a.openTickets;
      if(sort==="risk"){const r={Critical:0,High:1,Medium:2,Low:3};return r[a.churnRisk]-r[b.churnRisk];}
      return 0;
    });

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",fontFamily:"'DM Sans','Segoe UI',sans-serif"}}>
      {/* Nav */}
      <div style={{background:"linear-gradient(135deg,#0f172a,#1a3456)",height:58,padding:"0 28px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:50,boxShadow:"0 2px 20px rgba(0,0,0,0.35)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{background:"linear-gradient(135deg,#2563eb,#7c3aed)",width:32,height:32,borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>⚕</div>
          <span style={{color:"#fff",fontWeight:800,fontSize:16,letterSpacing:"-0.02em"}}>DiagRevIQ</span>
          <span style={{color:"#475569",fontSize:12,paddingLeft:4}}>Operational Risk Intelligence</span>
        </div>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <button onClick={()=>setInterventionStory(accounts.find(a=>a.interventionStory)?.interventionStory)} style={{background:"rgba(16,185,129,0.15)",border:"1px solid rgba(16,185,129,0.4)",color:"#6ee7b7",padding:"5px 14px",borderRadius:20,fontSize:11,fontWeight:600,cursor:"pointer"}}>✓ Intervention Story</button>
          <span style={{color:"#475569",fontSize:11}}>{accounts.length} Accounts</span>
        </div>
      </div>

      <div style={{padding:"24px 28px",maxWidth:1440,margin:"0 auto",minWidth:0}}>
        {/* KPIs */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:14,marginBottom:22}}>
          {[
            {label:"Managed ARR",     value:`$${(totalARR/1000).toFixed(0)}K`, sub:"Total Book",           accent:"#2563eb"},
            {label:"Avg Risk Score",  value:avgHealth,                          sub:"Portfolio Intelligence",accent:avgHealth>=70?"#16a34a":"#d97706"},
            {label:"ARR at Risk",     value:`$${(atRiskARR/1000).toFixed(0)}K`,sub:"High + Critical",       accent:"#dc2626"},
            {label:"Total AR",        value:`$${(totalAR/1000).toFixed(0)}K`,  sub:"Portfolio Receivables", accent:"#0891b2"},
            {label:"AR 90d+",         value:`$${(totalAR90/1000).toFixed(0)}K`,sub:"At-Risk Collections",   accent:"#be123c"},
          ].map(k=>(
            <div key={k.label} style={{background:"#fff",borderRadius:14,padding:"14px 18px",boxShadow:"0 1px 4px rgba(0,0,0,0.07)",borderTop:`3px solid ${k.accent}`}}>
              <div style={{fontSize:10,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:4}}>{k.label}</div>
              <div style={{fontSize:22,fontWeight:800,color:k.accent,lineHeight:1}}>{k.value}</div>
              <div style={{fontSize:11,color:"#cbd5e1",marginTop:3}}>{k.sub}</div>
            </div>
          ))}
        </div>

        {/* Legends */}
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:8}}>
          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            {Object.entries(specialtyColors).map(([s,c])=><div key={s} style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"#475569"}}><div style={{width:9,height:9,borderRadius:2,background:c}}/>{s}</div>)}
          </div>
          <div style={{display:"flex",gap:10}}>
            {AR_BUCKETS.map(b=><div key={b.key} style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"#475569"}}><div style={{width:9,height:9,borderRadius:2,background:b.color}}/>{b.label}</div>)}
          </div>
        </div>

        {/* Filters */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
          <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
            {filterOpts.map(f=><button key={f} onClick={()=>setFilter(f)} style={{padding:"5px 14px",borderRadius:20,border:"1px solid",borderColor:filter===f?"#2563eb":"#e2e8f0",background:filter===f?"#2563eb":"#fff",color:filter===f?"#fff":"#64748b",fontSize:11,fontWeight:600,cursor:"pointer"}}>{f}</button>)}
          </div>
          <select value={sort} onChange={e=>setSort(e.target.value)} style={{padding:"5px 12px",borderRadius:8,border:"1px solid #e2e8f0",fontSize:11,color:"#475569",background:"#fff",cursor:"pointer"}}>
            <option value="health">Sort: Risk Score ↑</option>
            <option value="risk">Sort: Churn Risk ↑</option>
            <option value="arr">Sort: ARR ↓</option>
            <option value="ar_aging">Sort: AR Overdue ↓</option>
            <option value="tickets">Sort: Open Tickets ↓</option>
          </select>
        </div>

        {/* Cards */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(420px,1fr))",gap:18,alignItems:"start"}}>
          {filtered.map(a=>{
            const h=a.health, risk=riskConfig[a.churnRisk];
            return (
              <div key={a.id} style={{background:"#fff",borderRadius:16,padding:"18px 20px",minWidth:0,overflow:"hidden",boxShadow:"0 1px 6px rgba(0,0,0,0.07)",border:a.churnRisk==="Critical"?"2px solid #fca5a5":a.interventionStory?"2px solid #6ee7b7":"1px solid #e2e8f0",transition:"box-shadow 0.2s,transform 0.2s"}}
                onMouseEnter={e=>{e.currentTarget.style.boxShadow="0 8px 24px rgba(0,0,0,0.13)";e.currentTarget.style.transform="translateY(-2px)";}}
                onMouseLeave={e=>{e.currentTarget.style.boxShadow="0 1px 6px rgba(0,0,0,0.07)";e.currentTarget.style.transform="translateY(0)";}}>

                {a.interventionStory&&<div style={{background:"#f0fdf4",borderRadius:8,padding:"5px 10px",marginBottom:10,fontSize:10,color:"#16a34a",fontWeight:600,border:"1px solid #bbf7d0"}}>✓ Saved by Intervention — click to view case study</div>}

                {/* Header */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                  <div style={{flex:1,paddingRight:8,minWidth:0}}>
                    <div style={{fontWeight:800,fontSize:15,color:"#0f172a",lineHeight:1.25,marginBottom:3,overflowWrap:"anywhere"}}>{a.name}</div>
                    <div style={{fontSize:11,color:"#94a3b8",marginBottom:5}}>{a.city}</div>
                    <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                      {a.specialties.map(s=><span key={s} style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:10,background:specialtyColors[s]+"18",color:specialtyColors[s]}}>{s}</span>)}
                    </div>
                  </div>
                  <div style={{textAlign:"center"}}>
                    <Ring score={h.composite}/>
                    <button onClick={()=>setScoreAccount(a)} style={{fontSize:8,color:"#94a3b8",background:"none",border:"none",cursor:"pointer",padding:0,textDecoration:"underline"}}>explain</button>
                  </div>
                </div>

                {/* Sub-score mini bar */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,minmax(0,1fr))",gap:6,marginBottom:12}}>
                  {SUB_SCORE_META.map(layer=>{
                    const sc=h[layer.key].score;
                    return (
                      <div key={layer.key} title={`${layer.label}: ${sc}/100`} style={{textAlign:"center"}}>
                        <div style={{fontSize:8,color:"#94a3b8",marginBottom:2}}>{layer.icon}</div>
                        <div style={{height:4,background:"#f1f5f9",borderRadius:4,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${sc}%`,background:scoreColor(sc),borderRadius:4}}/>
                        </div>
                        <div style={{fontSize:9,fontWeight:700,color:scoreColor(sc),marginTop:2}}>{sc}</div>
                      </div>
                    );
                  })}
                </div>

                {/* AR aging */}
                <div style={{background:"#f8fafc",borderRadius:10,padding:"10px 12px",marginBottom:10,border:"1px solid #e2e8f0"}}>
                  <ARBar ar={a.ar} compact={false}/>
                </div>

                {/* Tickets + resolution */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10,marginBottom:10}}>
                  <div style={{background:a.openTickets===0?"#f0fdf4":a.openTickets<=3?"#fffbeb":"#fef2f2",borderRadius:8,padding:"6px 10px"}}>
                    <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase"}}>Open Tickets</div>
                    <div style={{fontSize:16,fontWeight:800,color:a.openTickets===0?"#16a34a":a.openTickets<=3?"#d97706":"#dc2626"}}>{a.openTickets} <TrendPill trend={a.trends.tickets}/></div>
                  </div>
                  <div style={{background:a.avgResolutionDays<=2?"#f0fdf4":a.avgResolutionDays<=5?"#fffbeb":"#fef2f2",borderRadius:8,padding:"6px 10px"}}>
                    <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase"}}>Avg Resolve <BenchmarkBadge metric="avgResolutionDays" value={a.avgResolutionDays}/></div>
                    <div style={{fontSize:16,fontWeight:800,color:a.avgResolutionDays<=2?"#16a34a":a.avgResolutionDays<=5?"#d97706":"#dc2626"}}>{a.avgResolutionDays}d</div>
                  </div>
                </div>

                {/* Key metrics row */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:10,marginBottom:10}}>
                  {[
                    {label:"MRR",value:`$${(a.mrr/1000).toFixed(1)}K`,trend:null},
                    {label:"Denial Rate",value:`${a.denialRatePct}%`,trend:a.trends.denial,alert:a.denialRatePct>8},
                    {label:"Studies/Mo",value:a.studiesLastMonth,trend:a.trends.studies},
                  ].map(m=>(
                    <div key={m.label} style={{background:m.alert?"#fef2f2":"#f8fafc",borderRadius:8,padding:"6px 10px"}}>
                      <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase"}}>{m.label}{m.bench&&<BenchmarkBadge metric={m.bench} value={m.benchVal}/>}</div>
                      <div style={{fontSize:13,fontWeight:700,color:m.alert?"#dc2626":"#0f172a"}}>{m.value}{m.trend&&<span style={{marginLeft:4}}><TrendPill trend={m.trend}/></span>}</div>
                    </div>
                  ))}
                </div>

                {/* Risk drivers preview */}
                {h.drivers.length>0&&(
                  <div style={{background:"#fef2f2",borderRadius:8,padding:"7px 10px",marginBottom:10,border:"1px solid #fecaca"}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#dc2626",marginBottom:4}}>⚠ Top Risk Drivers</div>
                    {h.drivers.slice(0,2).map((d,i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#475569",marginBottom:2}}>
                        <span>{d.label}</span><span style={{fontWeight:700,color:"#dc2626"}}>{d.impact}pts</span>
                      </div>
                    ))}
                    {h.drivers.length>2&&<div style={{fontSize:10,color:"#94a3b8"}}>+{h.drivers.length-2} more risk factors</div>}
                  </div>
                )}

                {/* Risk + onboarding */}
                <div style={{display:"flex",gap:8,marginBottom:8,alignItems:"center"}}>
                  <span style={{fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:20,background:risk.bg,color:risk.color}}>{risk.label}</span>
                  <div style={{flex:1,height:5,background:"#e2e8f0",borderRadius:10,overflow:"hidden"}}>
                    <div style={{height:"100%",borderRadius:10,width:`${a.onboardingPct}%`,background:a.onboardingPct===100?"#22c55e":a.onboardingPct>60?"#f59e0b":"#ef4444"}}/>
                  </div>
                  <span style={{fontSize:10,color:"#94a3b8",whiteSpace:"nowrap"}}>{a.onboardingPct}%</span>
                </div>

                {/* Flags */}
                <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:10}}>
                  {a.flags.map(f=><span key={f} style={{fontSize:9,fontWeight:700,padding:"2px 7px",borderRadius:10,background:flagConfig[f]?.bg,color:flagConfig[f]?.color}}>{flagConfig[f]?.label}</span>)}
                </div>

                {/* Note */}
                <div style={{fontSize:11,color:"#64748b",lineHeight:1.55,background:"#f8fafc",borderRadius:8,padding:"7px 10px",marginBottom:12,borderLeft:"3px solid #e2e8f0"}}>
                  {a.notes.length>100?a.notes.slice(0,100)+"…":a.notes}
                </div>

                {/* Footer */}
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {a.interventionStory&&<button onClick={()=>setInterventionStory(a.interventionStory)} style={{flex:1,background:"#f0fdf4",color:"#16a34a",border:"1px solid #bbf7d0",borderRadius:10,padding:"7px 10px",fontSize:11,fontWeight:700,cursor:"pointer"}}>✓ Case Study</button>}
                  <button onClick={()=>setCopilotAccount(a)} style={{flex:2,background:"linear-gradient(135deg,#1e40af,#2563eb)",color:"#fff",border:"none",borderRadius:10,padding:"7px 14px",fontSize:11,fontWeight:700,cursor:"pointer",boxShadow:"0 2px 8px rgba(37,99,235,0.35)"}}>✦ AI Copilot</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {scoreAccount    && <ScoreExplainer account={scoreAccount} onClose={()=>setScoreAccount(null)}/>}
      {copilotAccount  && <CopilotModal account={copilotAccount} onClose={()=>setCopilotAccount(null)}/>}
      {interventionStory && <InterventionModal story={interventionStory} onClose={()=>setInterventionStory(null)}/>}
    </div>
  );
}
