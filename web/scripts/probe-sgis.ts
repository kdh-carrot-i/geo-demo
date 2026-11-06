// Find how SGIS returns the 시도 list (keys redacted).
import { E, getJson, redact } from '../etl/lib.ts';
const H = 'https://sgisapi.mods.go.kr/OpenAPI3';
const at = (await getJson(`${H}/auth/authentication.json?consumer_key=${E.SGIS_SERVICE_ID}&consumer_secret=${E.SGIS_SECRET_KEY}`)).result.accessToken;
for (const q of ['year=2024', 'year=2024&low_search=1', 'year=2023&low_search=1']) {
  const j = await getJson(`${H}/stats/population.json?accessToken=${at}&${q}`);
  console.log(q, redact(JSON.stringify({ err: j.errCd, msg: j.errMsg, n: j.result?.length, r: j.result?.slice(0, 3).map((r: any) => `${r.adm_cd}:${r.adm_nm}`) })));
}
const s = await getJson(`${H}/addr/stage.json?accessToken=${at}`);
console.log('stage', redact(JSON.stringify({ err: s.errCd, r: s.result?.map((r: any) => `${r.cd}:${r.addr_name}`) })));
