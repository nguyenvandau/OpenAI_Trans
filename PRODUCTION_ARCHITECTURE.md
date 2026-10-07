# Kien truc production 100–500 nguoi

## Luong chinh

1. Mixer tao mot AUX bus sach chi chua micro san khau.
2. USB audio interface vao may Ingest/Operator.
3. Ingest Worker chuyen audio thanh PCM16 24 kHz va gui lien tuc qua WebSocket toi `/v1/realtime?model=gpt-realtime-2`.
4. VAD tach luot noi; `gpt-4o-transcribe` nhan dang Anh/Viet. Server xep hang doi ban chu dung thu tu, gui tung ban chu cho `gpt-realtime-2` dich sang ngon ngu con lai. OpenAI tra ve PCM + transcript deltas cho tung luot.
5. Media Gateway encode audio sang Opus 24–48 kbps.
6. WebRTC SFU phat 1 track `en-vi-translation` toi tat ca listener.
7. Caption service phat target/source transcript qua data channel hoac WebSocket.
8. Trang listener: nut Play, volume, phu de phien dich Anh/Viet, nguyen van, connection health.

## Tai sao khong cho 500 dien thoai goi OpenAI truc tiep

- Se tao rat nhieu translation sessions khong can thiet.
- Tang chi phi va rate-limit.
- Kho dong bo caption/audio.
- Kho quan ly ket noi va bao mat.

## Du phong

- Worker A active, Worker B standby.
- Internet 1: wired/fiber; Internet 2: 5G/khac nha mang.
- UPS cho mixer, switch, AP, laptop/server.
- Nut fallback: tat translated audio va hien phu de/cho phep nghe original.
- Ghi log latency, reconnect, OpenAI errors; khong bat buoc luu transcript neu khong can.

## Mang Wi-Fi

- AP co wired backhaul; uu tien 5 GHz/6 GHz.
- Tach SSID/event VLAN neu co the.
- Kiem thu dong thoi voi so may gan thuc te, khong chi speed-test 1 may.
- Neu fan-out raw PCM: bang thong rat cao. Production nen dung Opus/WebRTC.

## Danh gia y khoa truoc launch

Tao golden set 50–100 cau gom:
- ten thuoc va hoat chat;
- viet tat: DAS28, ACR20/50/70, EULAR, DMARD, bDMARD, tsDMARD, JAK;
- ten benh: rheumatoid arthritis, axial spondyloarthritis, psoriatic arthritis;
- so lieu, %, HR/RR/OR, CI, p-value;
- ten tac gia/nghien cuu;
- accent Anh-Anh, Anh-My, Singapore/An Do neu co.

Cham 3 muc: dung y nghia, dung thuat ngu, do tre. Khong chi nghe 1–2 cau demo.
