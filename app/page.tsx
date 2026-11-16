import type { Metadata } from "next";
import Image from "next/image";
import {
  ArrowRight,
  ArrowUpRight,
  ArrowUpRight as StepsIcon,
  X,
} from "lucide-react";
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
              <div className={styles.servicePath}>
                <a
                  className={styles.serviceButton}
                  href="mailto:contact@fretgone.com?subject=Free%20IDR%20inquiry"
                >
                  Start IDR <ArrowRight size={17} aria-hidden="true" />
                </a>
                <button
                  className={styles.stepsTrigger}
                  popoverTarget="idr-steps"
                  type="button"
                >
                  IDR steps <StepsIcon size={13} aria-hidden="true" />
                </button>
              </div>
              <div className={styles.servicePath}>
                <a
                  className={styles.serviceButton}
                  href="mailto:contact@fretgone.com?subject=Free%20ADR%20inquiry"
                >
                  Start ADR <ArrowRight size={17} aria-hidden="true" />
                </a>
                <button
                  className={styles.stepsTrigger}
                  popoverTarget="adr-steps"
                  type="button"
                >
                  ADR steps <StepsIcon size={13} aria-hidden="true" />
                </button>
              </div>
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
      <div
        id="idr-steps"
        popover="auto"
        role="dialog"
        aria-labelledby="idr-steps-title"
        className={styles.stepsPopover}
      >
        <header className={styles.popoverHeader}>
          <div>
            <p>Internal dispute resolution</p>
            <h2 id="idr-steps-title">IDR steps</h2>
          </div>
          <button
            type="button"
            popoverTarget="idr-steps"
            popoverTargetAction="hide"
            className={styles.closePopover}
            aria-label="Close IDR steps"
          >
            <X size={21} aria-hidden="true" />
          </button>
        </header>
        <div className={styles.popoverBody}>
          <p className={styles.processContext}>
            For HOA/member disputes. Follow your HOA’s compliant IDR policy;
            otherwise, the default procedure in §5915 applies.
          </p>
          <ol className={styles.processList}>
            <li>
              <h3>Request IDR in writing</h3>
              <p>
                The HOA must participate when a member requests it. A member may
                decline the HOA’s request.
              </p>
            </li>
            <li>
              <h3>Meet and discuss the issues</h3>
              <p>
                Under §5915, meet promptly with a board-designated director at a
                mutually convenient time and place. Explain both positions and
                confer in good faith.
              </p>
            </li>
            <li>
              <h3>Write down any agreement</h3>
              <p>
                Both parties sign. The agreement must comply with law and
                governing documents, and fall within the director’s authority or
                receive board ratification.
              </p>
            </li>
          </ol>
          <div className={styles.processNote}>
            <strong>About the free service</strong>
            <p>
              Our one-use offer does not limit statutory IDR rights. The HOA
              cannot charge a member to participate in IDR. Emailing WillingLink
              alone does not deliver a request to the HOA.
            </p>
          </div>
          <p className={styles.processSources}>
            California Civil Code{" "}
            <a
              href="https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=CIV&amp;division=4.&amp;title=&amp;part=5.&amp;chapter=10.&amp;article=2."
              target="_blank"
              rel="noreferrer"
            >
              §§5900–5915
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
      </div>
      <div
        id="adr-steps"
        popover="auto"
        role="dialog"
        aria-labelledby="adr-steps-title"
        className={styles.stepsPopover}
      >
        <header className={styles.popoverHeader}>
          <div>
            <p>Alternative dispute resolution</p>
            <h2 id="adr-steps-title">ADR steps</h2>
          </div>
          <button
            type="button"
            popoverTarget="adr-steps"
            popoverTargetAction="hide"
            className={styles.closePopover}
            aria-label="Close ADR steps"
          >
            <X size={21} aria-hidden="true" />
          </button>
        </header>
        <div className={styles.popoverBody}>
          <p className={styles.processContext}>
            For pre-lawsuit disputes covered by §5930. IDR and ADR are separate
            procedures; the applicable path depends on the dispute.
          </p>
          <ol className={styles.processList}>
            <li>
              <h3>Prepare a Request for Resolution</h3>
              <p>
                Describe the dispute, request ADR, and include the notice that a
                response is due within 30 days or the request will be treated as
                rejected. Include Article 3 when serving a member.
              </p>
            </li>
            <li>
              <h3>Serve every other party</h3>
              <p>
                Use personal delivery, first-class mail, or another method
                reasonably calculated to give actual notice. Emailing
                WillingLink alone does not serve this request.
              </p>
            </li>
            <li>
              <h3>Allow 30 days for a response</h3>
              <p>
                The recipient can accept or reject. Silence means rejection.
              </p>
            </li>
            <li>
              <h3>If accepted, complete ADR within 90 days</h3>
              <p>
                Agree on mediation. The 90 days start when the requester
                receives acceptance; both parties may sign a written extension.
                Settlement is voluntary.
              </p>
            </li>
          </ol>
          <div className={styles.processNote}>
            <strong>Scope and court filing</strong>
            <p>
              Small-claims cases are excluded; assessment disputes are generally
              excluded. A covered lawsuit requires the §5950 certificate.
            </p>
          </div>
          <p className={styles.processSources}>
            California Civil Code{" "}
            <a
              href="https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=CIV&amp;division=4.&amp;title=&amp;part=5.&amp;chapter=10.&amp;article=3."
              target="_blank"
              rel="noreferrer"
            >
              §§5925–5950
            </a>{" "}
            ·{" "}
            <a
              href="https://dre.ca.gov/files/pdf/relaw/excerpts.pdf#page=295"
              target="_blank"
              rel="noreferrer"
            >
              State-published text
            </a>
            . General process summary, not legal advice.
          </p>
        </div>
      </div>
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
