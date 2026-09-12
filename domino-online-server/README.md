# Domino World — Online Sunucu

Bu klasör, Domino World'ün online (arkadaşla oda kodu + rastgele eşleştirme)
modunu çalıştıran sunucuyu içerir. Node.js + Socket.io kullanır, veritabanı
gerektirmez (oda bilgileri sunucunun hafızasında tutulur).

## Bilgisayarında test etmek (Node.js kurulduktan sonra)

1. Bu klasörü aç (terminal/cmd ile içine gir)
2. Şunu çalıştır: `npm install`
3. Sonra: `npm start`
4. "Domino World server listening on port 3000" yazısını görürsen çalışıyor demektir
5. Tarayıcıdan `http://localhost:3000/health` adresine gidip `{"ok":true,...}` görürsen doğrulanmış olur

## Render.com'a ücretsiz yükleme (canlıya alma)

1. [render.com](https://render.com) adresinde ücretsiz hesap aç (GitHub hesabınla giriş yapabilirsin)
2. Bu `server` klasörünü bir GitHub reposuna yükle (Android Studio kurulumundan sonra
   Claude Code ile bunu da senin için yapabiliriz, istersen)
3. Render panelinde "New +" → "Web Service" seç, GitHub reponu bağla
4. Ayarlar:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Yayınla (Deploy) — birkaç dakika sürer
6. Render sana `https://senin-servisin.onrender.com` gibi bir adres verecek — bu, oyunun
   online moda bağlanacağı adres olacak

Not: Render'ın ücretsiz katmanı, uzun süre kullanılmayınca sunucuyu uyutur; ilk
bağlantıda birkaç saniye "uyanma" gecikmesi olabilir. Bu normal, dert değil.

## Sunucu ne yapıyor?

- Oda kodu ile arkadaşla oynama (`create_room` / `join_room`)
- Rastgele oyuncu eşleştirme kuyruğu (`join_matchmaking`)
- Taş dağıtma, hamle doğrulama, puanlama — hepsi sunucuda (hile yapılamasın diye
  hiçbir oyuncu rakibinin elini görmez)
- Boş kalan koltukları bot ile doldurma seçeneği (`start_with_bots`)

Oyun dosyasına (`domino_demo.html`) bu sunucuya bağlanacak "Online Oyna" ekranını
bir sonraki adımda ekleyeceğiz.
