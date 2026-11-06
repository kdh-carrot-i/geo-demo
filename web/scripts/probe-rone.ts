// Inspect R-ONE table rows to tune the Seoul filter (key redacted).
process.loadEnvFile('.env');
const K = process.env.R_ONE_KEY!;
for (const [id, c] of [['A_2024_00445', 'YY'], ['A_2024_00445', 'HY'], ['A_2024_00445', 'QY']]) {
  const t = await (await fetch(`https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do?KEY=${K}&Type=json&STATBL_ID=${id}&DTACYCLE_CD=${c}&pIndex=1&pSize=3`)).text();
  console.log(id, c, t.split(K).join('***').slice(0, 900));
}
