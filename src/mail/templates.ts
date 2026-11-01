import type { Locale } from "@br-ia/protocol";
import type { Mail } from "./mailer.ts";

/*
 * Modèles d'e-mails. Le HTML reste simple et entièrement en styles en ligne,
 * pour s'afficher correctement dans Gmail, Outlook et les applications mobiles.
 * Couleurs de la charte des interfaces : le bleu du logo et des gris neutres.
 * Le nom « <br/> » contient des chevrons : il est échappé dans le HTML.
 */

const BRAND = "<br/>";
const BRAND_HTML = "&lt;br/&gt;";

const COLORS = {
  brand: "#1860a0",
  page: "#f6f4f2",
  card: "#ffffff",
  text: "#2b2724",
  muted: "#6f6862",
  border: "#e6e1dc",
  codeBackground: "#f6f4f2",
};

const TEXTS = {
  fr: {
    subject: (code: string) => `Votre code de connexion ${BRAND} : ${code}`,
    preheader: (code: string) => `Votre code : ${code}. Valable 10 minutes.`,
    title: "Votre code de connexion",
    intro: (brand: string) => `Saisissez ce code dans VS Code pour vous connecter à ${brand}.`,
    validity: "Il est valable 10 minutes.",
    ignore:
      "Si vous n'avez rien demandé, ignorez simplement cet e-mail : personne ne pourra se connecter sans ce code.",
    footer: (brand: string) => `${brand} · redonner un sens au travail d'équipe`,
  },
  en: {
    subject: (code: string) => `Your ${BRAND} sign-in code: ${code}`,
    preheader: (code: string) => `Your code: ${code}. Valid for 10 minutes.`,
    title: "Your sign-in code",
    intro: (brand: string) => `Enter this code in VS Code to sign in to ${brand}.`,
    validity: "It is valid for 10 minutes.",
    ignore: "If you did not ask for it, simply ignore this email: nobody can sign in without this code.",
    footer: (brand: string) => `${brand} · giving meaning back to teamwork`,
  },
} satisfies Record<Locale, unknown>;

/** Ce qui change quand le code confirme la nouvelle adresse d'un compte. */
const EMAIL_CHANGE_TEXTS = {
  fr: {
    subject: (code: string) => `Confirmez votre nouvelle adresse ${BRAND} : ${code}`,
    title: "Confirmez votre nouvelle adresse",
    intro: (brand: string) =>
      `Saisissez ce code dans ${brand} pour utiliser cette adresse avec votre compte.`,
    ignore:
      "Si vous n'avez rien demandé, ignorez simplement cet e-mail : votre adresse ne changera pas sans ce code.",
  },
  en: {
    subject: (code: string) => `Confirm your new ${BRAND} address: ${code}`,
    title: "Confirm your new address",
    intro: (brand: string) => `Enter this code in ${brand} to use this address with your account.`,
    ignore:
      "If you did not ask for it, simply ignore this email: your address will not change without this code.",
  },
} satisfies Record<Locale, unknown>;

/** E-mail contenant un code à 6 chiffres : pour se connecter, ou pour confirmer une nouvelle adresse. */
export function loginCodeMail(
  to: string,
  code: string,
  locale: Locale,
  purpose: "login" | "email_change" = "login",
): Mail {
  const t = { ...TEXTS[locale], ...(purpose === "email_change" ? EMAIL_CHANGE_TEXTS[locale] : {}) };
  const text = `${t.title} : ${code}\n\n${t.intro(BRAND)} ${t.validity}\n\n${t.ignore}\n\n${t.footer(BRAND)}`;
  const html = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${t.title}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.page};">
<div style="display:none;max-height:0;overflow:hidden;">${t.preheader(code)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};">
<tr><td align="center" style="padding:40px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:6px;">
    <tr><td style="padding:28px 36px 0;font-family:'IBM Plex Mono',Consolas,'Courier New',monospace;font-size:20px;font-weight:600;color:${COLORS.brand};">${BRAND_HTML}</td></tr>
    <tr><td style="padding:20px 36px 0;font-family:'IBM Plex Sans','Segoe UI',Arial,sans-serif;font-size:26px;line-height:1.3;font-weight:600;color:${COLORS.text};">${t.title}</td></tr>
    <tr><td style="padding:12px 36px 0;font-family:'IBM Plex Sans','Segoe UI',Arial,sans-serif;font-size:18px;line-height:1.5;color:${COLORS.text};">${t.intro(BRAND_HTML)}</td></tr>
    <tr><td style="padding:24px 36px;">
      <div style="padding:20px 0;background:${COLORS.codeBackground};border:1px solid ${COLORS.border};border-radius:6px;text-align:center;font-family:'IBM Plex Mono',Consolas,'Courier New',monospace;font-size:44px;line-height:1;font-weight:700;letter-spacing:12px;color:${COLORS.brand};">${code}</div>
    </td></tr>
    <tr><td style="padding:0 36px;font-family:'IBM Plex Sans','Segoe UI',Arial,sans-serif;font-size:17px;line-height:1.5;color:${COLORS.text};">${t.validity}</td></tr>
    <tr><td style="padding:16px 36px 32px;font-family:'IBM Plex Sans','Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.5;color:${COLORS.muted};">${t.ignore}</td></tr>
  </table>
  <p style="margin:20px 0 0;font-family:'IBM Plex Sans','Segoe UI',Arial,sans-serif;font-size:13px;color:${COLORS.muted};">${t.footer(BRAND_HTML)}</p>
</td></tr>
</table>
</body>
</html>`;
  return { to, subject: t.subject(code), text, html };
}
