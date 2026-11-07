// The parts every section of the settings place is built from, so they all
// line up: a group is one sheet, each setting one row with its name and a
// short hint on the left and the control on the right (like Windows 11 and
// VS Code settings). Narrow panes stack the two columns.
import type { ReactNode } from "react";

/** A titled sheet of rows. `footer` holds the section's buttons, right-aligned. */
export function SettingsGroup({
  title,
  description,
  footer,
  children,
}: {
  title?: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      {(title || description) && (
        <div className="px-1">
          {title && <h4 className="text-[13px] font-bold text-slate-700">{title}</h4>}
          {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
        </div>
      )}
      <div className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-sheet shadow-sheet">
        {children}
        {footer && <div className="flex items-center justify-end gap-3 bg-slate-50 px-4 py-2">{footer}</div>}
      </div>
    </div>
  );
}

/** One setting: its name (and hint) left, its control right. */
export function SettingsRow({
  label,
  hint,
  htmlFor,
  align = "center",
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  /** `start` for tall controls (text areas, tables), so the name stays at their top. */
  align?: "center" | "start";
  children: ReactNode;
}) {
  return (
    <div
      className={`grid grid-cols-1 gap-x-6 gap-y-1.5 px-4 py-2.5 @min-[640px]:grid-cols-[minmax(180px,2fr)_minmax(0,3fr)] ${
        align === "center" ? "@min-[640px]:items-center" : "@min-[640px]:items-start"
      }`}
    >
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
            {label}
          </label>
        ) : (
          <div className="text-[13px] font-medium text-ink">{label}</div>
        )}
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-slate-500">{hint}</div>}
      </div>
      <div className="min-w-0 text-[13px]">{children}</div>
    </div>
  );
}

export const settingsInput =
  "w-full rounded-md border border-slate-300 bg-sheet px-2 py-1 text-[13px] text-ink focus:border-ink focus:outline-none";
export const settingsSelect =
  "rounded-md border border-slate-300 bg-sheet px-1.5 py-1 text-[13px] text-ink focus:border-ink focus:outline-none";
export const settingsPrimary =
  "rounded-lg bg-primary px-3 py-1 text-[13px] font-medium text-on-primary hover:bg-primary-hover disabled:bg-slate-300";
