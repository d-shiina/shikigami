// What the review desk shows of the open flow: the report (the AI's change
// laid out on one sheet of paper to approve or send back), or one of the
// editor's usual views with the verdict kept at the bottom. Separate from
// the editor's remembered view so opening a flow to review always starts
// on the report.
import { create } from "zustand";

export type ReviewView = "report" | "flow" | "story" | "variables" | "result";

export const useReviewView = create<{ view: ReviewView; setView: (view: ReviewView) => void }>((set) => ({
  view: "report",
  setView: (view) => set({ view }),
}));
