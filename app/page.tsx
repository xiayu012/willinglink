import type { Metadata } from "next";
import {
  ArrowDown,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleCheck,
  FileText,
  Mail,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import styles from "./home.module.css";

export const metadata: Metadata = {
  title: "FretGone — Your HOA. Off your plate.",
  description:
    "We handle your HOA’s conversations, coordination, and routine follow-through. No new app for homeowners. From $200 per HOA per month. First month free.",
};
const email = "mailto:contact@fretgone.com";

export default function Home() {
  return (
    <div className={styles.site}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <a href="/" className={styles.brand} aria-label="FretGone home">
          <span className={styles.logo}>
            <Zap size={19} fill="currentColor" />
          </span>
          fretgone<span>.</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#pricing">Pricing</a>
          <a href="#questions">FAQs</a>
        </nav>
        <a href={email} className={styles.navCta}>
          Let’s talk <ArrowRight size={16} />
        </a>
      </header>
      <main id="main">
        <section className={styles.hero}>
          <div className={styles.container}>
            <div className={styles.heroGrid}>
              <div className={styles.heroCopy}>
                <div className={styles.pill}>
                  <span /> HOA BACK-OFFICE SERVICE
                </div>
                <h1>
                  Your HOA.
                  <br />
                  <span>Off your plate.</span>
                </h1>
                <p>
                  We handle the conversations, coordination, and everyday
                  follow-through. Your owners have a voice. Your board gets its
                  time back.
                </p>
                <div className={styles.heroActions}>
                  <a href={email} className={styles.button}>
                    Get your first month free <ArrowRight size={18} />
                  </a>
                  <a href="#how-it-works" className={styles.secondaryLink}>
                    See how it works <ArrowDown size={16} />
                  </a>
                </div>
                <div className={styles.heroPrice}>
                  <strong>
                    From $200<span>/month</span>
                  </strong>
                  <span>For your entire HOA.</span>
                </div>
              </div>
              <div
                className={styles.scene}
                aria-label="Illustrative example of the service workflow"
              >
                <div className={styles.sceneLabel}>
                  <Sparkles size={14} /> THE WORK MOVES. YOU DON’T HAVE TO.
                </div>
                <div className={styles.workboard}>
                  <div className={styles.boardHeader}>
                    <div>
                      <span className={styles.boardIcon}>
                        <Zap size={17} fill="currentColor" />
                      </span>
                      <strong>Your community, moving forward.</strong>
                    </div>
                    <span className={styles.example}>EXAMPLE</span>
                  </div>
                  <div className={styles.boardBody}>
                    <div className={styles.boardIntro}>
                      <div>
                        <small>THE BIG PICTURE</small>
                        <h2>
                          Less in your inbox.
                          <br />
                          More taken care of.
                        </h2>
                      </div>
                      <span className={styles.orbit}>
                        <CheckCheck size={30} strokeWidth={2.5} />
                      </span>
                    </div>
                    <div className={styles.task}>
                      <span className={styles.taskIcon}>
                        <MessageSquare size={17} />
                      </span>
                      <div>
                        <strong>Courtyard ideas</strong>
                        <span>Owner feedback gathered</span>
                      </div>
                      <span className={styles.status}>Heard</span>
                    </div>
                    <div className={styles.task}>
                      <span className={styles.taskIcon}>
                        <CheckCheck size={19} />
                      </span>
                      <div>
                        <strong>A shared proposal</strong>
                        <span>Common ground & open concerns</span>
                      </div>
                      <span className={styles.blueStatus}>Recorded</span>
                    </div>
                    <div className={styles.task}>
                      <span className={styles.taskIcon}>
                        <FileText size={17} />
                      </span>
                      <div>
                        <strong>The board journal</strong>
                        <span>Conversations & next steps, together</span>
                      </div>
                      <span className={styles.status}>Updated</span>
                    </div>
                    <div className={styles.boardBottom}>
                      <ShieldCheck size={14} />
                      <span>Your authority. Your approval.</span>
                      <span>↗</span>
                    </div>
                  </div>
                </div>
                <div className={styles.approval}>
                  <span className={styles.approvalIcon}>
                    <ShieldCheck size={22} />
                  </span>
                  <div>
                    <strong>A purchase needs your OK.</strong>
                    <span>Review it from your phone.</span>
                  </div>
                  <span className={styles.reviewLabel}>
                    For review <ArrowRight size={13} />
                  </span>
                </div>
              </div>
            </div>
            <div className={styles.heroChecks}>
              <span>
                <Check size={16} /> No new homeowner accounts
              </span>
              <span>
                <Check size={16} /> Keep your existing tools
              </span>
              <span>
                <Check size={16} /> Sensitive actions need your approval
              </span>
            </div>
          </div>
        </section>

        <section
          id="how-it-works"
          className={`${styles.section} ${styles.container}`}
        >
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.kicker}>
                YOUR COMMUNITY. LESS BUSYWORK.
              </span>
              <h2>
                From “someone should”
                <br />
                to <span>taken care of.</span>
              </h2>
            </div>
            <p>
              Homeowners keep using text and email.
              <br />
              We take on the work in between.
            </p>
          </div>
          <div className={styles.features}>
            <article>
              <div className={styles.featureTop}>
                <span className={styles.featureIcon}>
                  <MessageSquare size={23} />
                </span>
                <span>01</span>
              </div>
              <h3>Hear every owner.</h3>
              <p>
                Gather opinions, ask follow-up questions, and give everyone a
                way to participate.
              </p>
            </article>
            <article>
              <div className={styles.featureTop}>
                <span className={styles.featureIcon}>
                  <CheckCheck size={25} />
                </span>
                <span>02</span>
              </div>
              <h3>Find a way forward.</h3>
              <p>
                Work toward a proposal people can agree on. If they can’t, keep
                a clear record of why.
              </p>
            </article>
            <article>
              <div className={styles.featureTop}>
                <span className={styles.featureIcon}>
                  <CircleCheck size={23} />
                </span>
                <span>03</span>
              </div>
              <h3>Handle the follow-through.</h3>
              <p>
                Carry out authorized routine work. Send sensitive actions to
                your board for approval.
              </p>
            </article>
          </div>
          <div className={styles.setup}>
            <div className={styles.setupIcon}>
              <Zap size={24} />
            </div>
            <div>
              <h3>One board member. About 10 minutes to get started.</h3>
              <p>
                Authorize your channels. Agree on boundaries. We confirm the
                tool setup together.
              </p>
            </div>
            <a href={email}>
              Let’s talk setup <ArrowRight size={17} />
            </a>
          </div>
        </section>

        <section id="pricing" className={styles.pricingSection}>
          <div className={styles.container}>
            <div className={styles.pricingHeading}>
              <div>
                <span className={styles.kicker}>
                  ONE HOA. ONE MONTHLY PRICE.
                </span>
                <h2>
                  A small bill.
                  <br />
                  <span>A big weight off.</span>
                </h2>
              </div>
              <div className={styles.freeBadge}>
                <Sparkles size={18} /> First month free.
              </div>
            </div>
            <div className={styles.prices}>
              <article className={styles.priceCard}>
                <div className={styles.planHeading}>
                  <h3>Under 500 homes</h3>
                  <span>ENTIRE HOA</span>
                </div>
                <p className={styles.price}>
                  $200<span>USD / month</span>
                </p>
                <a href={email} className={styles.button}>
                  Start with a free month <ArrowRight size={17} />
                </a>
              </article>
              <article className={styles.priceCard}>
                <div className={styles.planHeading}>
                  <h3>500–999 homes</h3>
                  <span>ENTIRE HOA</span>
                </div>
                <p className={styles.price}>
                  $500<span>USD / month</span>
                </p>
                <a href={email} className={styles.outlineButton}>
                  Start with a free month <ArrowRight size={17} />
                </a>
              </article>
            </div>
            <div className={styles.pricingFoot}>
              <p>
                <Check size={15} /> Both plans: conversations, coordination, a
                board journal, and authorized follow-through.
              </p>
              <span>1,000+ homes: not currently available.</span>
            </div>
          </div>
        </section>

        <section
          id="questions"
          className={`${styles.section} ${styles.container} ${styles.faq}`}
        >
          <div>
            <span className={styles.kicker}>
              GOOD QUESTIONS. CLEAR ANSWERS.
            </span>
            <h2>
              A little clarity.
              <br />
              <span>Then, let’s talk.</span>
            </h2>
            <a href={email} className={styles.contactLink}>
              contact@fretgone.com <ArrowRight size={16} />
            </a>
          </div>
          <div className={styles.questions}>
            <details>
              <summary>
                Is this another app we need to learn?
                <ChevronDown size={18} />
              </summary>
              <p>
                No new FretGone accounts. This is a service that does the work.
                Owners keep texting and emailing; your board gets a shared
                Notion journal to read without a Notion signup. Access is
                arranged during setup.
              </p>
            </details>
            <details>
              <summary>
                What stays in the board’s hands?
                <ChevronDown size={18} />
              </summary>
              <p>
                Your board keeps its authority and responsibilities. We work
                within agreed permissions, seek owner agreement, and keep
                unresolved concerns on record. Sensitive actions, including
                purchases, are intended for phone approval.
              </p>
            </details>
            <details>
              <summary>
                How does it work with our existing tools?
                <ChevronDown size={18} />
              </summary>
              <p>
                The proposed browser-agent workflow reads tasks from the journal
                and works in your existing email, HOA, and accounting tools on a
                designated, available board computer. Compatibility and approval
                delivery are confirmed during setup; someone needn’t sit
                watching routine work.
              </p>
            </details>
            <details>
              <summary>
                What about privacy and the activity record?
                <ChevronDown size={18} />
              </summary>
              <p>
                The journal is intended for board members, not other homeowners.
                We agree on access, retention, and actual data flows before
                connecting channels. AWS-backed tamper-evident archiving is an
                option to confirm; Notion alone is not immutable. Browser
                safeguards depend on the selected tools and configuration, and
                we don’t promise absolute protection or zero third-party
                processing.
              </p>
            </details>
          </div>
        </section>
        <section className={styles.finalCta}>
          <div className={styles.container}>
            <div>
              <span className={styles.kicker}>
                LESS ON YOUR PLATE. MORE LIFE OUTSIDE IT.
              </span>
              <h2>
                Your next board meeting
                <br />
                could have a <span>shorter to-do list.</span>
              </h2>
            </div>
            <a href={email} className={styles.button}>
              Let’s make that happen <ArrowRight size={18} />
            </a>
          </div>
        </section>
      </main>
      <footer className={`${styles.container} ${styles.footer}`}>
        <div>
          <a href="/" className={styles.brand}>
            <span className={styles.logo}>
              <Zap size={17} fill="currentColor" />
            </span>
            fretgone<span>.</span>
          </a>
          <span>© {new Date().getFullYear()} FretGone LLC</span>
        </div>
        <nav aria-label="Legal">
          <a href="/about">About</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href={email}>
            Contact <Mail size={13} />
          </a>
        </nav>
      </footer>
    </div>
  );
}
