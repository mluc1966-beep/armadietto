/**
 * Armadietto Medicinali v5.0.4 - backend Google Apps Script
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

const AIFA_SEARCH_URL = 'https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/formadosaggio/ricerca';
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
    if (a === 'aifaBarcode') return json_(aifaBarcode_(e.parameter.code || ''));
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

  const searchResponse = UrlFetchApp.fetch(
    AIFA_SEARCH_URL+'?query='+encodeURIComponent(String(query).trim())+'&page=0&size=20',
    {muteHttpExceptions:true,followRedirects:true,headers:{Accept:'application/json'}}
  );
  if(searchResponse.getResponseCode()!==200) throw new Error('Ricerca AIFA HTTP '+searchResponse.getResponseCode());
  const payload=JSON.parse(searchResponse.getContentText('UTF-8'));
  const content=payload && payload.data && payload.data.content || [];
  const atcMap=atc2Map_();
  const seen={}, results=[];
  for(const item of content){
    const med=item.medicinale||{};
    const name=String(med.denominazioneMedicinale||'').trim();
    const active=(item.principiAttiviIt||[]).join(' + ');
    const aic=item.confezioni&&item.confezioni[0]?String(item.confezioni[0].aic||''):'';
    for(const code of (item.codiceAtc||[])){
      const atc=String(code||'').trim(),atc2=atc.slice(0,3);
      if(!name||atc2.length!==3||seen[atc2]) continue;
      seen[atc2]=1;
      results.push({name,aic,atc,atc2,atc2Name:atcMap[atc2]||atc2,active,strength:String(item.descrizioneFormaDosaggio||'')});
      if(results.length>=6) break;
    }
    if(results.length>=6) break;
  }
  const out={ok:true,results};
  try{cache.put(key,JSON.stringify(out),21600)}catch(_){}
  return out;
}

function aifaPayload_(query) {
  const response = UrlFetchApp.fetch(
    AIFA_SEARCH_URL+'?query='+encodeURIComponent(String(query).trim())+'&page=0&size=20',
    {muteHttpExceptions:true,followRedirects:true,headers:{Accept:'application/json'}}
  );
  if(response.getResponseCode()!==200) throw new Error('Ricerca AIFA HTTP '+response.getResponseCode());
  const payload=JSON.parse(response.getContentText('UTF-8'));
  return payload && payload.data && payload.data.content || [];
}

function barcodeInfo_(raw) {
  const text=String(raw||'').trim(), candidates=[];
  const add=function(value){
    const digits=String(value||'').replace(/\D/g,'');
    if(digits.length===9 && candidates.indexOf(digits)<0) candidates.push(digits);
  };
  let match;
  const ai710=/(?:\(710\)|(?:^|\x1D)710)(\d{9})/g;
  while((match=ai710.exec(text))) add(match[1]);
  const aicAnywhere=/(?:^|\D)(0\d{8})(?=\D|$)/g;
  while((match=aicAnywhere.exec(text))) add(match[1]);
  if(/^\d{9}$/.test(text)) add(text);
  // Il vecchio bollino italiano usa CODE 32: il lettore può restituire
  // sia il testo leggibile A+8 cifre, sia i 6 caratteri in base 32.
  match=text.toUpperCase().match(/^A(\d{8})$/);
  if(match) add('0'+match[1]);
  const code32=text.toUpperCase().replace(/^A(?=[0-9BCDFGHJKLMNPQRSTUVWXYZ]{6}$)/,'');
  if(/^[0-9BCDFGHJKLMNPQRSTUVWXYZ]{6}$/.test(code32)){
    const alphabet='0123456789BCDFGHJKLMNPQRSTUVWXYZ';
    let number=0,valid=true;
    for(let i=0;i<code32.length;i++){
      const digit=alphabet.indexOf(code32.charAt(i));
      if(digit<0){valid=false;break;}
      number=number*32+digit;
    }
    if(valid) add(String(number).padStart(9,'0'));
  }

  let expiry='';
  match=text.match(/(?:\(17\)|(?:^|\x1D)17)(\d{6})/);
  if(match){
    const yy=+match[1].slice(0,2),mm=+match[1].slice(2,4),dd=+match[1].slice(4,6);
    if(mm>=1&&mm<=12&&dd>=0&&dd<=31) expiry='20'+String(yy).padStart(2,'0')+'-'+String(mm).padStart(2,'0')+'-'+String(dd||1).padStart(2,'0');
  }
  return {candidates:candidates,expiry:expiry};
}

function aifaBarcode_(raw) {
  const info=barcodeInfo_(raw);
  if(!String(raw||'').trim()) return {ok:false,error:'Codice mancante'};
  if(!info.candidates.length) return {ok:true,result:null,expiry:info.expiry,error:'AIC non presente nel codice letto'};
  const atcMap=atc2Map_();
  for(const aic of info.candidates){
    const content=aifaPayload_(aic);
    for(const item of content){
      const packages=item.confezioni||[];
      const pack=packages.find(function(p){return String(p.aic||'').replace(/\D/g,'')===aic;});
      if(!pack) continue;
      const med=item.medicinale||{},atc=String((item.codiceAtc||[])[0]||'').trim(),atc2=atc.slice(0,3);
      return {ok:true,result:{
        name:String(med.denominazioneMedicinale||'').trim(),
        aic:aic,atc:atc,atc2:atc2,atc2Name:atcMap[atc2]||atc2,
        active:(item.principiAttiviIt||[]).join(' + '),
        strength:String(item.descrizioneFormaDosaggio||''),
        packageName:String(pack.denominazioneConfezione||pack.descrizione||'')
      },expiry:info.expiry};
    }
  }
  return {ok:true,result:null,expiry:info.expiry,error:'Confezione non trovata nella banca dati AIFA'};
}

function atc2Map_(){
  const cache=CacheService.getScriptCache(),key='AIFA_ATC2_MAP_V1',cached=cache.get(key);
  if(cached) return JSON.parse(cached);
  const rows=fetchCsv_(AIFA_ATC_URL),head=rows[0]||[];
  const iCode=headerIndex_(head,['CODICE_ATC','ATC']);
  const iDesc=headerIndex_(head,['DESCRIZIONE','DESCRIZIONE_ATC']);
  if(iCode<0||iDesc<0) throw new Error('Anagrafica ATC non riconosciuta');
  const map={};
  for(let i=1;i<rows.length;i++){
    const code=String(rows[i][iCode]||'').trim();
    if(code.length===3) map[code]=String(rows[i][iDesc]||'').trim();
  }
  try{cache.put(key,JSON.stringify(map),21600)}catch(_){}
  return map;
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
