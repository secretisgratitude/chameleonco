const labels = [
  'a buyer you can name',
  'the problem is real',
  'someone says yes to a next step',
  'a yes to a price',
  'money lands',
  'it happens again'
];

function date(value) {
  if (value === undefined || value === null || value === '') return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString().slice(0, 10);
}
function buyer(thread) {
  return typeof thread.to === 'string' && thread.to.trim() ? thread.to.trim() :
    typeof thread.buyer === 'string' && thread.buyer.trim() ? thread.buyer.trim() : null;
}
function proof(text, at) { return { text, date: date(at) }; }

export function ladder(threads) {
  const items = Array.isArray(threads) ? threads.filter(t => t && typeof t === 'object') : [];
  const named = items.find(t => buyer(t));
  const replied = items.find(t => Array.isArray(t.replies) && t.replies.some(r => typeof r?.text === 'string' && r.text.trim()));
  const won = items.filter(t => t.status === 'won');
  const priced = items.find(t => t.price !== undefined && t.price !== null && t.price !== '');
  const paid = items.find(t => t.paid !== undefined && t.paid !== null && t.paid !== false && t.paid !== '');
  const reply = replied?.replies.find(r => typeof r?.text === 'string' && r.text.trim());
  const evidence = [
    named && proof('a buyer was named', named.createdAt),
    replied && proof('a buyer replied', reply.at || replied.repliedAt),
    won[0] && proof('a buyer agreed to a next step', won[0].wonAt),
    priced && proof('a buyer agreed to a price', priced.pricedAt || priced.wonAt),
    paid && proof('a buyer paid', paid.paidAt),
    won[1] && proof('a second buyer agreed to a next step', won[1].wonAt)
  ];
  const current = evidence.findIndex(value => !value);
  return labels.map((label, index) => ({ id: `G${index}`, label, state: evidence[index] ? 'met' : index === current ? 'current' : 'ahead', ...(evidence[index] ? { evidence: evidence[index] } : {}) }));
}
