// The tutorials (docs/tutorials/) and the sample flows that come with
// them, so they can be opened from the flow list (competitive-gaps.md #18).
// The bundles are the ones CI keeps current (examples/build-tutorials.mjs).
import { locale } from "./i18n";

export interface Sample {
  id: "sales-csv" | "invoices" | "web-orders";
  /** The bundle's text, loaded only when it is opened. Absent when the tutorial needs more than Studio (a site to try against). */
  bundle?: () => Promise<string>;
}

export const SAMPLES: Sample[] = [
  { id: "sales-csv", bundle: () => import("../../../../examples/tutorials/sales-csv.shikigami.json?raw").then((m) => m.default) },
  { id: "invoices", bundle: () => import("../../../../examples/tutorials/invoices.shikigami.json?raw").then((m) => m.default) },
  { id: "web-orders" },
];

const DOCS = "https://github.com/d-shiina/shikigami/blob/main/docs/";

/** The tutorial's page in Studio's language; without an id, the list of them. */
export function tutorialUrl(id?: Sample["id"]): string {
  return `${DOCS}${locale === "ja" ? "ja/" : ""}tutorials/${id ?? "README"}.md`;
}
