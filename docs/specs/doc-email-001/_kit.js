/**
 * Email kit — flat, fluid, three type sizes.
 *
 * Flat (owner, 21.08): no filled panels, no rounded boxes inside the letter. Hierarchy
 * comes from weight and colour, and hairlines appear only where they separate rows of
 * money. Type is 24 / 15 / 13 and nothing else — the previous draft had seven sizes.
 */
const INK = '#191919', MUTED = '#6E6E6E', FAINT = '#8A8A8A', LINE = '#E6E4E1', CANVAS = '#F1F1F0', ACCENT = '#7F42E1';
const FONT = 'Arial, Helvetica, sans-serif';
const PAD = 'padding-left:32px;padding-right:32px;';

const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const shell = (heading, inner) => `<!DOCTYPE html><html><head>
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
     <tr><td class="pad" style="${PAD}padding-top:30px;color:${FAINT};font-family:${FONT};font-size:13px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;line-height:18px;">ABC Homes</td></tr>
     <tr><td class="pad h1" style="${PAD}padding-top:16px;color:${INK};font-family:${FONT};font-size:24px;font-weight:bold;line-height:31px;">${heading}</td></tr>
     ${inner}
     <tr><td height="34" style="height:34px;font-size:0;line-height:0;">&nbsp;</td></tr>
    </table>
   </td></tr>
   <tr><td class="pad" style="${PAD}padding-top:16px;color:${FAINT};font-family:${FONT};font-size:13px;line-height:19px;">ABC Homes &middot; (617) 555-0134 &middot; help@abchomes.com</td></tr>
  </table>
 </td></tr></table></body></html>`;

const lead = text => `<tr><td class="pad" style="${PAD}padding-top:12px;color:${INK};font-family:${FONT};font-size:15px;line-height:23px;">${text}</td></tr>`;

/** Facts, unpanelled: the label names it, the value answers — colour does the work. */
const facts = rows => `<tr><td class="pad" style="${PAD}padding-top:22px;">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">
  ${rows.filter(Boolean).map(([k, v]) => `<tr>
   <td class="stack" style="padding:3px 12px 3px 0;color:${MUTED};font-family:${FONT};font-size:15px;line-height:23px;">${k}</td>
   <td class="stack stack-value" align="right" style="padding:3px 0;color:${INK};font-family:${FONT};font-size:15px;font-weight:bold;line-height:23px;">${v}</td>
  </tr>`).join('')}
 </table></td></tr>`;

/**
 * The `2 × $140.00` line explains arithmetic. At quantity 1 there is no arithmetic —
 * it just repeats the amount already sitting on the right (owner, 21.08: almost every
 * line is a single unit), so it only appears when the quantity is not one.
 */
const items = list => `<tr><td class="pad" style="${PAD}padding-top:26px;">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">
  <tr><td colspan="2" style="padding:0 0 10px;border-bottom:1px solid ${LINE};color:${FAINT};font-family:${FONT};font-size:13px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;line-height:18px;">Summary</td></tr>
  ${list.map(i => `<tr><td style="padding:14px 14px 14px 0;border-bottom:1px solid ${LINE};color:${INK};font-family:${FONT};font-size:15px;line-height:23px;">
    <span style="font-weight:bold;">${i.name}</span>${i.description ? `<br><span style="color:${MUTED};font-size:13px;line-height:20px;">${i.description}</span>` : ''}${Number(i.qty) !== 1 && i.qty ? `<br><span style="color:${FAINT};font-size:13px;line-height:20px;">${i.qty} &times; ${money(i.rate)}</span>` : ''}
   </td><td align="right" style="padding:14px 0;border-bottom:1px solid ${LINE};color:${INK};font-family:${FONT};font-size:15px;font-weight:bold;line-height:23px;white-space:nowrap;vertical-align:top;">${money(i.amount)}</td></tr>`).join('')}
 </table></td></tr>`;

const totals = rows => `<tr><td class="pad" style="${PAD}padding-top:16px;">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">
  ${rows.filter(Boolean).map(([k, v, kind]) => {
    const isDue = kind === 'due';
    const top = isDue ? `border-top:1px solid ${LINE};padding-top:14px;` : '';
    const weight = kind ? 'bold' : 'normal';
    return `<tr>
      <td style="padding:5px 12px 5px 0;${top}color:${kind ? INK : MUTED};font-family:${FONT};font-size:15px;font-weight:${weight};line-height:23px;">${k}</td>
      <td align="right" style="padding:5px 0;${top}color:${isDue ? ACCENT : INK};font-family:${FONT};font-size:15px;font-weight:${weight};line-height:23px;white-space:nowrap;">${v}</td></tr>`;
  }).join('')}
 </table></td></tr>`;

const button = (label, href) => `<tr><td class="pad cta" style="${PAD}padding-top:24px;">
 <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
  <tr><td bgcolor="${ACCENT}" style="background-color:${ACCENT};">
   <a href="${href}" style="display:inline-block;padding:15px 30px;color:#FFFFFF;font-family:${FONT};font-size:15px;font-weight:bold;line-height:20px;text-decoration:none;text-align:center;">${label}</a>
  </td></tr></table></td></tr>`;

const microcopy = text => `<tr><td class="pad" style="${PAD}padding-top:10px;color:${MUTED};font-family:${FONT};font-size:13px;line-height:20px;">${text}</td></tr>`;

const quietLink = (label, href) => `<tr><td class="pad" style="${PAD}padding-top:18px;font-family:${FONT};font-size:15px;line-height:23px;"><a href="${href}" style="color:${ACCENT};text-decoration:underline;">${label}</a></td></tr>`;

/** The operator's own words — named, not boxed. */
const note = text => text ? `<tr><td class="pad" style="${PAD}padding-top:24px;color:${FAINT};font-family:${FONT};font-size:13px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;line-height:18px;">A note from Dana</td></tr>
<tr><td class="pad" style="${PAD}padding-top:6px;color:${INK};font-family:${FONT};font-size:15px;line-height:23px;">${text}</td></tr>` : '';

const closing = text => `<tr><td class="pad" style="${PAD}padding-top:24px;color:${MUTED};font-family:${FONT};font-size:13px;line-height:20px;">${text}</td></tr>`;

const signoff = (name, role) => `<tr><td class="pad" style="${PAD}padding-top:24px;color:${INK};font-family:${FONT};font-size:15px;line-height:23px;">
 Thanks,<br><span style="font-weight:bold;">${name}</span>${role ? `<br><span style="color:${MUTED};font-size:13px;line-height:20px;">${role}</span>` : ''}
</td></tr>`;

module.exports = { shell, lead, facts, items, totals, button, microcopy, quietLink, note, closing, signoff, money };
