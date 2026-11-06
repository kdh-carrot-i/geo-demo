// End-to-end smoke test of the local API proxy (start it first: npm run dev:api).
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787';

async function get(path: string) {
  const r = await fetch(BASE + path);
  return { status: r.status, body: await r.json() };
}
const short = (v: unknown) => JSON.stringify(v).slice(0, 400);

for (const q of ['세종대로 110', '서울 중구 세종대로 110', '서울시청', '강남역']) {
  const { status, body } = await get(`/api/geocode?q=${encodeURIComponent(q)}`);
  const top = Array.isArray(body) ? body[0] : body;
  console.log(`geocode "${q}" → ${status} n=${Array.isArray(body) ? body.length : '-'} ${short(top && { label: top.label, road: top.road, lon: top.lon, lat: top.lat, precision: top.precision, source: top.source })}`);
}

const r = await get('/api/reverse?lon=126.978&lat=37.5665');
console.log(`reverse → ${r.status} ${short(r.body)}`);

const p = await get('/api/parcel?lon=126.978&lat=37.5665');
console.log(`parcel → ${p.status} ${short(p.body.map?.((x: { pnu: string; address: string; officialPrice: number }) => ({ pnu: x.pnu, address: x.address, officialPrice: x.officialPrice })))}`);

const b = await fetch(`${BASE}/api/geocode/batch`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ addresses: ['서울 중구 세종대로 110', '강남구 테헤란로 152', '없는주소xyz', ''] }),
});
const rows = (await b.json()) as Array<{ query: string; status: string; best?: { label: string; precision: string } }>;
console.log(`batch → ${b.status}`);
for (const row of rows) console.log(`  ${row.status.padEnd(8)} ${row.query} ${row.best ? `→ ${row.best.label} (${row.best.precision})` : ''}`);
