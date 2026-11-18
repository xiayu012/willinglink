import styles from "./home.module.css";

const states =
  "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia".split(
    "|"
  );
const providers = [
  "Gmail",
  "Outlook / Hotmail",
  "Yahoo Mail",
  "iCloud Mail",
  "AOL Mail",
  "Proton Mail",
  "Other",
];

export function IdrIntakePreview() {
  return (
    <div className={styles.idrFields}>
      <label>
        <span className="sr-only">Property state</span>
        <select defaultValue="">
          <option value="" disabled>
            Select a state
          </option>
          {states.map((state) => (
            <option key={state}>{state}</option>
          ))}
        </select>
      </label>
      <label>
        <span className="sr-only">Your email provider</span>
        <select defaultValue="">
          <option value="" disabled>
            Select a provider
          </option>
          {providers.map((provider) => (
            <option key={provider}>{provider}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
