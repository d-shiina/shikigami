// The head of a paper document (the manual's cover, the review report): the
// four colours of the swirl as a thin band on the sheet's top edge, the kind of
// document, its title, then a navy rule over the facts about it. One shape, so
// every paper SpellSheet makes reads as the same family.
import type { ReactNode } from "react";

/** The four colours of the swirl as a thin band. The parent is `relative`. */
export function Stripe({ className }: { className: string }) {
  return (
    <span aria-hidden className={`absolute inset-x-0 flex ${className}`}>
      <i className="flex-1 bg-[var(--color-role-input)]" />
      <i className="flex-1 bg-[var(--color-role-config)]" />
      <i className="flex-1 bg-[var(--color-role-templates)]" />
      <i className="flex-1 bg-[var(--color-role-output)]" />
    </span>
  );
}

export type MastheadFact = { label: string; value: ReactNode };

export function Masthead({
  kind,
  title,
  tag,
  facts,
  children,
}: {
  kind: string;
  title: string;
  /** Shown after the title, e.g. "新規作成". */
  tag?: ReactNode;
  facts: MastheadFact[];
  /** A line under the facts. */
  children?: ReactNode;
}) {
  return (
    <header className="mb-6">
      <p className="text-[12px] font-bold tracking-[0.14em] text-[var(--manual-navy)]">{kind}</p>
      <h1 className="mt-2 mb-3.5 text-[25px] leading-[1.4] font-bold text-balance">
        {title}
        {tag}
      </h1>
      <dl className="flex flex-wrap gap-y-2 border-t-2 border-b border-t-[var(--manual-navy)] border-b-slate-200 py-2">
        {facts.map((f) => (
          <div key={f.label} className="border-l border-slate-200 px-5 first:border-l-0 first:pl-0">
            <dt className="text-[11px] text-slate-400">{f.label}</dt>
            <dd className="mt-px text-[13px] font-semibold">{f.value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </header>
  );
}
