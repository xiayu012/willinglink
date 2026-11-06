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

## Selected concept implementation — 2026-11-05

Owner selected the second revised image: a homeowner opening her own garden gate, expressing agency, dignity, and quiet contentment rather than a meeting. The owner asked for implementation, stronger commercial copy, and deployment. The homepage now leads with “A community you shape. A place that feels yours.” and explains that owners participate while the service takes on coordination. No dashboard or meeting scene is used. The existing legacy homepage is unchanged.

The hero is a real responsive HTML layout with a separate text-free generated photo, not a screenshot of a webpage. Desktop uses a warm cream veil over the left of the photo; mobile separates readable text and the full photo region. The 1536×1024 WebP is 359,352 bytes; Next Image prioritizes the hero and serves responsive sizes. Copy, buttons, pricing, FAQs, and links remain actual selectable/accessible HTML. No new dependencies, backend behavior, or database changes.

Asset: public/images/community-open-gate.webp. Built-in image_gen edited the owner-selected preview (exec-9db9678c-7b05-4ec6-9dcd-d96da8550ded.png); the raw result is exec-095465de-b65f-4114-ab24-42f36a4a502c.png in the session generated_images directory. Format-only WebP compression used the installed Sharp dependency.

Asset prompt: “Production hero photograph only. Preserve the warm golden-light scene and a woman seen from behind gently opening both wooden gate leaves with relaxed outstretched arms, with a path into a blooming modest neighborhood and residents independently enjoying daily life. Remove all logo, typography, UI, cream panels, and pricing strip; fill naturally with continuous photographic garden. Keep woman right, head/hands/gate visible, left side softly focused garden. No baked-in overlay, meetings, or group gathering.”

Validation: 214 offline quality checks passed. tsc reports only the pre-existing speech-input.tsx lines 55/56 TS2717 conflicts. Diff whitespace check passed. Homepage-only rendering of the actual component and stylesheet verified desktop, 390px and 320px widths, hero image load, nine mailto contact paths, FAQ expansion, and pricing anchor; no horizontal overflow. Full-app local preview is avoided because the previous attempt exhausted this computer's memory. Production deployment is verified separately after pushing the accepted commit.


## Copy rewrite — 2026-11-05

Owner abandoned the stock-photo search and explicitly retained the current generated image. Requested concise, readable copy with a clear point of view: owner power, actual delegated work, innovation, and transparency instead of generic commercial filler. Image, styles, pricing, routes, and contact behavior are unchanged.

The new narrative leads with “Your community. Your say. We do the work.” and “The work changes hands. The power stays yours.” Participation must lead beyond an inbox; disagreement is documented rather than presented as consensus. “Transparency includes us” makes the service itself accountable to the board through the journal. The copy explains the service in everyday language and keeps setup details and limitations in short expandable answers. It does not claim universal agreement, bypass voting rules, remove board responsibilities, or guarantee immutable records or absolute privacy. Integrations and archive protection remain subject to setup verification.

Validation: independent review of the full copy diff against the original service description; 214 offline quality checks passed; diff whitespace check passed. Homepage-only browser rendering of the actual component and existing stylesheet checked desktop and 390px mobile: readable heading, no horizontal overflow, and nine mailto links to the specified address. No image or backend changes. TypeScript status is recorded in the delivery report.


## Sharper, shorter copy — 2026-11-05

Owner rejected the prior rewrite as generic, padded, and forgettable. The new lead connects self-government with the cost of volunteer sacrifice: “Self-governance. Without the self-sacrifice.” The service explanation names daily work, text/email participation, agreement, and carrying out approved decisions. Price appears in the hero. Four decorative slogans and the repeated service introduction were removed; JSX text falls from 545 to 402 words (including collapsed answers).

Accountability now makes a concrete ethical commitment: “Our mistakes belong in the record.” The supporting sentence includes problems and unfinished work, without claiming an immutable system has been implemented. Approval, voting responsibilities, compatibility checks, and archive limitations remain explicit in the concise answers. Images, pricing tiers, routes, and mailto behavior are unchanged. Minimal heading styles keep “self-sacrifice” together and scale the headline for narrow phones.

Validation: full copy and stylesheet diff reviewed against the owner’s service description. Desktop, 390px, and 320px browser checks found no horizontal overflow; heading wrapping checked visually. Nine contact links retain mailto:contact@fretgone.com. 214 offline quality checks passed; tsc retains only the pre-existing speech-input.tsx:55/56 TS2717 errors. No backend or image changes.
