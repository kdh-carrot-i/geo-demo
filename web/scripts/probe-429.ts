process.loadEnvFile('.env');
const K = process.env.DATA_GO_KR_SERVICE_KEY!;
const r = await fetch(`https://apis.data.go.kr/1613000/RTMSDataSvcNrgTrade/getRTMSDataSvcNrgTrade?serviceKey=${encodeURIComponent(K)}&LAWD_CD=11110&DEAL_YMD=202601&numOfRows=1&pageNo=1`);
console.log(r.status, (await r.text()).split(K).join('***').slice(0, 600));
