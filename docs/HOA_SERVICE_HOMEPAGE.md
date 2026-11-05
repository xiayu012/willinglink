# HOA service homepage

Owner-approved offering and page scope, 2026-11-04.

FretGone sells HOA back-office work rather than a new software account. Owners keep using SMS/email; the board authorizes the channels and work. The service collects owner views, seeks mutually acceptable proposals, documents disagreement, and follows through within granted authority. The owner’s reason is to support direct owner participation while relieving board members of routine work and pressure. The board retains oversight and responsibility.

One board member can begin with an approximately ten-minute setup conversation. Actual channel authorization and compatibility must be confirmed. The proposed workflow uses a board-readable Notion journal without reader signup and a browser agent on a designated board computer, with phone review for sensitive actions. This page is a service offer, not evidence that these integrations have been built in this repository.

Pricing: first month free; under 500 homes USD 200/month for the whole HOA; 500–999 homes USD 500/month; 1,000+ homes currently not served. All contact CTAs use mailto:contact@fretgone.com; they open the visitor’s email client and do not send email automatically.

Privacy and security: intended board-only records and private homeowner communications; agree on access/retention during setup. AWS-backed tamper-evident archiving is an option to confirm, not an implemented immutable Notion guarantee. Browser safeguards, approval delivery, availability, and data flows require verification in the selected tools. Do not promise no leaks, no third-party processing, universal consensus, or elimination of board responsibility.

## Routes and restoration

- New public service homepage: app/page.tsx at `/`, styled by app/home.module.css, outside the chat layout.
- Original homepage preserved verbatim: app/(chat)/legacy-home/page.tsx at `/legacy-home`, with the existing chat layout and guest authentication behavior.
- Exact public page bypass: `/`, `/about`, `/privacy`, `/terms`. API authentication unchanged.
- To restore: move the new app/page.tsx aside or remove its route, move app/(chat)/legacy-home/page.tsx back to app/(chat)/page.tsx, and remove `/` from the static public bypass so the old guest-auth flow applies again. Only one page may own `/`.

Static design and minimal homepage routing are authorized for direct Codex implementation under the revised AGENTS.md. No backend feature, database, paid model evaluation, or real messaging is part of this change.

## Commercial redesign — 2026-11-04

Owner feedback: the initial editorial design felt academic, too wordy, and visually inconsistent. Reference research used the official PayHOA, Vantaca, and TownSq homepages for their outcome-led headline, prominent contact action, workflow illustration, and clear section sequence. No vendor assets, customer claims, or endorsements were copied.

The replacement uses a consistent sans-serif system, navy/cobalt/lime palette, aligned service cards, compact pricing, and four collapsed FAQs. JSX text reduced from approximately 940 words to 521 (including collapsed content). Prices, first free month, email-only contact, and the preserved original homepage remain unchanged.

Verification: 214 offline quality checks passed; TypeScript reports only the existing speech-input.tsx:55/56 TS2717 conflicts. The full Next development server ran out of memory on this computer. Visual and interaction checks therefore used a lightweight static render of the actual homepage component with its stylesheet, without application services: desktop plus 390px mobile, no horizontal overflow, eight mailto contact links, and FAQ expansion. This verifies the static design, not a full application/browser end-to-end run. A heading specificity issue found during visual review was corrected.
