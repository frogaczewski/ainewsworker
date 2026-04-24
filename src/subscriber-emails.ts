import { EMAIL_FROM } from './config';
import { postMailjet, resolvePublicOrigin } from './email';
import type { Env, SubscriberLang } from './types';

interface ConfirmCopy {
  subject: string;
  greeting: string;
  lead: string;
  ctaLabel: string;
  fallback: string;
  ignoreLine: string;
}

const SUBSCRIBE_CONFIRM_COPY: Record<SubscriberLang, ConfirmCopy> = {
  en: {
    subject: 'Confirm your AI News Digest subscription',
    greeting: 'Almost there — confirm your subscription',
    lead: 'You (or someone using this address) asked to subscribe to the AI News Digest. Click the button below to start receiving the daily briefing.',
    ctaLabel: 'Confirm subscription',
    fallback: "If the button doesn't work, paste this link into your browser:",
    ignoreLine: "Didn't ask for this? You can ignore this email — you won't be subscribed.",
  },
  pl: {
    subject: 'Potwierdź subskrypcję AI News Digest',
    greeting: 'Już prawie — potwierdź swoją subskrypcję',
    lead: 'Ktoś (być może Ty) poprosił o subskrypcję codziennego przeglądu wiadomości. Kliknij poniżej, aby zacząć otrzymywać newsletter.',
    ctaLabel: 'Potwierdź subskrypcję',
    fallback: 'Jeśli przycisk nie działa, wklej ten link do przeglądarki:',
    ignoreLine: 'Nie prosiłeś/aś o to? Zignoruj ten e-mail — subskrypcja nie zostanie aktywowana.',
  },
};

const UNSUB_CONFIRM_COPY: Record<SubscriberLang, ConfirmCopy> = {
  en: {
    subject: 'Confirm unsubscribe from AI News Digest',
    greeting: 'Confirm your unsubscribe',
    lead: 'Click the link below to finalize unsubscribing from the AI News Digest. After you click, no more digests will be sent to this address.',
    ctaLabel: 'Confirm unsubscribe',
    fallback: "If the button doesn't work, paste this link into your browser:",
    ignoreLine: 'Changed your mind? Just ignore this email — you will stay subscribed.',
  },
  pl: {
    subject: 'Potwierdź wypisanie z AI News Digest',
    greeting: 'Potwierdź wypisanie',
    lead: 'Kliknij poniższy link, aby dokończyć wypisywanie z codziennego przeglądu wiadomości. Po kliknięciu nie będziemy już wysyłać wiadomości na ten adres.',
    ctaLabel: 'Potwierdź wypisanie',
    fallback: 'Jeśli przycisk nie działa, wklej ten link do przeglądarki:',
    ignoreLine: 'Zmieniłeś/aś zdanie? Zignoruj tę wiadomość — subskrypcja zostanie zachowana.',
  },
};

function renderTransactionalHtml(copy: ConfirmCopy, url: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body{font-family:Garamond,'EB Garamond','Times New Roman',Georgia,serif;line-height:1.7;color:#2D2A26;max-width:560px;margin:0 auto;padding:24px;background:#F7F3EE}
h1{font-size:22px;font-weight:700;color:#2D2A26;margin:0 0 16px 0}
p{margin:12px 0;font-size:16px;color:#5C4A3A}
.cta{display:inline-block;background:#9B4D3A;color:#FAF6F0;padding:14px 28px;margin:16px 0;font-weight:600;text-decoration:none}
.cta:hover{background:#7A3A2B}
.fallback{font-size:13px;color:#8B7B6B;word-break:break-all}
.fallback a{color:#9B4D3A}
.small{font-size:13px;color:#8B7B6B;margin-top:32px;border-top:1px solid #DDD5CA;padding-top:16px}
</style></head>
<body>
  <h1>${copy.greeting}</h1>
  <p>${copy.lead}</p>
  <p><a class="cta" href="${url}">${copy.ctaLabel}</a></p>
  <p class="fallback">${copy.fallback}<br><a href="${url}">${url}</a></p>
  <p class="small">${copy.ignoreLine}</p>
</body></html>`;
}

function renderTransactionalText(copy: ConfirmCopy, url: string): string {
  return `${copy.greeting}

${copy.lead}

${copy.ctaLabel}: ${url}

${copy.ignoreLine}`;
}

export async function sendSubscribeConfirmEmail(
  env: Env,
  email: string,
  name: string | undefined,
  lang: SubscriberLang,
  confirmToken: string,
): Promise<void> {
  const copy = SUBSCRIBE_CONFIRM_COPY[lang];
  const origin = resolvePublicOrigin(env);
  const url = `${origin}/confirm?token=${encodeURIComponent(confirmToken)}`;
  const toName = name && name.trim().length > 0 ? name : email;

  await postMailjet(env, {
    Messages: [{
      From: { Email: EMAIL_FROM.email, Name: EMAIL_FROM.name },
      To: [{ Email: email, Name: toName }],
      Subject: copy.subject,
      HTMLPart: renderTransactionalHtml(copy, url),
      TextPart: renderTransactionalText(copy, url),
    }],
  });
}

export async function sendUnsubscribeConfirmEmail(
  env: Env,
  email: string,
  lang: SubscriberLang,
  confirmToken: string,
): Promise<void> {
  const copy = UNSUB_CONFIRM_COPY[lang];
  const origin = resolvePublicOrigin(env);
  const url = `${origin}/finalize-unsubscribe?token=${encodeURIComponent(confirmToken)}`;

  await postMailjet(env, {
    Messages: [{
      From: { Email: EMAIL_FROM.email, Name: EMAIL_FROM.name },
      To: [{ Email: email, Name: email }],
      Subject: copy.subject,
      HTMLPart: renderTransactionalHtml(copy, url),
      TextPart: renderTransactionalText(copy, url),
    }],
  });
}

export async function sendRateLimitAlarmEmail(
  env: Env,
  detail: { globalCount: number; windowLabel: string },
): Promise<void> {
  const subject = `[ALARM] AI News Digest — unusual subscribe volume`;
  const body = `Subscribe endpoint fired ${detail.globalCount} times in the current hour window (${detail.windowLabel}), exceeding the alarm threshold.\n\nInspect KV key ratelimit:global:${detail.windowLabel} and the alarm:throttle key.\n\nAlarm will re-fire at most once per 24h.`;

  await postMailjet(env, {
    Messages: [{
      From: { Email: EMAIL_FROM.email, Name: EMAIL_FROM.name },
      To: [{ Email: 'frogaczewski@gmail.com', Name: 'Filip Rogaczewski' }],
      Subject: subject,
      TextPart: body,
    }],
  });
}
