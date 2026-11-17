import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy – WillingLink by FretGone LLC",
};

const CONTACT_EMAIL = "contact@fretgone.com";

export default function PrivacyPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8 text-sm leading-relaxed">
      <h1 className="font-semibold text-2xl">
        Privacy Policy – WillingLink by FretGone LLC
      </h1>
      <p>
        This Privacy Policy describes how FretGone LLC (&quot;we&quot;,
        &quot;us&quot;, or &quot;our&quot;) collects, uses, and discloses your
        information when you use the WillingLink website and related services.
      </p>

      <p className="text-muted-foreground">Updated November 17, 2026</p>

      <h2 className="mt-4 font-semibold text-lg">1. Information We Collect</h2>
      <p>
        We may collect the following information when you visit, contact us, use
        our services, or apply for a role:
      </p>
      <ul className="list-disc space-y-1 pl-6">
        <li>First and last name</li>
        <li>Email address</li>
        <li>Phone number</li>
        <li>
          Your HOA or community, unit or property details, your role in the
          dispute, and information or documents you choose to share
        </li>
        <li>
          Technical information such as IP address, browser type, and device
          information
        </li>
      </ul>

      <h2 className="mt-4 font-semibold text-lg">
        2. How We Use Your Information
      </h2>
      <p>We use the information we collect to:</p>
      <ul className="list-disc space-y-1 pl-6">
        <li>
          Respond to questions about HOA dispute resolution and our services
        </li>
        <li>
          Help prepare dispute-resolution requests, coordinate discussions,
          collect homeowner feedback, and prepare summaries and agreed next
          steps
        </li>
        <li>Send service-related updates you have requested or opted into</li>
        <li>Review applications for volunteer and paid roles</li>
        <li>Maintain service records and operate and secure our website</li>
      </ul>
      <p>
        We do not use your information for unrelated promotional campaigns. Our
        SMS program is limited to transactional and informational messages
        related to your inquiry or participation in our services.
      </p>

      <h2 className="mt-4 font-semibold text-lg">3. SMS Communication</h2>
      <p>
        If you opt in to text messages from WillingLink, we may send{" "}
        <strong>transactional and informational text messages</strong> from
        FretGone LLC (WillingLink) about your inquiry or service. These may
        include follow-up questions, discussion arrangements, and service
        updates. Contacting us by email does not by itself enroll you in text
        messages.
      </p>
      <p>
        Message frequency may vary depending on your inquiry and service
        activity. Message and data rates may apply according to your mobile
        carrier plan. You may opt out of SMS communication at any time by
        replying <strong>STOP</strong> to any message. For help, reply{" "}
        <strong>HELP</strong> or contact us at{" "}
        <a
          className="underline hover:text-foreground"
          href={`mailto:${CONTACT_EMAIL}`}
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>
      <p>
        We do not sell your phone number. SMS delivery may involve trusted
        service providers (such as messaging platforms) solely to deliver
        messages on our behalf.
      </p>
      <p>
        Consent to receive SMS messages is not required to use our service. If
        you prefer not to receive text messages, you can contact us by email at{" "}
        <a
          className="underline hover:text-foreground"
          href={`mailto:${CONTACT_EMAIL}`}
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>

      <h2 className="mt-4 font-semibold text-lg">4. Information Sharing</h2>
      <p>
        We do not sell your personal information. Providing dispute-resolution
        support may involve sharing relevant information with the HOA, other
        participants, or a mediator. Before a discussion begins, we clarify who
        will receive information and how discussion records or summaries will be
        shared. A private message to us should not be assumed to be legally
        privileged or automatically confidential.
      </p>

      <p>
        Service providers may process information to support email, messaging,
        hosting, storage, and AI-assisted work. Information you authorize a
        third-party tool to access is also subject to that provider’s privacy
        terms. We may disclose information when required by law.
      </p>

      <h2 className="mt-4 font-semibold text-lg">
        5. Data Retention and Security
      </h2>
      <p>
        We retain personal information only as long as necessary to fulfill the
        purposes described in this policy or as required by law. We use
        reasonable administrative, technical, and organizational measures to
        protect your information.
      </p>

      <h2 className="mt-4 font-semibold text-lg">6. Your Rights</h2>
      <p>You may contact us to:</p>
      <ul className="list-disc space-y-1 pl-6">
        <li>Request access to or a copy of your personal information</li>
        <li>Update or correct your contact details</li>
        <li>Withdraw SMS consent by replying STOP or contacting us directly</li>
        <li>
          Request deletion of your information, subject to legal obligations
        </li>
      </ul>

      <h2 className="mt-4 font-semibold text-lg">7. Contact Us</h2>
      <p>
        For questions about this Privacy Policy, please contact:{" "}
        <a
          className="underline hover:text-foreground"
          href={`mailto:${CONTACT_EMAIL}`}
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>

      <p className="mt-4 text-muted-foreground">
        See also our{" "}
        <Link className="underline hover:text-foreground" href="/terms">
          Terms and Conditions
        </Link>
        .
      </p>

      <h2 className="mt-4 font-semibold text-lg">Company</h2>
      <p>FretGone LLC — WillingLink</p>
    </main>
  );
}
