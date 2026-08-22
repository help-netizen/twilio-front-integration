'use strict';

/**
 * Shared customer-document email kit. The table structure and typography mirror
 * docs/specs/doc-email-001/_kit.js; dynamic values are escaped at this boundary.
 */
const INK = '#191919';
const MUTED = '#6E6E6E';
const FAINT = '#8A8A8A';
const LINE = '#E6E4E1';
const CANVAS = '#F1F1F0';
const ACCENT = '#7F42E1';
const FONT = 'Arial, Helvetica, sans-serif';
const PAD = 'padding-left:32px;padding-right:32px;';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function money(value) {
    const amount = Number(value || 0);
    const safeAmount = Number.isFinite(amount) ? amount : 0;
    return '$' + safeAmount.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function shell(heading, inner, brand = {}) {
    const brandName = String(brand.name || '').trim() || 'Albusto';
    const footer = [brandName, brand.phone, brand.email]
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .map(escapeHtml)
        .join(' &middot; ');

    return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<!-- Without this a phone lays the mail out at a 980px desktop viewport and scales it
     down: every readable size becomes unreadable. -->
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<style>
  /* Enhancement only — the layout below is fluid, so a client that strips <style>
     still gets a letter that fits its screen. */
  @media only screen and (max-width: 600px) {
    .pad { padding-left: 22px !important; padding-right: 22px !important; }
    .h1 { font-size: 22px !important; line-height: 29px !important; }
    .cta table { width: 100% !important; }
    .cta td { text-align: center !important; }
    .cta a { display: block !important; padding-left: 12px !important; padding-right: 12px !important; }
    .stack { display: block !important; width: 100% !important; text-align: left !important; }
    .stack-value { padding-top: 1px !important; padding-bottom: 10px !important; }
  }
</style>
</head><body style="margin:0;padding:0;background-color:${CANVAS};color:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;background-color:${CANVAS};">
 <tr><td align="center" style="padding:24px 10px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:600px;">
   <tr><td style="background-color:#FFFFFF;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">
     <tr><td class="pad" style="${PAD}padding-top:30px;color:${FAINT};font-family:${FONT};font-size:13px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;line-height:18px;">${escapeHtml(brandName)}</td></tr>
     <tr><td class="pad h1" style="${PAD}padding-top:16px;color:${INK};font-family:${FONT};font-size:24px;font-weight:bold;line-height:31px;">${heading}</td></tr>
     ${inner}
     <tr><td height="34" style="height:34px;font-size:0;line-height:0;">&nbsp;</td></tr>
    </table>
   </td></tr>
   <tr><td class="pad" style="${PAD}padding-top:16px;color:${FAINT};font-family:${FONT};font-size:13px;line-height:19px;">${footer}</td></tr>
  </table>
 </td></tr></table></body></html>`;
}

// `text` is composed from escaped fragments by the document-specific builders.
function lead(text) {
    return `<tr><td class="pad" style="${PAD}padding-top:12px;color:${INK};font-family:${FONT};font-size:15px;line-height:23px;">${text}</td></tr>`;
}

function facts(rows) {
    return `<tr><td class="pad" style="${PAD}padding-top:22px;">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">
  ${rows.filter(Boolean).filter(([, value]) => value !== null && value !== undefined && value !== '').map(([key, value]) => `<tr>
   <td class="stack" style="padding:3px 12px 3px 0;color:${MUTED};font-family:${FONT};font-size:15px;line-height:23px;">${escapeHtml(key)}</td>
   <td class="stack stack-value" align="right" style="padding:3px 0;color:${INK};font-family:${FONT};font-size:15px;font-weight:bold;line-height:23px;">${escapeHtml(value)}</td>
  </tr>`).join('')}
 </table></td></tr>`;
}

function items(list) {
    return `<tr><td class="pad" style="${PAD}padding-top:26px;">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">
  <tr><td colspan="2" style="padding:0 0 10px;border-bottom:1px solid ${LINE};color:${FAINT};font-family:${FONT};font-size:13px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;line-height:18px;">Summary</td></tr>
  ${list.map(item => {
        const quantity = Number(item.qty);
        const quantityLine = Number.isFinite(quantity) && quantity !== 1
            ? `<br><span style="color:${FAINT};font-size:13px;line-height:20px;">${escapeHtml(item.qty)} &times; ${escapeHtml(money(item.rate))}</span>`
            : '';
        return `<tr><td style="padding:14px 14px 14px 0;border-bottom:1px solid ${LINE};color:${INK};font-family:${FONT};font-size:15px;line-height:23px;">
    <span style="font-weight:bold;">${escapeHtml(item.name)}</span>${item.description ? `<br><span style="color:${MUTED};font-size:13px;line-height:20px;">${escapeHtml(item.description)}</span>` : ''}${quantityLine}
   </td><td align="right" style="padding:14px 0;border-bottom:1px solid ${LINE};color:${INK};font-family:${FONT};font-size:15px;font-weight:bold;line-height:23px;white-space:nowrap;vertical-align:top;">${escapeHtml(money(item.amount))}</td></tr>`;
    }).join('')}
 </table></td></tr>`;
}

function totals(rows) {
    return `<tr><td class="pad" style="${PAD}padding-top:16px;">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">
  ${rows.filter(Boolean).map(([key, value, kind]) => {
        const isDue = kind === 'due';
        const top = isDue ? `border-top:1px solid ${LINE};padding-top:14px;` : '';
        const weight = kind ? 'bold' : 'normal';
        return `<tr>
      <td style="padding:5px 12px 5px 0;${top}color:${kind ? INK : MUTED};font-family:${FONT};font-size:15px;font-weight:${weight};line-height:23px;">${escapeHtml(key)}</td>
      <td align="right" style="padding:5px 0;${top}color:${isDue ? ACCENT : INK};font-family:${FONT};font-size:15px;font-weight:${weight};line-height:23px;white-space:nowrap;">${escapeHtml(value)}</td></tr>`;
    }).join('')}
 </table></td></tr>`;
}

function button(label, href) {
    return `<tr><td class="pad cta" style="${PAD}padding-top:24px;">
 <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
  <tr><td bgcolor="${ACCENT}" style="background-color:${ACCENT};">
   <a href="${escapeHtml(href)}" style="display:inline-block;padding:15px 30px;color:#FFFFFF;font-family:${FONT};font-size:15px;font-weight:bold;line-height:20px;text-decoration:none;text-align:center;">${escapeHtml(label)}</a>
  </td></tr></table></td></tr>`;
}

function microcopy(text) {
    return `<tr><td class="pad" style="${PAD}padding-top:10px;color:${MUTED};font-family:${FONT};font-size:13px;line-height:20px;">${escapeHtml(text)}</td></tr>`;
}

function quietLink(label, href) {
    return `<tr><td class="pad" style="${PAD}padding-top:18px;font-family:${FONT};font-size:15px;line-height:23px;"><a href="${escapeHtml(href)}" style="color:${ACCENT};text-decoration:underline;">${escapeHtml(label)}</a></td></tr>`;
}

function note(text, authorName) {
    const value = String(text || '').trim();
    if (!value) return '';
    return `<tr><td class="pad" style="${PAD}padding-top:24px;color:${FAINT};font-family:${FONT};font-size:13px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;line-height:18px;">A note from ${escapeHtml(authorName)}</td></tr>
<tr><td class="pad" style="${PAD}padding-top:6px;color:${INK};font-family:${FONT};font-size:15px;line-height:23px;">${escapeHtml(value).replace(/\r\n|\r|\n/g, '<br>')}</td></tr>`;
}

function closing(text) {
    return `<tr><td class="pad" style="${PAD}padding-top:24px;color:${MUTED};font-family:${FONT};font-size:13px;line-height:20px;">${escapeHtml(text)}</td></tr>`;
}

function signoff(name, role) {
    const roleLine = role
        ? `<br><span style="color:${MUTED};font-size:13px;line-height:20px;">${escapeHtml(role)}</span>`
        : '';
    return `<tr><td class="pad" style="${PAD}padding-top:24px;color:${INK};font-family:${FONT};font-size:15px;line-height:23px;">
 Thanks,<br><span style="font-weight:bold;">${escapeHtml(name)}</span>${roleLine}
</td></tr>`;
}

module.exports = {
    shell,
    lead,
    facts,
    items,
    totals,
    button,
    microcopy,
    quietLink,
    note,
    closing,
    signoff,
    money,
    escapeHtml,
};
