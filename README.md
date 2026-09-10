# Armadietto Medicinali v5.0.3

File pronti per il repository GitHub Pages `armadietto`.

## File GitHub
- `index.html`
- `manifest.json`
- `sw.js`

## Backend Google Apps Script
Il file `Code.gs` va in un progetto Google Apps Script distribuito come Web App.

1. Aprire Google Apps Script.
2. Sostituire `Code.gs` con il file fornito.
3. Impostazioni progetto → Proprietà script → aggiungere:
   `ARMADIETTO_PIN` = un PIN scelto.
4. Distribuisci → Nuova distribuzione → App web.
   - Esegui come: te
   - Accesso: chiunque
5. Copiare l'URL che termina con `/exec`.
6. Nell'app: Impostazioni → AIFA → incollare l'URL.
7. In Backup e sincronizzazione inserire lo stesso PIN.

La ricerca dei farmaci umani usa l'anagrafica AIFA e mostra il livello ATC 2.
