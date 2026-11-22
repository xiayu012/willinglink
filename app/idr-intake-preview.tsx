"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import styles from "./home.module.css";

const idrLaws: Record<string, string> = {
  California: "California Civil Code §5910",
  Delaware: "29 Del. C. §2544(8)",
};

const adrLaws: Record<string, string> = {
  California: "California Civil Code §§5925–5965",
  Delaware: "Delaware Code Title 25, §81-417(b)",
  "New Jersey": "N.J.S.A. §45:22A-44(c)",
  Florida: "Florida Statutes §720.311",
  Hawaii: "Hawaii Revised Statutes §514B-161",
  Colorado: "Colorado Revised Statutes §38-33.3-124",
  Texas: "Texas Property Code §209.007(e)",
  Washington: "RCW §64.90.685",
};

const providers = ["Gmail", "Outlook / Hotmail", "Other"];

export function IdrIntakePreview({
  mode = "idr",
  subject,
}: {
  mode?: "idr" | "adr";
  subject?: string;
}) {
  const laws = mode === "idr" ? idrLaws : adrLaws;
  const process =
    mode === "idr"
      ? "Internal Dispute Resolution (IDR)"
      : "Alternative Dispute Resolution (ADR)";
  const [state, setState] = useState("");
  const [provider, setProvider] = useState("");
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(pointer: coarse)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({});
  const response =
    mode === "idr" && state === "California"
      ? "Please respond within 14 days and let me know the next steps. If I receive no response, I intend to pursue ADR under California Civil Code §5935, if applicable."
      : "Please respond within 14 days and let me know the next steps.";
  const draft =
    drafts[state] ??
    (state
      ? `Dear HOA,\n\nI'm formally requesting ${process} under ${laws[state]}.\n\nI've engaged WillingLink to handle communications regarding this dispute on my behalf. Please direct further correspondence to WillingLink and keep me copied.\n\nI also ask the board to authorize WillingLink to coordinate communications between us. Please confirm whether the board agrees and identify the board member or other authorized representative handling this ${mode.toUpperCase()} request.\n\n${response}\n\nThank you,`
      : "");

  function registerSendIntent() {
    const body = JSON.stringify({ kind: mode });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        "/api/fretgone/gmail/send-intent",
        new Blob([body], { type: "application/json" })
      );
      return;
    }
    void fetch("/api/fretgone/gmail/send-intent", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      keepalive: true,
    });
  }

  return (
    <div className={styles.idrFields}>
      <label>
        <span className="sr-only">Property state</span>
        <select
          value={state}
          onChange={(event) => setState(event.target.value)}
        >
          <option value="" disabled>
            Select a state
          </option>
          {Object.keys(laws).map((state) => (
            <option key={state}>{state}</option>
          ))}
        </select>
      </label>
      {!mobile && (
        <fieldset className={styles.idrProviders}>
          <legend>Which email provider do you use?</legend>
          <div>
            {providers.map((provider) => (
              <label key={provider}>
                <input
                  type="radio"
                  name={`${mode}-email-provider`}
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                />
                {provider}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className={styles.idrDraftWrap}>
        <textarea
          className={styles.idrDraft}
          aria-label="Email draft to your HOA"
          rows={8}
          value={draft}
          onChange={(event) => {
            const value = event.target.value;
            setDrafts((previous) => ({ ...previous, [state]: value }));
          }}
        />
        <a
          className={styles.idrOpenMail}
          href={
            !mobile && provider === "Gmail"
              ? `https://mail.google.com/mail/?view=cm&fs=1&cc=contact%40fretgone.com${subject ? `&su=${encodeURIComponent(subject)}` : ""}&body=${encodeURIComponent(draft)}`
              : !mobile && provider === "Outlook / Hotmail"
                ? `https://outlook.live.com/mail/0/deeplink/compose?cc=contact%40fretgone.com${subject ? `&subject=${encodeURIComponent(subject)}` : ""}&body=${encodeURIComponent(draft)}`
                : `mailto:?cc=contact%40fretgone.com${subject ? `&subject=${encodeURIComponent(subject)}` : ""}&body=${encodeURIComponent(draft)}`
          }
          target={
            !mobile &&
            (provider === "Gmail" || provider === "Outlook / Hotmail")
              ? "_blank"
              : undefined
          }
          rel="noopener noreferrer"
          onClick={registerSendIntent}
        >
          Open email draft <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
