# HOA service homepage

Owner-approved offering and page scope, 2026-11-04; account-authorization model updated 2026-11-07.

WillingLink is FretGone’s service for making owner-run, self-managed HOAs easier to operate. The owner’s stated direction is to help communities move beyond high management fees and make self-management easier. The offer is performed back-office work rather than a new software account. Owners keep using SMS/email. The board grants account authorization to ChatGPT, not FretGone. FretGone helps the board get the workflow set up, then keeps the day-to-day work running; the AI agent works through the accounts the board authorizes. The service collects owner views, seeks mutually acceptable proposals, documents disagreement, and follows through within granted authority. The owner’s reason is to support direct owner participation while relieving board members of routine work and pressure. The board retains oversight and responsibility.

One board member can begin with an approximately ten-minute setup conversation. Actual channel authorization and compatibility must be confirmed. The proposed workflow uses a board-readable Notion journal without reader signup and a browser agent on a designated board computer, with phone review for sensitive actions. This page is a service offer, not evidence that these integrations have been built in this repository.

Pricing (updated 2026-11-09): One monthly HOA payment of USD 20 for up to and including 20 owners, plus USD 1 per month for each additional owner. Individual owners do not pay separately; first month free. Prior rate displays and examples are superseded. The existing capacity limit of fewer than 1,000 homes remains. All contact CTAs use mailto:contact@fretgone.com; they open the visitor’s email client and do not send email automatically.

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


## v1 baseline and explanatory detail pass — 2026-11-05

Owner approved the sharp copy as the conversational “v1” and asked for the full text, then requested that explanatory sections actually explain rather than advertise. The complete v1 text, including expanded answers, controls, accessibility text, and metadata, is preserved in docs/HOMEPAGE_COPY_V1.md; source commit 2ef6362 remains the baseline.

Preserve the approved hero, accountability, and closing headlines and existing imagery. Rewrite the body in a connected sequence: owners contact the board as usual; authorization lets the service handle those channels; gather views; discuss and revise proposals; document unresolved differences; execute within permissions; send sensitive actions for phone approval; expose the work in the board journal. Setup and FAQs explain who does what and where, including the available board computer, journal tasks, existing tools, and archive limitations. Contact buttons now describe opening a conversation rather than implying an immediate trial signup. No new product capability or runtime behavior is introduced.

Validation: complete copy diff reviewed against the original service description; 214 offline checks passed. TypeScript retains the existing speech-input.tsx:55/56 TS2717 errors. Actual homepage component and CSS rendered at 390px and desktop without horizontal overflow; expanded existing-tools answer verified. Image, styles, prices, and routes unchanged.


## Faithful record wording — 2026-11-06

Owner clarified that the public message should describe faithful, complete records preserved without deletion, allowing readers to infer that decisions and their outcomes remain visible. Do not explicitly foreground mistakes. Public heading: “Every step. Kept on record.” Supporting copy names conversations, decisions, actions, and outcomes as events happen, and explains that new entries add to history while earlier entries stay. This is the service’s recordkeeping commitment; existing archive verification limitations remain and no immutable implementation is claimed. Owner-deleted docs/HOMEPAGE_COPY_V1.md is not restored or included in this change.


## Everyday wording — 2026-11-07

Owner approved “We help neighbors work things out.” over the formal agreement wording and abstract common-ground wording. Supporting copy now uses talking through ideas and keeping a record where views differ. Owner also found “You should get to enjoy it” too directive; closing now reads “You live here. More time to enjoy it.” Static copy only; no service scope or behavior changes.


## Remove the generic closing panel — 2026-11-07

Owner rejected the softened closing as a loss of the sharp, distinctive style and explicitly allowed deleting it after reviewing the whole page. The page already presents its position, pricing, service steps, setup, recordkeeping, and questions. Remove the entire redundant lifestyle-ad closing panel and its unused styles; end after records/questions and the existing footer. Preserve the approved main headline and everyday neighbor-discussion wording. Existing header, hero, pricing, setup, question, and footer email links remain. No runtime changes.


## Restore the shared-plan meaning — 2026-11-07

Owner found the generic neighbor-help wording too vague: the essential meaning is working toward a specific plan all owners can accept. Owner approved “A plan everyone can live with.” and the explanation “We discuss ideas with owners and revise the plan until everyone can accept it—or record where and why people still disagree.” Apply this exact approved text. No promise of guaranteed consensus or runtime change.


## Account authorization goes to ChatGPT or Claude — 2026-11-07

Owner explicitly changed the business model: SMS/email account authorization is granted to ChatGPT or Claude, not to the service provider. Update the current offer above and all affected homepage copy: search/sharing descriptions, hero, gathering views, proposal discussion, approved work, setup, service-scope answer, existing tools, and data-handling explanation. Add a direct question explaining the recipient of account authorization. FretGone configures and coordinates the service; the board grants access to its chosen AI tool and retains approval control.

Do not infer from this change that FretGone never receives any data, that no provider processes messages, or that the chosen tools have universal compatibility. Existing compatibility and permission confirmation remains. This change updates the static service description only; it does not implement or modify credentials, OAuth, message routing, backend authorization, Twilio behavior, or the separate rental-alert program described by the existing legal pages. No reason for the business-model change was supplied; none is invented.

Validation: full homepage copy and metadata reviewed for the recipient of account authorization. 214 offline checks passed; diff whitespace check passed. TypeScript retains only the existing speech-input.tsx:55/56 TS2717 errors. No account authorization or backend code changed.


## Setup assistance — 2026-11-07

Owner clarified that FretGone helps the board get configuration completed, rather than personally configuring the accounts. Public copy now says “helps your board get set up” and “helps your board get the workflow set up”; the setup explanation also explicitly says we help the board get configuration completed. Account authorization still belongs to the board and is granted to ChatGPT or Claude. Static wording only.


## Brand wordmarks — 2026-11-07

Owner clarified that WillingLink is the public brand; FretGone is the company name. Change the header and footer wordmarks to exact “WillingLink”, and align the homepage title, sharing title, home-link accessibility name, and product account reference. Keep FretGone LLC in copyright and contact@fretgone.com as the contact address. No runtime or link-destination changes.


## Ongoing operation — 2026-11-07

Owner clarified that “coordinates the work” understates sustained operation and sounds like a one-off action. Hero and sharing copy now say “helps your board get set up, then keeps the day-to-day work running.” The service answer explains the continuing workflow of owner conversations, proposals, records, and authorized tasks. Search description calls this ongoing HOA support. Do not infer a guaranteed uptime level or around-the-clock availability; no runtime change.


## Restore editorial purpose instead of translating mechanics — 2026-11-07

Owner rejected the literal setup-then-operation line as mechanical and asked for the whole conversation’s editorial intent to guide the page. Keep the approved sharp headline and page design. The hero now names the delegated work and connects it to the human cost of volunteer labor: “We take on the conversations, proposals, and follow-through—so your HOA can run without running your board into the ground.” This develops the self-governance/self-sacrifice position instead of using onboarding mechanics as the sales lead.

The service-scope answer explains ongoing work concretely: incoming messages, proposals, records, and approved tasks as new work arrives. Account authorization to ChatGPT or Claude, setup assistance, board approval, record preservation, prices, and contact details remain in the explanatory sections. Metadata follows the new editorial lead. This does not introduce uptime guarantees or change product behavior.


## Plain work-log wording and browser execution history — 2026-11-07

Owner approved the full-history explanation and explicitly requested browser execution records. The records introduction now names what people said, what was decided, what the agent did in the browser, and what happened next, ending “Nothing is deleted.” This describes the service’s recordkeeping commitment, not proof of an immutable implementation. Replace public “journal” references with “work log”; the access question becomes “Who can see the work log?” Its answer explains the board-readable Notion page, including discussions, decisions, and browser actions, with no Notion signup and no sharing of private owner messages with other owners. Setup and agent-task descriptions use the same term. No backend logging or data-retention behavior is changed.


## Existing tools stay; two additions only — 2026-11-07

Owner clarified the answer to keeping existing tools is yes: the board keeps everything it already uses unchanged. The service adds only a ChatGPT or Claude browser extension and WillingLink to handle incoming owner SMS/email. No migration or replacement tools. Rewrite the existing-tools answer to lead with this direct explanation; align setup and service-scope copy, removing wording that suggests changing or rebuilding the existing stack. Keep the board’s authorization to ChatGPT or Claude and approval limits. This is the owner’s service model, not a new integration implementation or a claim that every integration was tested. No reason for this boundary was supplied; none is invented.


## Owner-count pricing — 2026-11-09

Owner replaced the fixed community-size tiers with USD 1 per owner per month and authorized supporting marketing copy. Lead with the unit price in the hero and pricing strip; explain that the HOA’s owner count determines the price, and give a concrete example: “Example: 100 owners, $100/month.” Keep the first month free and prior capacity boundary. Search and sharing descriptions use the new rate. Do not substitute homes, households, signups, or active users for owners, or invent billing mechanics, minimum fees, or new eligibility rules. Static display only; no payment calculation, subscription, or backend changes.


## One HOA payment, owner count sets the amount — 2026-11-09

Owner clarified that the per-owner price must not look like each owner pays the provider separately. Lead the hero price line with “One HOA. One monthly payment.” The pricing area states the HOA pays, the owner count determines the rate, and owners do not pay individually. The example explicitly identifies the payer: “100 owners? Your HOA pays $100/month.” Search and sharing descriptions say one monthly HOA payment calculated at USD 1 per owner. Keep the first month free and capacity limit. Static explanation only; no billing system or collection flow is implemented.


## Strengthen the self-managed HOA position — 2026-11-09

Owner asked to review the whole page with greater emphasis on owner self-management: avoid high management fees and make self-managed HOAs easier. Preserve the approved “Self-governance. Without the self-sacrifice.” hero headline, the shared-plan and work-record language, existing image and layout, and the new unified HOA payment clarification.

The hero audience label now names self-managed HOAs; its paragraph explains owner control, delegated conversations/proposals/daily follow-through, and self-management as a practical alternative to high management fees. Search/sharing titles and descriptions, navigation, process introduction, and service-scope answer follow the same position. Process copy explains owner participation, a shared plan, and board-approved execution; use plain “AI” consistently. Setup continues to explain just two additions and no replacement of existing tools.

Do not suggest HOA dues, reserves, maintenance costs, or every management obligation disappear; do not invent quantified savings, guaranteed replacement of every professional service, or removal of board responsibilities. The offer remains USD 1 per owner per month paid together by the HOA, with the first month free and the existing capacity limit. No runtime or payment implementation changes.


## Compact minimum-price explanation — 2026-11-09

Owner rejected the prior price presentation and requested a single line of small text: USD 20/month for up to 20 owners, then USD 1/month for each additional owner. Replace the large unit-price display and example with that compact line, explicitly paid once by the HOA. Exactly 20 owners costs USD 20/month; 21 owners costs USD 21/month. Remove the large pricing strip, example, redundant payment slogan, and extra pricing CTA. Replace them with one small-text paragraph below the hero: “Your HOA’s monthly total: $20 for up to 20 owners, plus $1 for each additional owner.” It can wrap naturally on narrow screens. Keep first month free in the existing hero/header copy; move the capacity note into the service-scope answer. Preserve the rest of the approved self-management copy. Search and sharing descriptions use the same pricing. Static display only.


## Self-management headline and direct mission — 2026-11-09

Owner explicitly changed the hero’s first line from “Self-governance.” to “Self-management.” and replaced the owner-run opening with the mission of helping customers move beyond property management companies and making self-management easier. Public hero and sharing description now say “WillingLink helps you move beyond property management companies and makes self-management easier.” Preserve “Without the self-sacrifice.” and the approved compact HOA payment note. No new service scope or runtime behavior.


## Preserve the paragraph when replacing its opening — 2026-11-09

Owner clarified the previous instruction targeted only “Your HOA, run by its owners.” The replacement wrongly removed the rest of the paragraph. Restore the original following sentence about owner conversations, proposals, and daily follow-through as a practical alternative to high management fees. Keep the new WillingLink mission opening and the separately requested “Self-management.” heading. Also restore the corresponding omitted service sentence in the sharing description. No other page content changes.


## Reference-led price band with gold underline — 2026-11-09

Owner supplied a reference and requested its yellow underline and bottom pricing-bar treatment, with placement left to design judgment. This supersedes the earlier small-text-only presentation. Place a deep-teal band immediately below the hero, anchoring the hero image and the following service explanation. Underline the selectable USD 20 amount with a small decorative gold SVG brush curve; pair it with “/month per HOA” and “Up to 20 owners.” The second column explains +USD 1/month per additional owner and one HOA payment, with the first month free. Stack the columns on narrow screens. The screenshot’s old USD 200/500 prices, logo, photo, and headline are not copied. Existing approved copy, imagery, account authorization, and fee rules remain. No runtime or payment logic changes.

Validation: actual homepage component and stylesheet rendered for visual review. Desktop 1280px and mobile 390px/320px had no horizontal overflow; gold underline, amount, owner limit, additional-owner rate, and HOA payer checked. Screenshot saved as gold-price-band.png in the session visualization folder. 214 offline checks passed; tsc retains only existing speech-input.tsx:55/56 TS2717 errors; diff whitespace check passed. This is a static homepage preview, not a full application end-to-end run.


## ChatGPT-only offering — 2026-11-09

Owner decided to offer only ChatGPT and requested removing Claude references from the entire homepage. Replace the provider choice in process, setup, authorization, service-scope, and existing-tools explanations with ChatGPT. Current offering summary updated; historical entries remain historical. No reason for choosing ChatGPT only was supplied. This changes static service descriptions, not backend models or integrations.


## First-viewport pricing and shorter introduction — 2026-11-09

Owner requested removing the hero signup/free-month note, the ten-minute setup heading, the second promotional hero sentence, and “One payment from your HOA.” Preserve the mission opening, setup explanation, and free-month offer elsewhere. Move the gold-underlined pricing band into the hero so desktop pricing overlays the photograph within the first viewport. On mobile, place pricing immediately after the introduction and before the photograph. Pricing rules and service behavior remain unchanged.


## Visual explanation of the price — 2026-11-09

Owner removed the self-managed HOA eyebrow and asked for visual communication of the pricing boundary. Group 1–20 included owners beneath the base price; connect one additional owner to one additional monthly dollar. Three aligned example cards show 10 owners/$20, 20 owners/$20, and 50 owners/$50 as HOA monthly totals. Preserve first-viewport placement and the gold price underline. Static examples only; no calculator or billing behavior.


## Restore the earlier price band — 2026-11-09

Owner rejected the visual pricing examples and requested reverting. Restore the preceding two-column price band: $20/month per HOA, Up to 20 owners, +$1/month for each additional owner, and First month free. Keep the requested removal of the FOR SELF-MANAGED HOAS eyebrow. Gold underline and first-viewport placement remain.


## US HOA wording pass — 2026-11-11

Owner authorized the whole-page wording revision following the terminology review. Use homeowners for people and homes for community size and the displayed pricing basis: $20/month per HOA for up to 20 homes, plus $1/month per additional home. This supersedes owner-person-count language in prior entries. Preserve the approved headline, shared-plan heading, record promise, layout, first month free, and fewer-than-1,000-home capacity. Use management company, payments/purchases, and approve/decline. Explain access and archival review in plain language and name ChatGPT directly. Setup remains assistance, authorization goes to ChatGPT, and privacy/archival limitations remain explicit. Static offer/copy change only; no billing or account-access implementation.
