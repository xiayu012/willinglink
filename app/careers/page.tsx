import type { Metadata } from "next";
import { ArrowUpRight } from "lucide-react";
import styles from "../home.module.css";

export const metadata: Metadata = {
  title: "Work with WillingLink — Global Remote Opportunities",
  description:
    "Ongoing applications for Community Dialogue Volunteers and professional Mediators & Community Coordinators at $20/hour. Remote, worldwide. Apply by email.",
};
export default function Careers() {
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
          <a href="/">Free IDR &amp; ADR</a>
          <a href="/#ongoing">For HOAs</a>
          <a href="mailto:contact@fretgone.com">Contact</a>
        </nav>
      </header>
      <main id="main" className={styles.careers}>
        <a className={styles.backLink} href="/">
          ← Back to WillingLink
        </a>
        <h1>Work with WillingLink.</h1>
        <p className={styles.careersLead}>
          Remote opportunities in community mediation and coordination.
        </p>
        <p className={styles.rosterNote}>
          Applications are open year-round. We contact applicants as suitable
          projects arise.
        </p>
        <section className={styles.role} aria-labelledby="volunteer-role">
          <span className={styles.roleMeta}>
            VOLUNTEER · UNPAID · REMOTE · WORLDWIDE
          </span>
          <h2 id="volunteer-role">Community Dialogue Volunteer</h2>
          <p>
            Gather homeowner concerns, organize feedback, and keep clear notes
            and follow-ups for community conversations.
          </p>
          <ul>
            <li>Listen without taking sides and communicate with care.</li>
            <li>Turn scattered comments into clear, faithful summaries.</li>
            <li>
              Bring reliability, discretion, and respect for different
              backgrounds.
            </li>
          </ul>
          <p>
            In your email, tell us about yourself, your languages and time zone,
            your availability, and why this work interests you.
          </p>
          <br />
          <a
            className={styles.button}
            href="mailto:contact@fretgone.com?subject=Community%20Dialogue%20Volunteer%20application"
          >
            Apply as a volunteer <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </section>
        <section className={styles.role} aria-labelledby="professional-role">
          <span className={styles.roleMeta}>
            PAID · $20 USD / HOUR · REMOTE · WORLDWIDE
          </span>
          <h2 id="professional-role">Mediator &amp; Community Coordinator</h2>
          <p>
            For professionals with mediation or conflict-resolution experience.
            Help homeowners and HOA boards understand the issues, explore
            options, and work toward resolutions they can accept.
          </p>
          <ul>
            <li>
              Facilitate difficult conversations with fairness and sound
              judgment.
            </li>
            <li>
              Support ongoing mediation, homeowner feedback, and shared
              decision-making.
            </li>
            <li>
              Keep accurate records of concerns, proposed resolutions, and next
              steps.
            </li>
          </ul>
          <p>
            Email your résumé or a short summary of your experience, relevant
            training or credentials, languages, time zone, and availability. HOA
            or community mediation experience is welcome.
          </p>
          <br />
          <a
            className={styles.button}
            href="mailto:contact@fretgone.com?subject=Mediator%20%26%20Community%20Coordinator%20application"
          >
            Apply for the professional role{" "}
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </section>
        <p className={styles.applicationNote}>
          Both roles are remote and open to applicants worldwide. Work is
          arranged around project needs, language, time zone, and relevant
          experience. Send applications to{" "}
          <a href="mailto:contact@fretgone.com">contact@fretgone.com</a>.
        </p>
      </main>
      <footer className={styles.footer}>
        <div>
          <a className={styles.brand} href="/">
            WillingLink<span>.</span>
          </a>
          <span>© {new Date().getFullYear()} FretGone LLC</span>
        </div>
        <nav aria-label="Footer navigation">
          <a href="/">Home</a>
          <a href="mailto:contact@fretgone.com">Contact</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </footer>
    </div>
  );
}
