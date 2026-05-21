# DiagRevIQ — Operational Risk Intelligence Platform

**A portfolio project demonstrating AI + Customer Success + Healthcare Data Science**

## What This Is

DiagRevIQ is a conceptual AI-assisted customer intelligence platform designed for a B2B SaaS company serving outpatient diagnostic testing centers (Radiology, Neurology, Physiatry, Cardiology, Nuclear Medicine).

It simulates what a real Customer Success team would use to monitor account health, predict churn, manage AR aging, and generate AI-powered insights on demand.

## Key Features

- **Multi-Layer Operational Risk Scoring** — 5 sub-scores (Financial, Operational, Adoption, Relationship, Support) combine into one composite score. Every signal traces back to a specific database table and SQL calculation.
- **AR Aging Dashboard** — Real-time visualization of accounts receivable across 0-30, 31-60, 61-90, and 90+ day buckets with collection velocity metrics
- **AI Copilot** — Live Claude API integration generates account-specific executive narratives, churn prevention playbooks, AR recovery plans, upsell emails, and QBR agendas
- **Trend Intelligence** — ↑ ↓ ↔ indicators on every key metric showing trajectory, not just point-in-time values
- **Industry Benchmarks** — Denial rates and resolution times compared against MGMA, HFMA, and HIMSS published benchmarks
- **Risk Driver Analysis** — Explainable AI showing exactly which factors are dragging each account's score down, with full data lineage
- **Intervention Case Study** — Full before/after story showing how CSM intervention rescued a near-churn account

## Data Architecture

All signals trace to conceptual database tables:

| Signal | Source Table | Field |
|---|---|---|
| Claim Denial Rate | `claims` | `status = 'denied'` |
| AR Aging | `accounts_receivable` | `balance, aging_days` |
| Study Volume | `orders` | `COUNT(order_id)` |
| Feature Adoption | `feature_adoption` | `activated_at` |
| Active Users | `user_sessions` | `last_login` |
| Open Tickets | `support_tickets` | `status = 'open'` |
| Executive Engagement | `meeting_log` | `contact_level = 'executive'` |
| NPS Score | `nps_responses` | `AVG(score)` |
| Manual Overrides | `billing_events` | `event_type = 'manual_override'` |
| Prior Auth Denials | `prior_authorizations` | `status = 'denied'` |

## Tech Stack

- React 18
- Claude API (claude-sonnet-4-20250514) for AI Copilot
- No backend — all data is synthetic/conceptual
- Deployed on Vercel

## Skills Demonstrated

- B2B SaaS Customer Success strategy and tooling
- Healthcare revenue cycle domain knowledge
- AI/LLM integration (prompt engineering, context injection)
- Data science (weighted scoring models, signal normalization)
- React component architecture
- Product thinking for healthcare operations

## About

Built by Suzy Thompson as a portfolio project targeting AI-enabled Customer Success Manager roles in healthcare SaaS.

Connect: [www.linkedin.com/in/suzy-t-36223926a]
