# AI Cabin – OpenAI Realtime Translation MVP

MVP một phòng hội nghị: **tự động hoặc chọn chiều Anh ↔ Việt**, dịch một lần trên server và phát âm thanh PCM + phụ đề đến nhiều điện thoại qua WebSocket. Mặc định mỗi lượt nói được nhận diện độc lập: tiếng Anh dịch sang tiếng Việt, tiếng Việt dịch sang tiếng Anh.

## So do

Mixer AUX/REC OUT -> USB Audio Interface -> Laptop Operator -> nhận dạng tiếng nói `gpt-4o-transcribe` -> phiên dịch và phát giọng nói `gpt-realtime-2` -> trang nghe -> bộ phát tai nghe cabin hoặc điện thoại người nghe

## Yeu cau

- Node.js 20+ (khuyen nghi ban LTS moi).
- OpenAI API key có quyền dùng `gpt-realtime-2` và `gpt-4o-transcribe` (phụ đề nguyên văn).
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
2. Cho 100–500 nguoi that, nen thay lop fan-out PCM bang **Opus + WebRTC SFU** (LiveKit/mediasoup/Janus hoac tuong duong). Bản dịch tự động được tạo một lần rồi chia sẻ cho các listener.
3. Chế độ tự động dùng Realtime thông thường, với chỉ dẫn phiên dịch trong `realtime-interpreter.mjs`. Cần kiểm tra tên thuốc, viết tắt, tên tác giả và số liệu bằng người nghe song ngữ trước hội nghị.
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

## Chế độ phiên dịch và cài đặt

Trang điều khiển có hai lựa chọn:

- **Automatic Recognition and Switch**: tự nhận diện Anh/Việt và dịch sang ngôn ngữ còn lại theo từng lượt nói. Với câu tiếng Việt xen tên thuốc/thuật ngữ tiếng Anh, model được hướng dẫn giữ chiều Việt → Anh.
- **Manual Translater Switch**: hiện lựa chọn **Tiếng Anh → Tiếng Việt** hoặc **Tiếng Việt → Tiếng Anh**. Bản dịch được hướng dẫn luôn dùng ngôn ngữ đầu ra đã chọn.

Có thể đổi chế độ hoặc chiều dịch ngay khi đang chạy. Thay đổi áp dụng từ lượt nói mới, không khởi động lại kết nối và không xóa phụ đề/lịch sử. Server ghi nhận lựa chọn khi bắt đầu từng lượt nói; các lượt đang nói, đang dịch hoặc đang chờ vẫn giữ chiều dịch đó. Trang Listen cập nhật nhãn chế độ hiện tại, còn phụ đề của mỗi lượt giữ ngôn ngữ của chính lượt đó.

API dịch chuyên dụng `gpt-realtime-translate` dùng ngôn ngữ đầu ra được cấu hình trước. Cả hai chế độ của dự án dùng `/v1/realtime?model=gpt-realtime-2`, gửi chỉ dẫn phiên dịch riêng theo từng lượt và phát bản dịch sau khoảng ngắt câu. Chỉ dẫn mỗi response được cấu hình theo [Realtime client events của OpenAI](https://developers.openai.com/api/reference/resources/realtime/client-events). Mặc định khoảng lặng là 650 ms, ngưỡng VAD 0.5, phần đệm trước lời nói 300 ms, giọng Marin và reasoning low.

Server chờ bản nhận dạng tiếng nói của từng lượt và dùng bản chữ đó làm nguồn cho bước dịch. Cách này cho phép đối chiếu nguyên văn và giảm việc model nghe nhầm tên bệnh khi dịch trực tiếp từ âm thanh tiếng Việt; vẫn cần kiểm tra độ chính xác của bản nhận dạng. Chờ nhận dạng trước khi dịch sẽ tăng độ trễ.

Server xếp các lượt nói vào hàng đợi và tạo bản dịch lần lượt, giữ đúng thứ tự ngay cả khi kết quả nhận dạng về khác thứ tự. Lượt nói mới không hủy bản dịch đang tạo. Nếu một lượt không nhận dạng được, web báo cần nhắc lại và tiếp tục các lượt sau. Trang nghe xếp các đoạn PCM đúng thứ tự; nếu người nói liên tục nhanh hơn bản dịch, độ trễ có thể tăng. Nên ngắt nhẹ giữa các câu và tránh hai người nói chồng lên nhau.

Trong `.env` có thể chỉnh:

```env
# Nguồn sạch lấy trực tiếp từ mixer:
OPENAI_NOISE_REDUCTION=none
# Micro gần người nói: near_field; micro thu cả phòng: far_field.
VAD_SILENCE_MS=650
```

`VAD_SILENCE_MS` nhận giá trị từ 200 đến 2000 ms. Giảm thời gian để phản hồi sớm hơn; tăng nếu hệ thống cắt câu khi diễn giả chỉ ngừng nhẹ. Khởi động lại server sau khi thay đổi `.env`.

Không cần chỉnh Custom Instructions của ChatGPT hoặc lưu prompt ở Playground. Web gửi cấu hình từ code, không tham chiếu prompt Playground. Chỉ dẫn phiên dịch và ngữ cảnh thuật ngữ y khoa nằm trong `realtime-interpreter.mjs`; sửa tại đây nếu cần bổ sung thuật ngữ đã kiểm chứng của hội nghị. API key chỉ được đọc trên server.

Nếu chưa có API key thật, giao diện vẫn chạy nhưng không thể kiểm chứng nhận diện ngôn ngữ, chất lượng bản dịch và độ trễ thực tế. Các kiểm thử tự động chỉ kiểm tra cấu hình, hàng đợi, luồng dữ liệu và xử lý lỗi bằng kết nối giả lập.

## Phát bản dịch vào hệ thống tai nghe cabin

Nếu hội nghị đã có bộ phát và tai nghe cho đại biểu, chỉ cần máy tính phát âm thanh AI vào bộ phát cabin; không cần từng đại biểu mở web.

1. Kỹ thuật âm thanh cấp tín hiệu micro diễn giả sạch từ mixer vào audio interface. Giữ đường micro diễn giả riêng với đường phát bản dịch.
2. Mở `http://localhost:3000/operator.html`, chọn thiết bị thu rồi bấm **Bắt đầu phiên dịch**.
3. Mở `http://localhost:3000/listen.html` trên cùng máy tính rồi bấm **Bắt đầu nghe**.
4. Chọn đúng thiết bị phát âm thanh trên máy tính. Nối Line Out của audio interface (hoặc đầu ra âm thanh máy tính) vào Line In của bộ phát cabin bằng kết nối phù hợp với thiết bị.
5. Nghe thử bằng một tai nghe đại biểu để kiểm tra âm lượng, tiếng rè và độ trễ của toàn bộ đường truyền. Giữ máy tính hoạt động, tắt chế độ ngủ trong phiên hội nghị.

Âm thanh AI cần đi vào đường phát tai nghe riêng để tránh được thu ngược trở lại nguồn micro AI. Với cách này web chỉ phát tới một máy tính; kiểm thử chính là độ chính xác, độ trễ, kết nối Internet và hệ thống cabin.

## Phụ đề trên TV hoặc máy chiếu

Trên trang nghe, bấm **Bắt đầu nghe** nếu cần phát âm thanh, rồi bấm **Full Screen** cạnh đó. Màn hình trình chiếu chỉ có phụ đề và nút **Quay lại**; âm thanh đang nghe tiếp tục phát. Có thể dùng nút Quay lại hoặc phím Esc để về cửa sổ nghe.

Màn hình 16:9 hiển thị tiếng Việt bên trái dưới tiêu đề **BÁO CÁO VIÊN**, tiếng Anh bên phải dưới tiêu đề **SPEAKER**. Mỗi bên hiện 5 dòng gần nhất, tự cuộn khi có chữ mới. Nguyên văn cập nhật theo các đoạn nhận dạng; bản dịch cập nhật theo các đoạn chữ AI tạo ra. Việc dịch vẫn chờ nhận dạng lượt nói và có độ trễ xử lý. Hai cột giữ đúng ngôn ngữ khi đổi chiều dịch.

Ngoài chế độ Full Screen, nút **Xem lại toàn bộ** mở lời thoại song ngữ nhận được từ khi mở trang. Lịch sử không bị cắt khi phụ đề cuộn đi, và vẫn giữ các lượt trước khi ban tổ chức dừng/bắt đầu phiên mới. Dùng **Tải lời thoại (.txt)** để lưu trước khi tải lại hoặc đóng trang; lịch sử hiện được giữ trong bộ nhớ của trang nghe, không lưu trên server.

Tài liệu OpenAI chính thức: [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations), [Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events), [Realtime translation](https://developers.openai.com/api/docs/guides/realtime-translation).
