"use client";

import { useState } from "react";
import styles from "./home.module.css";

const idrOpenings: Record<string, string> = {
  California:
    "I'm formally requesting Internal Dispute Resolution (IDR) under California Civil Code §5910.",
  Delaware:
    "I request that the HOA share its internal dispute resolution procedure so we can address this matter.",
};

const adrOpenings: Record<string, string> = {
  California:
    "I request alternative dispute resolution under California Civil Code §§5925–5965 to resolve our dispute.",
  Delaware:
    "I propose nonbinding mediation under Delaware Code Title 25, §81-417(b) to resolve our dispute.",
  "New Jersey":
    "I request the association's alternative dispute resolution procedure under N.J.S.A. 46:8B-14(k), if applicable to our community.",
  Nevada:
    "I propose mediation to resolve our dispute and will check the filing requirements under Nevada Revised Statutes §§38.310–38.320.",
  Florida:
    "I propose presuit mediation under Florida Statutes §720.311 and will follow the applicable formal demand and delivery requirements.",
  Hawaii:
    "I request mediation under Hawaii Revised Statutes §514B-161, if this condominium dispute qualifies.",
  Colorado:
    "I propose mediation under Colorado Revised Statutes §38-33.3-124 to resolve our dispute.",
  Texas:
    "I propose mediation to resolve our dispute and ask about the HOA's applicable dispute resolution procedure.",
  Washington:
    "I propose nonbinding mediation under RCW 64.90.685, if applicable to our community.",
  "North Carolina":
    "I propose prelitigation mediation under North Carolina General Statutes §7A-38.3F to resolve our dispute.",
};

const providers = [
  "Gmail",
  "Outlook / Hotmail",
  "Yahoo Mail",
  "iCloud Mail",
  "AOL Mail",
  "Proton Mail",
  "Other",
];

export function IdrIntakePreview({ mode = "idr" }: { mode?: "idr" | "adr" }) {
  const openings = mode === "idr" ? idrOpenings : adrOpenings;
  const [state, setState] = useState("");
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({});
  const draft =
    drafts[state] ?? (state ? `Dear HOA,\n\n${openings[state]}` : "");

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
          {Object.keys(openings).map((state) => (
            <option key={state}>{state}</option>
          ))}
        </select>
      </label>
      <fieldset className={styles.idrProviders}>
        <legend>Which email provider do you use?</legend>
        <div>
          {providers.map((provider) => (
            <label key={provider}>
              <input
                type="radio"
                name={`${mode}-email-provider`}
                value={provider}
              />
              {provider}
            </label>
          ))}
        </div>
      </fieldset>
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
    </div>
  );
}
