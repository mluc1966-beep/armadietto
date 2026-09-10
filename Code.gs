/**
 * Armadietto Medicinali v5 - backend Google Apps Script
 * Funzioni:
 *  - ricerca AIFA nome -> ATC livello 2
 *  - backup cloud JSON protetto da PIN
 *  - proxy Gemini per lettura confezioni
 *
 * PRIMA DEL DEPLOY:
 * 1. In "Impostazioni progetto > Proprietà script" crea:
 *      ARMADIETTO_PIN = il tuo PIN
 * 2. Distribuisci come "App web":
 *      Esegui come: te
 *      Chi ha accesso: chiunque
 * 3. Copia l'URL /exec nell'app.
 */

const AIFA_PACKAGES_URL = 'https://drive.aifa.gov.it/farmaci/confezioni_fornitura.csv';
const AIFA_ATC_URL = 'https://drive.aifa.gov.it/farmaci/atc.csv';
const BACKUP_FILE = 'armadietto_v5_backup.json';

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    const a = String((e.parameter && e.parameter.action) || '');
    if (a === 'aifaSearch') return json_(aifaSearch_(e.parameter.q || ''));
    if (a === 'syncGet') return json_(syncGet_(e.parameter.pin || ''));
    return json_({ok:true, service:'Armadietto v5 backend'});
  } catch (err) {
    return json_({ok:false,error:String(err && err.message || err)});
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (body.action === 'syncPut') return json_(syncPut_(body.pin || '', body.data));
    if (body.action === 'gemini') return json_(gemini_(body));
    return json_({ok:false,error:'Azione non riconosciuta'});
  } catch (err) {
    return json_({ok:false,error:String(err && err.message || err)});
  }
}

function norm_(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();
}

function detectDelimiter_(text) {
  const first = String(text).split(/\r?\n/,1)[0] || '';
  const counts = {',':(first.match(/,/g)||[]).length,';':(first.match(/;/g)||[]).length,'\t':(first.match(/\t/g)||[]).length};
  return Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
}

function fetchCsv_(url) {
  const r = UrlFetchApp.fetch(url,{muteHttpExceptions:true,followRedirects:true});
  if (r.getResponseCode() !== 200) throw new Error('AIFA HTTP '+r.getResponseCode());
  const text = r.getContentText('UTF-8');
  return Utilities.parseCsv(text, detectDelimiter_(text));
}

function headerIndex_(head, names) {
  const n = head.map(norm_);
  for (const wanted of names) {
    const i = n.indexOf(norm_(wanted));
    if (i >= 0) return i;
  }
  return -1;
}

function aifaSearch_(query) {
  const q = norm_(query);
  if (q.length < 3) return {ok:true,results:[]};

  const cache = CacheService.getScriptCache();
  const key = 'AIFA_Q_'+Utilities.base64EncodeWebSafe(q).slice(0,70);
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  const rows = fetchCsv_(AIFA_PACKAGES_URL);
  if (rows.length < 2) throw new Error('Anagrafica AIFA vuota');
  const h = rows[0];
  const iName = headerIndex_(h,['DENOMINAZIONE','DENOMINAZIONE_MEDICINALE','NOME_MEDICINALE']);
  const iAtc = headerIndex_(h,['CODICE_ATC','ATC']);
  const iAic = headerIndex_(h,['CODICE_AIC','AIC','COD_FARMACO']);
  if (iName < 0 || iAtc < 0) throw new Error('Colonne AIFA non riconosciute');

  const scored = [];
  for (let i=1;i<rows.length;i++) {
    const r=rows[i], name=String(r[iName]||''), atc=String(r[iAtc]||'').trim();
    if (!name || !atc) continue;
    const n=norm_(name);
    let score=0;
    if(n===q) score=100;
    else if(n.startsWith(q+' ')) score=80;
    else if(n.includes(q)) score=60;
    else {
      const words=q.split(' ').filter(x=>x.length>2);
      if(words.length && words.every(w=>n.includes(w))) score=45;
    }
    if(score) scored.push({score,name,atc,aic:iAic>=0?String(r[iAic]||''):''});
  }
  scored.sort((a,b)=>b.score-a.score || a.name.length-b.name.length);

  const atc2Codes=[...new Set(scored.slice(0,80).map(x=>x.atc.slice(0,3)).filter(x=>x.length===3))];
  const atcRows=fetchCsv_(AIFA_ATC_URL);
  const ah=atcRows[0]||[];
  const aiCode=headerIndex_(ah,['CODICE_ATC','ATC']);
  const aiDesc=headerIndex_(ah,['DESCRIZIONE','DESCRIZIONE_ATC']);
  const atcMap={};
  for(let i=1;i<atcRows.length;i++){
    const c=String(atcRows[i][aiCode]||'').trim();
    if(c.length===3) atcMap[c]=String(atcRows[i][aiDesc]||'').trim();
  }

  const seen={}, results=[];
  for(const x of scored){
    const atc2=x.atc.slice(0,3);
    if(atc2.length!==3 || seen[atc2]) continue;
    seen[atc2]=1;
    results.push({name:x.name,aic:x.aic,atc:x.atc,atc2,atc2Name:atcMap[atc2]||atc2});
    if(results.length>=6) break;
  }
  const out={ok:true,results};
  try{cache.put(key,JSON.stringify(out),21600)}catch(_){}
  return out;
}

function expectedPin_() {
  return PropertiesService.getScriptProperties().getProperty('ARMADIETTO_PIN') || '';
}
function checkPin_(pin) {
  const expected=expectedPin_();
  if(!expected) throw new Error('ARMADIETTO_PIN non configurato nelle Proprietà script');
  if(String(pin)!==String(expected)) throw new Error('PIN non valido');
}
function backupFile_() {
  const it=DriveApp.getFilesByName(BACKUP_FILE);
  return it.hasNext()?it.next():null;
}
function syncPut_(pin,data) {
  checkPin_(pin);
  const text=JSON.stringify(data||{});
  let f=backupFile_();
  if(f) f.setContent(text); else f=DriveApp.createFile(BACKUP_FILE,text,MimeType.PLAIN_TEXT);
  return {ok:true,updatedAt:new Date().toISOString()};
}
function syncGet_(pin) {
  checkPin_(pin);
  const f=backupFile_();
  if(!f) return {ok:true,data:null};
  return {ok:true,data:JSON.parse(f.getBlob().getDataAsString('UTF-8')),updatedAt:f.getLastUpdated().toISOString()};
}

function gemini_(body) {
  const key=String(body.key||'');
  if(!key) throw new Error('API key Gemini mancante');
  const prompt=String(body.prompt||'');
  const image=String(body.image||'');
  if(!image) throw new Error('Immagine mancante');

  const url='https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key='+encodeURIComponent(key);
  const payload={contents:[{parts:[{text:prompt},{inline_data:{mime_type:'image/jpeg',data:image}}]}],generationConfig:{temperature:0.1,responseMimeType:'application/json'}};
  const r=UrlFetchApp.fetch(url,{method:'post',contentType:'application/json',payload:JSON.stringify(payload),muteHttpExceptions:true});
  if(r.getResponseCode()!==200) throw new Error('Gemini HTTP '+r.getResponseCode()+': '+r.getContentText().slice(0,300));
  const raw=JSON.parse(r.getContentText());
  const text=raw.candidates && raw.candidates[0] && raw.candidates[0].content && raw.candidates[0].content.parts && raw.candidates[0].content.parts[0] && raw.candidates[0].content.parts[0].text;
  if(!text) throw new Error('Nessuna risposta Gemini');
  return {ok:true,result:JSON.parse(String(text).replace(/```json|```/g,'').trim())};
}