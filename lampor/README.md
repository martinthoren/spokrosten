# Koppla in lamporna

Spökrösten styr Tuya/Smart Life-lampor (t.ex. Cleverio från Kjell) via en liten proxy:

```
Spökrösten (mobilen) → proxy (Cloudflare Worker, håller nycklarna) → Tuyas moln → lamporna
```

Det tar ungefär 20–30 minuter första gången. Allt är gratis.

## 1. Lamporna i Smart Life

1. Skruva i lamporna och installera appen **Smart Life** (inte Tuya Smart, inte Cleverios/Kjells egen).
2. Skapa konto och lägg till båda lamporna. Använd **2,4 GHz-wifi**. Har routern samma namn för 2,4 och 5 GHz och parkopplingen strular, slå av 5 GHz tillfälligt.
3. Döp dem till något begripligt, t.ex. *Hallen* och *Fönstret*. Namnen syns i Spökrösten.
4. Kolla att du kan byta färg i appen.

## 2. Tuya-utvecklarkonto

Menyernas namn ändras ibland, men stegen är ungefär:

1. Gå till <https://platform.tuya.com> och skapa ett konto.
2. **Cloud → Development → Create Cloud Project**
   - Development Method: **Smart Home**
   - Data Center: **Central Europe Data Center** (det som svenska Smart Life-konton hamnar i)
   - Godkänn de API-tjänster som föreslås (bl.a. **IoT Core** och **Authorization Token Management**).
3. Under projektets **Overview**: kopiera **Access ID/Client ID** och **Access Secret**.
4. Fliken **Devices → Link App Account → Add App Account**. En QR-kod visas.
   I Smart Life: **Jag/Me → skanna-ikonen uppe till höger** och skanna koden. Välj automatiskt länkläge.
5. Lamporna dyker nu upp under **Devices**. Kopiera båda **Device ID**.

> IoT Core är en gratis provperiod som måste **förlängas** då och då (knapp i Tuya-konsolen under *Cloud → Cloud Services*). Slutar lamporna svara efter några månader är det oftast därför.

Hamnade lamporna inte i listan? Då ligger Smart Life-kontot i ett annat datacenter. Skapa projektet igen med *Western Europe* och ändra `TUYA_BASE` nedan.

## 3. Proxyn på Cloudflare

1. Skapa ett gratis konto på <https://dash.cloudflare.com>.
2. **Workers & Pages → Create → Create Worker**. Döp den till `spokrosten-lampor` och tryck **Deploy**.
3. **Edit code**: radera allt, klistra in hela [`worker.js`](worker.js) och tryck **Deploy**.
4. **Settings → Variables and Secrets → Add**:

   | Namn | Typ | Värde |
   |---|---|---|
   | `TUYA_CLIENT_ID` | Text | Access ID från steg 2 |
   | `TUYA_SECRET` | **Secret** | Access Secret från steg 2 |
   | `TUYA_BASE` | Text | `https://openapi.tuyaeu.com` (Central Europe) eller `https://openapi-weaz.tuyaeu.com` (Western Europe) |
   | `DEVICE_IDS` | Text | båda Device ID, kommaseparerade: `abc123,def456` |
   | `APP_TOKEN` | **Secret** | en lång slumpsträng som du hittar på själv (minst 20 tecken) |

5. Kopiera workerns adress, t.ex. `https://spokrosten-lampor.dittnamn.workers.dev`.

## 4. I Spökrösten

1. Öppna <https://martinthoren.github.io/spokrosten/> och scrolla till **Ljus → Koppla in lamporna**.
2. Klistra in workerns adress och `APP_TOKEN`, tryck **Spara och testa**.
3. Det ska stå *Inkopplat: Hallen, Fönstret*. Testa knapparna.

Uppgifterna sparas bara i den webbläsaren. Byter du telefon gör du steg 4 igen.

## Felsökning

| Meddelande | Orsak |
|---|---|
| *Fel nyckel* | `APP_TOKEN` i Spökrösten och i Cloudflare stämmer inte. |
| *Proxyn saknar inställningar: …* | En variabel i steg 3.4 saknas. Tryck **Deploy** igen efter att du lagt till variabler. |
| *Tuya 1004 / sign invalid* | Fel `TUYA_SECRET` eller `TUYA_CLIENT_ID`. |
| *Tuya 1106 / permission deny* | Smart Life-kontot är inte länkat (steg 2.4), eller fel datacenter. |
| *Tuya 28841…* eller liknande om tjänst | IoT Core-provperioden har gått ut och behöver förlängas. |
| Färger fungerar men Flimmer/Puls ger bara fast färg | Lampan saknar `scene_data_v2`. Hör av dig, det går att lösa på annat sätt. |
