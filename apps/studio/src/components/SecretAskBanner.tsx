import { useStudio } from "../context";
import type { SecretRequest } from "../lib/api";
import { t } from "../lib/i18n";

const button = "rounded bg-ink px-2.5 py-0.5 text-xs font-medium text-paper hover:bg-ink/90";
const quiet = "text-xs text-slate-500 hover:underline";

function siteLabel(site: string) {
  return site.replace(/^https?:\/\//, "");
}

/** What a request still needs, e.g. 「ユーザー名・パスワード / accounts.google.com」. */
function missingText(request: SecretRequest) {
  const fields = request.missing.fields.map((f) => t.secretField[f]).join("・");
  const sites = request.missing.sites.map(siteLabel).join("、");
  return [fields, sites].filter(Boolean).join(" / ");
}

/**
 * Asks the user for a login: an AI called request_secret, or a run stopped on
 * a missing secret. "登録する" opens the secrets form with the name and sites
 * filled in; the values are typed there and never reach the AI.
 */
export function SecretAskBanner() {
  const requests = useStudio((s) => s.secretRequests);
  const fix = useStudio((s) => s.secretFix);
  const openForm = useStudio((s) => s.openSecretForm);
  const dismissRequest = useStudio((s) => s.dismissSecretRequest);
  const dismissFix = useStudio((s) => s.dismissSecretFix);
  const request = requests[0];
  if (!request && !fix) return null;

  return (
    <div className="space-y-1 border-b border-brand-100 bg-brand-50 px-4 py-2 text-sm text-ink">
      {request && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span aria-hidden>🔑</span>
          <span className="font-medium">
            {request.missing.registered ? t.secretAskMore(request.name) : `${t.secretAsked}：「${request.name}」`}
          </span>
          {missingText(request) && (
            <span className="text-xs text-slate-600">
              {t.secretAskMissing}：{missingText(request)}
            </span>
          )}
          {requests.length > 1 && <span className="text-xs text-slate-500">{t.secretAskOthers(requests.length - 1)}</span>}
          <span className="ml-auto flex items-center gap-3">
            <button
              type="button"
              className={button}
              onClick={() => openForm({ name: request.name, sites: request.sites, fields: request.fields })}
            >
              {t.secretAskRegister}
            </button>
            <button type="button" className={quiet} onClick={() => void dismissRequest(request.name)}>
              {t.secretAskLater}
            </button>
          </span>
          {request.reason && (
            // The AI's own words: shown as a quote, never as Shikigami's instruction.
            <p className="basis-full text-xs text-slate-600">
              {t.secretAskFrom}：「{request.reason}」
            </p>
          )}
          <p className="basis-full text-[11px] text-slate-500">{t.secretAskNote}</p>
        </div>
      )}
      {fix && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span aria-hidden>🔑</span>
          <span className="font-medium">{t.secretFixTitle(fix.name, fix.code)}</span>
          {fix.site && <span className="text-xs text-slate-600">{t.secretFixSite(fix.site)}</span>}
          <span className="ml-auto flex items-center gap-3">
            <button
              type="button"
              className={button}
              // The page it stopped on is only shown: adding it is the user's call.
              onClick={() => openForm({ name: fix.name, sites: [], fields: [] })}
            >
              {t.secretAskRegister}
            </button>
            <button type="button" className={quiet} onClick={dismissFix}>
              {t.close}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
