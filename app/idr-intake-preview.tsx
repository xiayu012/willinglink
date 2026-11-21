"use client";

import { useEffect, useState } from "react";
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

export function IdrIntakePreview({ mode = "idr" }: { mode?: "idr" | "adr" }) {
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
  const draft =
    drafts[state] ??
    (state
      ? `Dear HOA,\n\nI'm formally requesting ${process} under ${laws[state]}.`
      : "");

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
              ? `https://mail.google.com/mail/?view=cm&fs=1&body=${encodeURIComponent(draft)}`
              : !mobile && provider === "Outlook / Hotmail"
                ? `https://outlook.live.com/mail/0/deeplink/compose?body=${encodeURIComponent(draft)}`
                : `mailto:?body=${encodeURIComponent(draft)}`
          }
          target={
            !mobile &&
            (provider === "Gmail" || provider === "Outlook / Hotmail")
              ? "_blank"
              : undefined
          }
          rel="noopener noreferrer"
        >
          Open to send
        </a>
      </div>
    </div>
  );
}
