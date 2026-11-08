import { t } from "../lib/i18n";

/** 「実行時に入力」: an input with no default, asked for when the flow runs. */
export function AskedAtRunTag() {
  return (
    <span
      title={t.vars.askedAtRunTitle}
      className="inline-block rounded-sm border border-accent-500/50 bg-accent-500/10 px-1.5 text-[11px] leading-[18px] font-semibold whitespace-nowrap text-accent-600"
    >
      {t.vars.askedAtRun}
    </span>
  );
}
