import { t } from "../lib/i18n";
/** The mark for a variable, "{x}" as in Power Automate, in the variable's own colour. */
export function VarIcon({ className = "", size = 12 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={`shrink-0 ${className}`} aria-label={t.variables} role="img">
      <path
        d="M5 2.5H4.2Q3 2.5 3 3.7v2.6Q3 8 1.8 8 3 8 3 9.7v2.6q0 1.2 1.2 1.2H5M11 2.5h.8q1.2 0 1.2 1.2v2.6Q13 8 14.2 8 13 8 13 9.7v2.6q0 1.2-1.2 1.2H11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M6.3 5.8l3.4 4.4M9.7 5.8l-3.4 4.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
