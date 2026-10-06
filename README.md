# Barcelona toplu taşıma

Kişisel harita. Birkaç kişi, reklam yok, hesap yok, veritabanı yok. Statik sayfa Cloudflare Pages üzerinde durur. Canlı veri tek bir Worker'dan geçer. Ücretli servis kullanılmaz.

Harita Barcelona merkezinde açılır (`[2.17, 41.39]`, zoom 12). Hat şekilleri ve duraklar derleme sırasında GTFS'ten üretilir; sayfa her açılışta zip indirmez.

## Ne gerçek, ne tahmini

| Katman | Konum | Etiket |
| --- | --- | --- |
| FGC (L6, L7, L8, L12 ve banliyö) | GTFS-RT araç GPS'i | canlı |
| TRAM (T1–T6) | GTFS-RT araç GPS'i, anahtar varsa | canlı |
| TMB otobüs | iBus varış süresi, GTFS şekli üzerinde aralık hesabı | tahmini |
| TMB metro (L1–L5, L9, L10, L11) ve füniküler | Yalnızca hat ve istasyon | canlı nokta yok |

Tahmini nokta GPS değildir. Varış süresi şeklin üzerine sığmıyorsa nokta konmaz. Metro için halka açık araç GPS'i olmadığı için tren noktası üretilmez.

TRAM anahtarı yoksa katman kapalı kalır ve panelde "TRAM anahtarı yok" yazar. Worker ayakta değilse bu yazılmaz; üstte "Canlı katman kapalı" kalır. Daha önce veri geldiyse noktalar durur ve "Veri eski" görünür.

AMB otobüsleri bu sürümde yok. Kaynakları GTFS-RT Trip Updates; araç koordinatı taşımıyor. Haritaya nokta olarak çizilmez.

Varsayılan açık hatlar L1–L5 (yalnızca çizgi) ve FGC L6. Otobüs ve TRAM kapalı başlar, ilk istek şişmesin diye. Seçim tarayıcıda `bcn-lines-v1` anahtarıyla saklanır.

## Anahtarlar

Anahtarlar yalnızca Worker ortamında durur. `public/` altına, `config.js` içine veya frontend paketine yazma. Repoya koyma. `.env.example` boştur. `.dev.vars` ve `.env` git'e girmez.

### TMB

1. [developer.tmb.cat](https://developer.tmb.cat/) üzerinden bir uygulama aç.
2. `app_id` ve `app_key` al.
3. Worker değişkenleri: `TMB_APP_ID`, `TMB_APP_KEY`.

Bunlar olmadan otobüs noktası gelmez. Hat çizgileri yine görünür. Anahtar yokken sahte konum üretilmez.

### TRAM

1. [opendata.tram.cat](https://opendata.tram.cat/) kaydı OAuth istemcisi verir.
2. `TRAM_CLIENT_ID` istemci kimliği, `TRAM_API_KEY` istemci sırrıdır.
3. Tek değişken kullanmak istersen `TRAM_API_KEY` değerini `client_id:client_secret` biçiminde yaz. Bu durumda `TRAM_CLIENT_ID` boş kalabilir.

Anahtar yoksa TRAM araçları istenmez.

## Cloudflare

Worker ve Pages ayrı yayınlanır. Ücretsiz planda ikisi de yeter.

```bash
npx wrangler@4 secret put TMB_APP_ID
npx wrangler@4 secret put TMB_APP_KEY
npx wrangler@4 secret put TRAM_CLIENT_ID
npx wrangler@4 secret put TRAM_API_KEY

npx wrangler@4 deploy
npx wrangler@4 pages deploy public --project-name bcn-transit
```

Aynı isimler Workers → Settings → Variables ekranından da yazılır. Değişkenleri `wrangler.toml` içine koyma.

Sayfa ile Worker farklı kökteyse `public/config.js` içindeki `apiBase` Worker adresidir. Bu bir sır değildir:

```js
window.BCN_CONFIG = {
  apiBase: "https://bcn-transit.<hesap>.workers.dev",
};
```

Boş bırakılırsa sayfa aynı kökte `/api/vehicles` çağırır. İki tarafı tek alan adında birleştirirsen `apiBase` boş kalabilir. Worker `Access-Control-Allow-Origin: *` döner; kişisel kullanımda `pages.dev` adresi `workers.dev` adresini çağırabilir.

## Yerel

Node 20 veya üzeri.

Worker olmadan hat ve duraklar:

```bash
npm run build
npm run dev:web
```

[http://127.0.0.1:8788](http://127.0.0.1:8788) açılır. `/api` yoksa canlı katman sessizce kapanır. Harita, hatlar ve duraklar durur.

Worker ile:

```bash
cp .env.example .dev.vars
# .dev.vars içine anahtarları yaz
npm run dev:worker
```

İkinci uçbirimde `npm run dev:web`. Tarayıcı:

[http://127.0.0.1:8788/?api=http://127.0.0.1:8787](http://127.0.0.1:8788/?api=http://127.0.0.1:8787)

`?api=` yalnızca `http` ve `https` kabul eder. Anahtar taşımaz.

## GTFS yenileme

`npm run build` şunları yazar:

- `public/data/` — haritadaki hatlar, duraklar, katalog
- `worker/data/` — otobüs tahmin indeksi ve FGC/TRAM sefer eşlemesi

TMB anahtarı derleme ortamında varsa resmi GTFS alınır (`https://api.tmb.cat/v1/static/datasets/gtfs.zip`). Yoksa geometri Mobility Database üzerindeki TMB kopyasından gelir. Şu anki kopyanın hizmet aralığı 2026-04-10 — 2026-12-05. Aralık dolunca:

```bash
npm run build -- --refresh
npx wrangler@4 deploy
npx wrangler@4 pages deploy public --project-name bcn-transit
```

Otobüs indeksi Worker paketinin içindedir. Yalnızca sayfayı yeniden yayınlamak tahmin geometrisini güncellemez. İkisini birden yayınla.

FGC statik GTFS: `https://www.fgc.cat/google/google_transit.zip`. Canlı konum: OpenDataSoft vehicle-positions kaydı. TRAM statik GTFS: `TBX.zip` ve `TBS.zip`.

## İstekler

Tarayıcı 28 saniyede bir, yalnız açık ve ekranda görünen hatlar için sorar. En fazla 40 hat. Metro hattı isteğe girmez. Sekme gizlenince istek durur. Harita kayınca yeniden sorgu yaklaşık 400 ms bekler.

Worker yanıtı 25 saniye bellekte tutar. TMB için tüm duraklar dolaşılmaz: her hatta birkaç örnek durak seçilir, harita kutusuna yaklaşık 0,03° pay eklenir, iBus çağrı tavanı 18'dir. Tavan aşılırsa yanıtta `partial: true` olur ve arayüz "Bazı duraklar atlandı" der.

Yanıt gövdesi: `{ id, operator, line, lat, lon, bearing, destination, updated, source }` ve `source` ya `gps` ya `estimated`.

## Veri şartları

Bu bir hukuk görüşü değil. Yayına almadan önce kendi kullanımının şartlara uyduğunu kontrol et.

- TMB geliştirici şartları: [developer.tmb.cat](https://developer.tmb.cat/)
- FGC açık veri: [fgc.cat](https://www.fgc.cat/) ve [fgc.opendatasoft.com](https://fgc.opendatasoft.com/explore/dataset/vehicle-positions-gtfs_realtime/)
- TRAM açık veri: [opendata.tram.cat](https://opendata.tram.cat/)
- Altlık CARTO Dark Matter ve OpenStreetMap katkılarıdır. Haritadaki atıf satırı durur.

## Komutlar

```bash
npm run build
npm test
npm run dev:web
npm run dev:worker
npx wrangler@4 deploy
npx wrangler@4 pages deploy public --project-name bcn-transit
```
