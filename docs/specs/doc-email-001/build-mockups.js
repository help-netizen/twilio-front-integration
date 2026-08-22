const K = require('./_kit');
const fs = require('fs');

const ITEMS = [
  { name: 'Service call fee', description: 'Non-refundable service fee. Trip and diagnostic included.', qty: 1, rate: 95, amount: 95 },
  { name: 'Drain pump replacement', description: 'OEM pump, includes labour.', qty: 1, rate: 320, amount: 320 },
  { name: 'Door seal', description: 'Replaced on both compartments.', qty: 2, rate: 45, amount: 90 },
];
const SUB = 505, DISC = 300, TAX = 5.70, TOTAL = 210.70;
const PAY = 'https://app.albusto.com/pay/RNWDKZuwbj0';
const APPROVE = 'https://app.albusto.com/e/8fJq2Lm';
/* Trust, not speed (owner, 21.08): what reassures at the moment of paying is who is
   holding the card details, not how long it takes. */
const TRUST = 'Card or bank — payments secured by Stripe.';

fs.writeFileSync('02-invoice-proposed.html', K.shell(K.money(TOTAL) + ' due by Aug 23',
  K.lead('Hi Dana — the work is finished. Please review invoice <b>J-1516-1</b> and pay <b>' + K.money(TOTAL) + '</b> by <b>Aug 23</b>.') +
  K.button('Review &amp; pay ' + K.money(TOTAL), PAY) + K.microcopy(TRUST) +
  K.facts([['Service date', 'Aug 18, 2026'], ['Service address', '18 Marlborough St, Boston, MA 02116']]) +
  K.items(ITEMS) +
  K.totals([['Subtotal', K.money(SUB)], ['Discount', '&minus;' + K.money(DISC)], ['Tax', K.money(TAX)], ['Amount due', K.money(TOTAL), 'due']]) +
  K.quietLink('Review &amp; pay ' + K.money(TOTAL), PAY) +
  K.closing('Something looks wrong? Reply to this email and we will sort it out. The PDF is attached.') +
  K.signoff('Dana', 'ABC Homes')
));

fs.writeFileSync('02b-invoice-partly-paid.html', K.shell(K.money(150.70) + ' still due by Aug 23',
  K.lead('Hi Dana — thanks for the ' + K.money(60) + ' already paid. Please review invoice <b>J-1516-1</b> and settle the remaining <b>' + K.money(150.70) + '</b> by <b>Aug 23</b>.') +
  K.button('Review &amp; pay ' + K.money(150.70), PAY) + K.microcopy(TRUST) +
  K.facts([['Service date', 'Aug 18, 2026'], ['Service address', '18 Marlborough St, Boston, MA 02116']]) +
  K.items(ITEMS) +
  K.totals([['Subtotal', K.money(SUB)], ['Discount', '&minus;' + K.money(DISC)], ['Tax', K.money(TAX)], ['Invoice total', K.money(TOTAL)], ['Paid so far', '&minus;' + K.money(60)], ['Amount due', K.money(150.70), 'due']]) +
  K.quietLink('Review &amp; pay ' + K.money(150.70), PAY) +
  K.note('The replacement pump is on order — I will call you Thursday to schedule the fitting.') +
  K.closing('Something looks wrong? Reply to this email and we will sort it out. The PDF is attached.') +
  K.signoff('Dana', 'ABC Homes')
));

fs.writeFileSync('02c-invoice-overdue.html', K.shell(K.money(TOTAL) + ' — past due since Aug 23',
  K.lead('Hi Dana — invoice <b>J-1516-1</b> was due on <b>Aug 23</b> and is still open. Please review it and pay <b>' + K.money(TOTAL) + '</b> today.') +
  K.button('Review &amp; pay ' + K.money(TOTAL), PAY) + K.microcopy(TRUST) +
  K.facts([['Invoice date', 'Aug 18, 2026'], ['Due', 'Aug 23, 2026 &middot; 5 days ago']]) +
  K.items(ITEMS) +
  K.totals([['Subtotal', K.money(SUB)], ['Discount', '&minus;' + K.money(DISC)], ['Tax', K.money(TAX)], ['Amount due', K.money(TOTAL), 'due']]) +
  K.quietLink('Review &amp; pay ' + K.money(TOTAL), PAY) +
  K.closing('Already paid, or something looks wrong? Reply and we will check it right away. The PDF is attached.') +
  K.signoff('Dana', 'ABC Homes')
));

fs.writeFileSync('04-estimate-proposed.html', K.shell('Your estimate — ' + K.money(TOTAL),
  K.lead('Hi Dana — here is estimate <b>L-1516-2</b> for the work we discussed: <b>' + K.money(TOTAL) + '</b>. Approve it and we will get you on the schedule; nothing is charged until you do.') +
  K.button('Approve this estimate', APPROVE) + K.microcopy('One tap, no account needed. Valid until Sep 1.') +
  K.facts([['Service address', '18 Marlborough St, Boston, MA 02116']]) +
  K.items(ITEMS) +
  K.totals([['Subtotal', K.money(SUB)], ['Discount', '&minus;' + K.money(DISC)], ['Tax', K.money(TAX)], ['Estimate total', K.money(TOTAL), 'due']]) +
  K.quietLink('Approve this estimate', APPROVE) +
  K.closing('Want to change something first? Reply to this email. The PDF is attached.') +
  K.signoff('Dana', 'ABC Homes')
));

fs.writeFileSync('06-receipt-proposed.html', K.shell('Payment received — ' + K.money(60),
  K.lead('Hi Dana — thank you. We have recorded your payment against invoice <b>J-1516-1</b>.') +
  K.facts([['Payment date', 'Aug 18, 2026'], ['Payment method', 'Card ending 6208']]) +
  K.totals([['Invoice total', K.money(TOTAL)], ['Paid so far', '&minus;' + K.money(60)], ['Remaining balance', K.money(150.70), 'due']]) +
  K.quietLink('Review &amp; pay the remaining ' + K.money(150.70), PAY) +
  K.microcopy(TRUST) +
  K.closing('Your receipt is attached as a PDF.') +
  K.signoff('Mike', 'ABC Homes')
));

fs.writeFileSync('06b-receipt-settled.html', K.shell('Payment received — ' + K.money(TOTAL),
  K.lead('Hi Dana — thank you. Invoice <b>J-1516-1</b> is now paid in full.') +
  K.facts([['Payment date', 'Aug 18, 2026'], ['Payment method', 'Card ending 6208']]) +
  K.totals([['Invoice total', K.money(TOTAL)], ['Paid so far', '&minus;' + K.money(TOTAL)], ['Nothing further due', '', 'due']]) +
  K.closing('Your receipt is attached as a PDF.') +
  K.signoff('Dana', 'ABC Homes')
));

console.log('six letters rebuilt: flat, fluid, 24/15/13, secured by Stripe');

/* ── Зачёт уже оплаченного ─────────────────────────────────────────────────
   Повод бывает разный: аванс 50%, выезд, доплата за деталь. Документ не должен
   его называть — только сумму. Кредит стоит ПОСЛЕ налога: те деньги уже были
   обложены на своём документе. */
const CREDIT_ITEMS = [
  { name: 'Dishwasher repair — labour', description: 'Pump replacement and drain line flush.', qty: 1, rate: 210, amount: 210 },
  { name: 'Parts', description: 'OEM drain pump.', qty: 1, rate: 70, amount: 70 },
];
const C_SUB = 280, C_TAX = 20, C_TOTAL = 300, C_PAID = 95, C_LEFT = 205;

fs.writeFileSync('07-estimate-credit.html', K.shell('Your estimate — ' + K.money(C_TOTAL),
  K.lead('Hi Dana — here is estimate <b>L-1516-3</b> for the work we discussed: <b>' + K.money(C_TOTAL) + '</b>, less the <b>' + K.money(C_PAID) + '</b> you have paid so far on this job — <b>' + K.money(C_LEFT) + '</b> to go. Approve it and we will get you on the schedule.') +
  K.button('Approve this estimate', APPROVE) + K.microcopy('One tap, no account needed. Valid until Sep 1.') +
  K.facts([['Service address', '18 Marlborough St, Boston, MA 02116']]) +
  K.items(CREDIT_ITEMS) +
  K.totals([['Subtotal', K.money(C_SUB)], ['Tax', K.money(C_TAX)], ['Estimate total', K.money(C_TOTAL)], ['Paid so far', '&minus;' + K.money(C_PAID)], ['Left to pay', K.money(C_LEFT), 'due']]) +
  K.quietLink('Approve this estimate', APPROVE) +
  K.closing('Want to change something first? Reply to this email. The PDF is attached.') +
  K.signoff('Dana', 'ABC Homes')
));

fs.writeFileSync('08-invoice-credit.html', K.shell(K.money(C_LEFT) + ' due by Sep 5',
  K.lead('Hi Dana — the work is finished. Please review invoice <b>J-1516-4</b> and pay <b>' + K.money(C_LEFT) + '</b> by <b>Sep 5</b>. The <b>' + K.money(C_PAID) + '</b> you paid earlier is already applied.') +
  K.button('Review &amp; pay ' + K.money(C_LEFT), PAY) + K.microcopy(TRUST) +
  K.facts([['Service date', 'Aug 28, 2026'], ['Service address', '18 Marlborough St, Boston, MA 02116']]) +
  K.items(CREDIT_ITEMS) +
  K.totals([['Subtotal', K.money(C_SUB)], ['Tax', K.money(C_TAX)], ['Invoice total', K.money(C_TOTAL)], ['Paid so far', '&minus;' + K.money(C_PAID)], ['Amount due', K.money(C_LEFT), 'due']]) +
  K.quietLink('Review &amp; pay ' + K.money(C_LEFT), PAY) +
  K.closing('Something looks wrong? Reply to this email and we will sort it out. The PDF is attached.') +
  K.signoff('Dana', 'ABC Homes')
));
console.log('credit pair rendered: estimate 300 − 95 = 205, invoice matches');
