import type { Metadata } from "next";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleCheck,
  Leaf,
  Mail,
  MessageSquare,
  ShieldCheck,
} from "lucide-react";
import styles from "./home.module.css";

export const metadata: Metadata = {
  title: "FretGone — More community. Less board work.",
  description:
    "HOA back-office service that listens to homeowners, coordinates common ground, and handles routine follow-through. From $200 per HOA per month. First month free.",
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
          <span className={styles.brandMark}>
            <Leaf size={21} strokeWidth={1.6} />
          </span>
          fretgone<span className={styles.brandDot}>.</span>
        </a>
        <nav aria-label="Main navigation" className={styles.nav}>
          <a href="#how-it-works">How it works</a>
          <a href="#oversight">Your control</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <a className={styles.headerCta} href={email}>
          Let’s talk <ArrowRight size={15} />
        </a>
      </header>

      <main id="main">
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>
              <span /> THE QUIETER SIDE OF HOA MANAGEMENT
            </p>
            <h1>
              More community.
              <br />
              Less <em>board work.</em>
            </h1>
            <p className={styles.heroDescription}>
              Give your neighborhood a voice.
              <br />
              Get your evenings back.
            </p>
            <p className={styles.intro}>
              We handle the conversations, coordination, and everyday
              follow-through behind your HOA. Homeowners keep using text and
              email. Your board keeps the final say.
            </p>
            <a href={email} className={styles.button}>
              Let’s lighten the load <ArrowRight size={17} />
            </a>
            <p className={styles.heroNote}>
              First month free <span>·</span> No new accounts for your community
            </p>
          </div>
          <div className={styles.heroVisual}>
            <div className={styles.visualTop}>
              <span className={styles.liveDot} /> A LITTLE LESS ON YOUR PLATE{" "}
              <span>↗</span>
            </div>
            <div className={styles.record}>
              <div className={styles.recordTop}>
                <span>COMMUNITY JOURNAL</span>
                <span>Illustrative workflow</span>
              </div>
              <h2>
                A shared space.
                <br />A shared way forward.
              </h2>
              <div className={styles.timeline}>
                <div>
                  <span className={styles.timelineIcon}>
                    <MessageSquare size={16} />
                  </span>
                  <section>
                    <h3>Every voice, heard.</h3>
                    <p>
                      Homeowners share ideas for the courtyard by text and
                      email.
                    </p>
                    <small>LISTEN & UNDERSTAND</small>
                  </section>
                </div>
                <div>
                  <span className={styles.timelineIcon}>
                    <CheckCheck size={17} />
                  </span>
                  <section>
                    <h3>Common ground, found.</h3>
                    <p>
                      Preferences come together in a proposal. Open concerns
                      stay on the record.
                    </p>
                    <small>COORDINATE & DOCUMENT</small>
                  </section>
                </div>
                <div>
                  <span className={styles.timelineIcon}>
                    <ShieldCheck size={17} />
                  </span>
                  <section>
                    <h3>Your board, in control.</h3>
                    <p>A purchase needs approval before moving forward.</p>
                    <small>REVIEW & FOLLOW THROUGH</small>
                  </section>
                </div>
              </div>
              <div className={styles.recordFooter}>
                <CircleCheck size={14} /> A clear record. A lighter workload.
              </div>
            </div>
            <div className={styles.approval}>
              <span className={styles.approvalIcon}>
                <ShieldCheck size={22} />
              </span>
              <div>
                <strong>The important decisions stay yours.</strong>
                <p>Review sensitive actions from your phone.</p>
              </div>
            </div>
          </div>
        </section>

        <div className={styles.promiseStrip}>
          <span>A service that does the work.</span>
          <span>
            <Check size={16} /> Familiar text & email
          </span>
          <span>
            <Check size={16} /> Your existing HOA tools
          </span>
          <span>
            <Check size={16} /> Human approval where it matters
          </span>
        </div>

        <section id="how-it-works" className={styles.section}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>
                LESS ADMINISTRATION. MORE PARTICIPATION.
              </p>
              <h2>
                A neighborhood should feel
                <br />
                like a community.
                <br />
                <em>Not a second job.</em>
              </h2>
            </div>
            <p>
              Being on the board shouldn’t mean becoming the neighborhood’s
              full-time inbox. FretGone takes on the work behind the scenes, so
              owners can take part without putting every task on a volunteer.
            </p>
          </div>
          <div className={styles.steps}>
            <article>
              <span className={styles.number}>01 / LISTEN</span>
              <MessageSquare size={25} strokeWidth={1.3} />
              <h3>Everyone gets a voice.</h3>
              <p>
                Owners reach out the way they already do. We gather their views,
                ask follow-up questions, and keep the conversation moving.
              </p>
            </article>
            <article>
              <span className={styles.number}>02 / BRING TOGETHER</span>
              <CheckCheck size={27} strokeWidth={1.3} />
              <h3>Work toward common ground.</h3>
              <p>
                We explore proposals people can agree on. When agreement isn’t
                possible, the concerns and how the discussion unfolded are
                documented.
              </p>
            </article>
            <article>
              <span className={styles.number}>03 / FOLLOW THROUGH</span>
              <CircleCheck size={26} strokeWidth={1.3} />
              <h3>Turn discussion into progress.</h3>
              <p>
                Agreed next steps become organized work. Routine follow-through
                is handled within the authority your board grants, with
                sensitive actions sent for review.
              </p>
            </article>
          </div>
        </section>

        <section id="oversight" className={styles.oversight}>
          <div className={styles.oversightIntro}>
            <p className={styles.eyebrow}>
              LESS ON YOUR DESK. STILL IN YOUR HANDS.
            </p>
            <h2>
              Built around your community.
              <br />
              <em>Accountable to your board.</em>
            </h2>
            <p>
              Owners participate directly. Your board has visibility. We take
              care of the coordination in between.
            </p>
            <a href={email} className={styles.textLink}>
              Talk through your setup <ArrowRight size={16} />
            </a>
          </div>
          <div className={styles.controlList}>
            <article>
              <span>01</span>
              <div>
                <h3>A journal, not another dashboard.</h3>
                <p>
                  A board-only Notion page brings together discussions,
                  progress, decisions, and unresolved concerns. Read it without
                  creating a Notion account; access is arranged during setup.
                </p>
              </div>
            </article>
            <article>
              <span>02</span>
              <div>
                <h3>Your tools stay in place.</h3>
                <p>
                  The proposed setup uses a browser agent on a designated board
                  computer to work with your existing inbox, HOA software, and
                  accounting tools. We confirm compatibility and permissions
                  with you before starting.
                </p>
              </div>
            </article>
            <article>
              <span>03</span>
              <div>
                <h3>Review the moments that matter.</h3>
                <p>
                  Routine work shouldn’t need someone watching a screen.
                  Sensitive steps, such as spending money or placing orders, are
                  intended to come to a board member for approval or rejection
                  from their phone.
                </p>
              </div>
            </article>
          </div>
        </section>

        <section className={styles.setup}>
          <p className={styles.eyebrow}>A SMALL START. A LIGHTER WEEK.</p>
          <h2>
            One board member.
            <br />
            <em>About ten minutes to get started.</em>
          </h2>
          <p>
            Start with a short setup conversation. Authorize the communication
            channels you want us to handle, agree on the boundaries, and confirm
            your board’s access and approval workflow. We’ll identify any
            tool-specific setup together.
          </p>
          <a href={email} className={styles.button}>
            Start a conversation <Mail size={16} />
          </a>
          <span>
            No homeowner onboarding. No board passwords to remember for a new
            app.
          </span>
        </section>

        <section id="pricing" className={styles.section}>
          <div className={styles.pricingHeading}>
            <p className={styles.eyebrow}>ONE COMMUNITY. ONE MONTHLY PRICE.</p>
            <h2>
              A lighter load.
              <br />
              <em>A straightforward price.</em>
            </h2>
            <p>First month free. Pricing covers your entire HOA.</p>
          </div>
          <div className={styles.prices}>
            <article className={styles.priceCard}>
              <span className={styles.plan}>SMALLER COMMUNITIES</span>
              <h3>Under 500 homes</h3>
              <p className={styles.price}>
                $200<span>USD / month</span>
              </p>
              <p>For your entire HOA.</p>
              <a href={email} className={styles.button}>
                Ask about your free month <ArrowRight size={16} />
              </a>
              <ul>
                <li>
                  <Check size={16} /> Homeowner conversations & coordination
                </li>
                <li>
                  <Check size={16} /> Board-readable activity journal
                </li>
                <li>
                  <Check size={16} /> Authorized routine follow-through
                </li>
                <li>
                  <Check size={16} /> Sensitive-action review
                </li>
              </ul>
            </article>
            <article className={`${styles.priceCard} ${styles.featuredPrice}`}>
              <span className={styles.plan}>LARGER COMMUNITIES</span>
              <h3>500–999 homes</h3>
              <p className={styles.price}>
                $500<span>USD / month</span>
              </p>
              <p>Same service. A larger community.</p>
              <a href={email} className={styles.lightButton}>
                Ask about your free month <ArrowRight size={16} />
              </a>
              <ul>
                <li>
                  <Check size={16} /> Homeowner conversations & coordination
                </li>
                <li>
                  <Check size={16} /> Board-readable activity journal
                </li>
                <li>
                  <Check size={16} /> Authorized routine follow-through
                </li>
                <li>
                  <Check size={16} /> Sensitive-action review
                </li>
              </ul>
            </article>
          </div>
          <p className={styles.capacity}>
            Keeping the service personal and dependable: we aren’t serving HOAs
            with 1,000 or more homes at this time.
          </p>
        </section>

        <section className={`${styles.section} ${styles.faq}`}>
          <div>
            <p className={styles.eyebrow}>A FEW GOOD QUESTIONS</p>
            <h2>
              Clarity comes
              <br />
              <em>with the service.</em>
            </h2>
            <a href={email} className={styles.textLink}>
              Ask us anything <ArrowRight size={16} />
            </a>
          </div>
          <div className={styles.questions}>
            <details>
              <summary>
                Are we buying software?
                <ChevronDown size={17} />
              </summary>
              <p>
                You’re engaging a back-office service to do the work: handle
                authorized conversations, coordinate owner input, document
                outcomes, and follow through. Owners and board members don’t
                need accounts for a new FretGone app.
              </p>
            </details>
            <details>
              <summary>
                Does FretGone replace the board’s authority?
                <ChevronDown size={17} />
              </summary>
              <p>
                The goal is to relieve the board’s workload and help owners
                participate directly. Your board retains its responsibilities
                and decision-making authority. We seek agreement; we don’t treat
                a discussion as permission to override dissent or skip your
                association’s decision process.
              </p>
            </details>
            <details>
              <summary>
                Who can see homeowner conversations?
                <ChevronDown size={17} />
              </summary>
              <p>
                The service is designed around a board-only journal. Private
                homeowner messages are not intended to be shared with other
                homeowners. We agree on access controls, the information
                recorded, and retention before connecting your communication
                channels. A no-signup page still needs a carefully managed
                access link.
              </p>
            </details>
            <details>
              <summary>
                How are records and sensitive actions protected?
                <ChevronDown size={17} />
              </summary>
              <p>
                We’ll review the access and approval setup with you, including
                options for an AWS-backed, tamper-evident archive. A Notion page
                alone is not an immutable archive. Browser-agent safeguards and
                phone approvals depend on the tools and configuration in use;
                these are confirmed during setup, rather than promised as
                absolute guarantees.
              </p>
            </details>
            <details>
              <summary>
                What data does the service receive?
                <ChevronDown size={17} />
              </summary>
              <p>
                Authorized homeowner text and email conversations are the core
                input. The proposed browser workflow uses your existing tools
                rather than a custom connection that sends their contents to our
                server. We review actual data flows and the providers involved
                during setup; this is not a blanket claim that no third party
                processes data.
              </p>
            </details>
            <details>
              <summary>
                Will someone need to stay at the computer?
                <ChevronDown size={17} />
              </summary>
              <p>
                The intended workflow runs routine tasks on a designated,
                available board computer without someone sitting in front of it.
                A board member remains available for sensitive-action approvals.
                Device availability, browser-agent support, and any
                interruptions are part of the setup discussion.
              </p>
            </details>
          </div>
        </section>

        <section className={styles.finalCta}>
          <p className={styles.eyebrow}>YOUR EVENINGS BELONG TO YOU.</p>
          <h2>
            Let’s take the work
            <br />
            <em>off your board.</em>
          </h2>
          <a href={email} className={styles.lightButton}>
            Say hello <ArrowRight size={17} />
          </a>
          <a className={styles.email} href={email}>
            contact@fretgone.com
          </a>
        </section>
      </main>
      <footer className={styles.footer}>
        <div>
          <a href="/" className={styles.brand}>
            <Leaf size={21} strokeWidth={1.6} /> fretgone.
          </a>
          <p>More community. Less board work.</p>
        </div>
        <div>
          <span>© {new Date().getFullYear()} FretGone LLC</span>
          <nav aria-label="Legal">
            <a href="/about">About</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href={email}>
              Contact <ArrowRight size={12} />
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
