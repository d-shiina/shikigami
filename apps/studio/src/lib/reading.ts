/**
 * The flow chart as a figure to read: nothing on it adds, wires or edits.
 * (Prototype switch: `?reading` in the address.)
 */
export const READING = typeof location !== "undefined" && new URLSearchParams(location.search).has("reading");
