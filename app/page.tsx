import type { Metadata } from "next";
import Image from "next/image";
import { ArrowRight, ArrowUpRight, ChevronDown } from "lucide-react";
import styles from "./home.module.css";

export const metadata: Metadata = {
  title: "WillingLink — Free HOA IDR & ADR",
  description:
    "Free IDR and ADR support for homeowners and HOA boards. Ongoing HOA mediation, homeowner feedback, and shared decision-making for $1 per unit per month.",
  openGraph: {
    title: "WillingLink — Free HOA IDR & ADR",
    description:
      "Free IDR and ADR support for homeowners and HOA boards. Ongoing HOA coordination is available separately for $1 per unit per month.",
    images: [
      {
        url: "/images/community-open-gate.webp",
        width: 1536,
        height: 1024,
        alt: "A homeowner opening a garden gate into her neighborhood.",
      },
    ],
  },
};
const email =
  "mailto:contact@fretgone.com?subject=Free%20IDR%20%2F%20ADR%20inquiry";

export default function Home() {
  return (
    <div className={styles.site}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="WillingLink home">
          WillingLink<span>.</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="/careers">Careers</a>
        </nav>
        <a className={styles.headerCta} href={email}>
          Get in touch <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      </header>
      <main id="main" className={styles.services} aria-label="Our two services">
        <section
          id="resolution"
          className={styles.freeService}
          aria-labelledby="hero-title"
        >
          <div className={styles.freeServiceContent}>
            <p className={styles.servicePrice}>Free</p>
            <h1 id="hero-title">IDR &amp; ADR.</h1>
            <p className={styles.serviceDescription}>
              We provide free internal dispute resolution (IDR) and
              mediation-based alternative dispute resolution (ADR) for
              homeowners and HOA boards.
            </p>
            <div className={styles.freeActions}>
              <a className={styles.serviceButton} href={email}>
                Start <ArrowRight size={18} aria-hidden="true" />
              </a>
              <details className={styles.resolutionSteps}>
                <summary>
                  Detailed steps <ChevronDown size={15} aria-hidden="true" />
                </summary>
                <div className={styles.stepsContent}>
                  <p className={styles.stepsIntro}>
                    Start by emailing us about the dispute. IDR and ADR are
                    separate procedures; the applicable path depends on the
                    dispute.
                  </p>
                  <h3>IDR — HOA/member disputes</h3>
                  <p>
                    Follow your HOA’s compliant IDR policy. Otherwise, §5915
                    applies.
                  </p>
                  <ol>
                    <li>
                      Request IDR in writing. The HOA must participate when a
                      member requests it; a member may decline the HOA’s
                      request.
                    </li>
                    <li>
                      Under §5915, meet promptly with a board-designated
                      director at a mutually convenient time and place. Explain
                      both positions and confer in good faith.
                    </li>
                    <li>
                      Put any agreement in writing, signed by both parties. It
                      must comply with law and governing documents, and fall
                      within the director’s authority or receive board
                      ratification.
                    </li>
                  </ol>
                  <h3>ADR — covered pre-lawsuit disputes</h3>
                  <ol>
                    <li>
                      For disputes covered by §5930, serve every other party a
                      Request for Resolution: dispute description, ADR request,
                      and 30-day response/rejection notice. Include Article 3
                      when serving a member. Use personal delivery, first-class
                      mail, or another method reasonably calculated to give
                      actual notice.
                    </li>
                    <li>Allow 30 days to accept. Silence means rejection.</li>
                    <li>
                      If accepted, agree on mediation and complete ADR within 90
                      days after acceptance reaches the requester, unless both
                      parties sign an extension. Settlement is voluntary.
                    </li>
                  </ol>
                  <p className={styles.stepsScope}>
                    Small-claims cases are excluded; assessment disputes are
                    generally excluded. A covered lawsuit requires the §5950
                    certificate.
                  </p>
                  <p className={styles.stepsScope}>
                    Emailing WillingLink alone does not serve the required
                    request. Our one-use offer does not limit statutory IDR
                    rights: the HOA cannot charge a member to participate in
                    IDR.
                  </p>
                  <p className={styles.stepsSources}>
                    California Civil Code:{" "}
                    <a
                      href="https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=CIV&amp;division=4.&amp;title=&amp;part=5.&amp;chapter=10.&amp;article=2."
                      target="_blank"
                      rel="noreferrer"
                    >
                      §§5900–5915
                    </a>{" "}
                    ·{" "}
                    <a
                      href="https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=CIV&amp;division=4.&amp;title=&amp;part=5.&amp;chapter=10.&amp;article=3."
                      target="_blank"
                      rel="noreferrer"
                    >
                      §§5925–5950
                    </a>{" "}
                    ·{" "}
                    <a
                      href="https://dre.ca.gov/files/pdf/relaw/excerpts.pdf#page=294"
                      target="_blank"
                      rel="noreferrer"
                    >
                      State-published text
                    </a>
                    . General process summary, not legal advice.
                  </p>
                </div>
              </details>
            </div>
            <p className={styles.freeUseNote}>* One free use per homeowner.</p>
          </div>
          <div className={styles.servicePhoto}>
            <Image
              className={styles.servicePhotoImage}
              src="/images/community-open-gate.webp"
              alt="A homeowner opens her garden gate onto a sunlit neighborhood."
              fill
              priority
              sizes="(max-width: 760px) 100vw, 57vw"
            />
          </div>
        </section>
        <section
          id="ongoing"
          className={styles.paidService}
          aria-labelledby="ongoing-title"
        >
          <p className={styles.servicePrice}>
            <strong>$1</strong>
            <span> / unit / month</span>
          </p>
          <h2 id="ongoing-title">
            Ongoing HOA
            <br />
            mediation.
          </h2>
          <p className={styles.serviceDescription}>
            We collect homeowner feedback, mediate ongoing disagreements, and
            help the community make decisions together. We then send the board a
            consolidated summary.
          </p>
          <div className={styles.paidServiceAction}>
            <p>Billed to your HOA based on its total unit count.</p>
            <a
              className={styles.serviceButton}
              href="mailto:contact@fretgone.com?subject=Ongoing%20HOA%20coordination"
            >
              Contact us <ArrowRight size={18} aria-hidden="true" />
            </a>
          </div>
        </section>
      </main>
      <footer className={styles.footer}>
        <div>
          <a className={styles.brand} href="/">
            WillingLink<span>.</span>
          </a>
          <span>© {new Date().getFullYear()} FretGone LLC</span>
        </div>
        <nav aria-label="Footer navigation">
          <a href="/careers">Careers</a>
          <a href="mailto:contact@fretgone.com">Contact</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </footer>
    </div>
  );
}
