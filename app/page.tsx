import type { Metadata } from "next";
import Image from "next/image";
import { ArrowRight, ArrowUpRight } from "lucide-react";
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
            <a className={styles.serviceButton} href={email}>
              Contact us <ArrowRight size={18} aria-hidden="true" />
            </a>
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
