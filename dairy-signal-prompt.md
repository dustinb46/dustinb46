# The Dairy Signal — recurring newsletter generation prompt

Paste the prompt below into a **scheduled session** (Claude Code on the web →
Automations / scheduled trigger, set to run daily) to auto-generate the next
edition. It requires the **Gmail** connector enabled (for inbox scan + draft
creation) and **web search**.

Docs: https://code.claude.com/docs/en/claude-code-on-the-web

---

## Prompt

Generate the next edition of "The Dairy Signal" — an off-the-front-page news
digest for a dairy farmer — and save it as a Gmail draft to
brunndairy88@gmail.com.

1. **Dedupe:** Search Gmail (sent + drafts) for subjects "The Dairy Signal" and
   "Dairy Brief". Read the most recent editions and build a list of every item
   already covered. Do not repeat an item unless there is genuinely new context.
2. **Gather:** Scan the Gmail newsletter inbox from the last few days
   (category:updates/promotions; senders incl. Hoard's, NMPF, Ever.ag, Dairy
   Global, eDairyNews, DFA, Farm Journal, Agri-Pulse, Jacoby). Run fresh web
   searches across: markets & trade, plants & payrolls (closures / openings /
   hires / M&A), data & research, animal health, biotech, tech & AI.
3. **Recency filter:** Favor the most RECENT items (last 24–72h) and the obscure
   over front-page headlines. Verify each item's date; discard anything stale
   (older than ~2 weeks unless it's a genuinely new development).
4. **Select:** ~7 NEW, deduplicated items, each in a distinct category, each with
   a direct source link inline. Include exactly ONE generalized "Wider Lens"
   item — no more.
5. **Keep generic:** Masthead "The Dairy Signal". No personal name or location.
   Increment the edition/issue number from the last edition and set today's date.
6. **Design:** Reuse the established HTML layout — cream background, dark-green
   masthead band, "In This Issue" strip, color-coded left-border section cards
   (red = closures/health, green/gold = markets/data/feed, blue = tech/biotech),
   and a dark-green "Wider Lens" card. Footer: "Compiled from public reporting
   and newsletter inboxes · Edition N".
7. **Output:** Create the Gmail draft with BOTH an htmlBody and a plaintext body.
   Do not include these instructions anywhere in the newsletter content.

## Edition log (update each run to aid dedupe)

- **Vol. 1 No. 1 (Jun 6, 2026):** Arla–DMK merger/whey line; 3 processor closures
  (Guida's, Maola, Danone Silk); USDA 2026 milk outlook +3.7B lbs; phytogenics vs
  monensin + tannins; AI vision cameras / Halter; precision-fermentation funding
  (Verley, Standing Ovation, AuX); screwworm first U.S. case; NZ downturn (wider lens).
- **Vol. 1 No. 2 (Jun 8, 2026):** Screwworm 2nd case + Abbott statewide disaster
  declaration; Idaho raw-milk Campylobacter outbreak; GDT Event 405 (Jun 2) price
  split; MMPA $122M Remus/cottage-cheese acquisition; MSU high-oleic soybeans;
  U. Nebraska broad-spectrum H5N1 vaccine; precision feeding + wearable biosensors;
  2026 global milk glut (wider lens).
