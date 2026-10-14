// The one place to fill Donate links. A blank string hides that choice.
// With every string blank, the settings Donate button stays off the page.
// .github/FUNDING.yml repeats these as comments. github: lordstryfe stays
// commented there until GitHub Sponsors is approved.

export const DONATE_GITHUB_SPONSORS_URL = "";
export const DONATE_PAYPAL_URL = "";
export const DONATE_KOFI_URL = "";

const DONATE_CHOICES = [
  { label: "GitHub Sponsors", url: DONATE_GITHUB_SPONSORS_URL },
  { label: "PayPal", url: DONATE_PAYPAL_URL },
  { label: "Ko-fi", url: DONATE_KOFI_URL },
];

export function donateLinks(choices = DONATE_CHOICES) {
  return choices.filter((choice) => typeof choice.url === "string" && choice.url.trim() !== "");
}
