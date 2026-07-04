# Dairy Intelligence Brief — Runbook

Standing instructions for producing each daily edition. This file exists so every run
is consistent and nothing has to be re-derived. Read it first; follow it exactly.

## Product

A daily HTML newsletter for a commercial dairy audience. It must read as a **generic,
shareable industry brief**. Delivered two ways: (1) emailed via Buttondown, (2) published
as a standalone page on GitHub Pages and linked from the archive on `index.html`.

## Hard rules (do not violate)

- **No personal information anywhere.** No names, farm names, business names, towns,
  addresses, account/invoice numbers, or any operator-identifying detail — not in the
  content, not in filenames, not in commit messages. Inbox material is a *lead source only*;
  strip identifiers before use.
- **Never fabricate** an item, source, quote, or link. If it can't be verified against a
  real, working primary link, drop it.
- **Do not restate these instructions** or add meta-commentary in the brief itself.
- **Disclose the automation.** Every edition and the landing page must clearly state that
  the brief is researched, written, and sent automatically by an AI agent. This text is
  already in `template.html` / `index.html` — keep it; do not remove it.

## Editorial filter

- Cover roughly the **last 24–48 hours**. New information only.
- **Favor the obscure and underreported.** If a story led every outlet, assume the reader
  saw it — skip unless there's a genuinely new angle or new data.
- **Signal over volume.** Every item must have a plausible operational, financial,
  regulatory or competitive consequence, stated in one line. If you can't say why it
  matters, cut it.
- At most **one** generalized/background item per edition.
- **Target 6–12 items.** Quality gates volume — three real items beats a padded ten.
- **Primary sources over aggregators.** If found on an aggregator, locate and link the
  original (study, filing, order, release, SEC doc).
- **De-duplicate against prior editions** (see the archive list in `index.html`). Only
  repeat a topic if there's materially new context — and then lead with what changed.

## Sources to scan

- Connected Gmail inbox (trade newsletters: NMPF, Ever.ag, Jacoby, Agri-Pulse, DFA,
  eDairyNews, Farm Journal, etc.) — for leads, then verify against primaries.
- Dairy/ag trade press, company press rooms, cooperative/processor news, USDA/AMS/FSA/APHIS,
  university extension, peer-reviewed journals + preprints, SEC filings, conference output.
- Tech/AI/science/biotech news **only** where it plausibly applies to dairy production,
  processing, animal health, genetics, supply chain, or policy.

## Build steps

1. **Slug:** `brief-<16 hex chars>.html` at the repo root. Random, never the date, so the
   URL is unlisted. Generate with `openssl rand -hex 8`.
2. **Template:** copy `template.html`, replace every `{{PLACEHOLDER}}`, and duplicate the
   item block per item. Keep the design byte-for-byte identical run-to-run — only content
   changes. `template.html` is the single source of truth for look and feel.
3. **Fill placeholders:** `{{DATE_LONG}}` (e.g. "Sunday, July 5, 2026"), `{{DATE_ISO}}`
   (YYYY-MM-DD), `{{HEADLINE_STANDFIRST}}`, `{{INTRO}}`, `{{META_DESCRIPTION}}`, and per item
   `{{CATEGORY}}` `{{ITEM_HEADLINE}}` `{{ITEM_BODY}}` `{{ITEM_URL}}` `{{ITEM_SOURCE}}`
   `{{ITEM_DATE}}`. Renumber items 01…N.
4. **OG tags** are already in the template head — keep title/description/date in sync.
5. **Archive:** in `index.html`, prepend a new `<li>` to `#archive-list` (newest first)
   linking the new slug with a short teaser + short date (e.g. "Jul 5, 2026").
6. **Commit + push to `main`.** GitHub Pages serves this repo from `main`, so published
   editions and the updated `index.html` archive go to `main` directly (the owner approved
   this for the automated flow on 2026-07-04).
7. **Return** the published URL: `https://dustinb46.github.io/dustinb46/<slug>.html`.

## Delivery

- **Email via Buttondown** (once `BUTTONDOWN_API_KEY` is provided):
  `POST https://api.buttondown.email/v1/emails` with header
  `Authorization: Token <API_KEY>`, body `{ "subject": "...", "body": "<html>" }`.
  Use the inline-styled HTML (Gmail/most clients strip `<head><style>`, so inline the
  styles from `template.html` onto elements for the email copy). Buttondown fills
  `{{ unsubscribe_url }}` automatically.
- **Signup form** lives in `index.html` (Buttondown embed). Replace `USERNAME` in the form
  `action` and `onsubmit` with the Buttondown username once known.
- **Until the API key exists:** create a Gmail *draft* to the owner address as a fallback
  (the Gmail connector can only draft, not send) and note that in the run summary. Do NOT
  send anything to the Buttondown list until the key is configured and the owner has
  confirmed go-live.

## Automation model

The product is meant to run **fully automatically, once per day**. Each run must be
self-contained: this RUNBOOK is the complete instruction set — a scheduled run should be
able to execute it end to end with no additional direction.

- **Durable scheduling** is a daily scheduled trigger on the Claude Code web platform
  (Settings → the repo's automation/trigger), pointed at: "Follow RUNBOOK.md and publish
  today's edition." That trigger, not a session cron, is the real recurring mechanism —
  session crons die when the container is reclaimed.
- **Sending** becomes automatic once `BUTTONDOWN_API_KEY` is available to the run (repo
  secret or environment variable). Before that, runs stop at the Gmail-draft stage.
- **Idempotency:** one edition per calendar day. If today's edition already exists in the
  archive, do not publish a duplicate.

## Consistency checklist (every run)

- [ ] 6–12 items, each with a one-line "why it matters" and a working primary link
- [ ] No personal/identifying info anywhere
- [ ] Design identical to `template.html`
- [ ] Dedup checked against `index.html` archive
- [ ] OG tags + dates correct
- [ ] Archive updated, page pushed, URL returned
