# AI Cabin – OpenAI Realtime Translation MVP

MVP mot phong hoi nghi: **English -> Vietnamese**, dich 1 lan tren server va phat audio PCM + phu de den nhieu dien thoai qua WebSocket.

## So do

Mixer AUX/REC OUT -> USB Audio Interface -> Laptop Operator -> Node server -> OpenAI `gpt-realtime-translate` -> Node fan-out -> dien thoai nguoi nghe

## Yeu cau

- Node.js 20+ (khuyen nghi ban LTS moi).
- OpenAI API key co quyen dung `gpt-realtime-translate`.
- Laptop co Internet on dinh.
- USB audio interface lay audio truc tiep tu mixer.
- Cac dien thoai ket noi cung LAN/Wi-Fi voi server (MVP) hoac server co dia chi public.

## Cai dat

```bash
cp .env.example .env
# sua OPENAI_API_KEY va PUBLIC_BASE_URL
npm install
npm start
```

Mo tren laptop dieu khien: `http://localhost:3000/operator.html`.
Nguoi tham du quet QR de vao `listen.html`.

## Cau hinh LAN

Vi du IP laptop la `192.168.1.50`:

```env
PUBLIC_BASE_URL=http://192.168.1.50:3000
```

Cho phep Windows Firewall TCP port 3000 tren mang Private. Operator nen mo bang `localhost` de trinh duyet cho phep truy cap audio input.

## Luu y quan trong

1. MVP nay fan-out **PCM16 24 kHz mono**. Chat luong/latency tot nhung ton bang thong: xap xi 384 kbps audio thuan moi listener, chua ke WebSocket overhead. Phu hop pilot va LAN nho-vua.
2. Cho 100–500 nguoi that, nen thay lop fan-out PCM bang **Opus + WebRTC SFU** (LiveKit/mediasoup/Janus hoac tuong duong). Translation van chi can 1 OpenAI session cho moi ngon ngu dich.
3. `gpt-realtime-translate` hien khong ho tro glossary/custom prompt/pronunciation guide. Hoi nghi y khoa can test truoc ten thuoc, viet tat, ten tac gia, so lieu.
4. Ban production nen co 2 duong Internet, 2 laptop/worker, UPS va phuong an fallback nghe tieng goc.
5. Khong bao gio dua OPENAI_API_KEY vao JavaScript cua trang nguoi tham du.

## Nang cap production de xuat

- Ingest worker A/B song song (mot active, mot standby).
- OpenAI WebSocket translation session server-side.
- Encoder Opus 24–48 kbps.
- WebRTC SFU fan-out mot translated audio track toi 100–500 clients.
- Data channel/WebSocket cho captions.
- Health checks, auto reconnect, monitoring first-audio latency va dropped frames.
- Admin dashboard: Start/Stop, audio level, OpenAI status, so listener, latency, transcript.

## Q&A Viet -> Anh

Tao them mot worker/session thu hai voi `TARGET_LANGUAGE=en` va route microphone cua nguoi hoi vao stream do. Khong tron hai chieu vao cung mot stream.
