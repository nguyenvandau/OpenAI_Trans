# AI Cabin – OpenAI Realtime Translation MVP

MVP một phòng hội nghị: **dịch song song Anh ↔ Việt bằng `gpt-realtime-translate`**, tạo một luồng âm thanh trên server rồi phát PCM và phụ đề cho nhiều người nghe. Mặc định Anh → Việt; chọn Việt → Anh khi đổi ngôn ngữ diễn giả.

## Sơ đồ

Mixer AUX/REC OUT → USB Audio Interface → Laptop Operator → `gpt-realtime-translate` dịch trực tiếp từ âm thanh → trang nghe → hệ thống tai nghe cabin hoặc điện thoại người nghe.

`gpt-realtime-whisper` cung cấp phụ đề nguyên văn song song, không phải bước chờ trước khi dịch.

## Yêu cầu và cài đặt

- Node.js 20 trở lên.
- OpenAI API key có quyền dùng `gpt-realtime-translate` và `gpt-realtime-whisper` cho phụ đề nguyên văn.
- Laptop có Internet ổn định và USB audio interface nhận âm thanh trực tiếp từ mixer.
- Điện thoại kết nối được tới server qua LAN/Wi-Fi hoặc địa chỉ public.

```bash
cp .env.example .env
# Sửa OPENAI_API_KEY và PUBLIC_BASE_URL.
npm install
npm start
```

Trên Windows, dùng `Copy-Item .env.example .env`, sau đó `npm.cmd install` và `npm.cmd start`. Giữ `.env` đang dùng nếu đã có API key.

Mở trên laptop điều khiển: `http://localhost:3000/operator.html`. Người tham dự quét QR để vào `listen.html`.

## Cấu hình LAN

Ví dụ IP laptop là `192.168.1.50`:

```env
PUBLIC_BASE_URL=http://192.168.1.50:3000
```

Cho phép Windows Firewall TCP cổng 3000 trên mạng Private. Operator nên mở bằng `localhost` trên máy server; thu mic từ máy khác qua IP/tên miền cần HTTPS. Xem hướng dẫn triển khai trong [SERVER-SETUP.md](SERVER-SETUP.md).

## Dịch song song và cài đặt

Trang điều khiển có mục **Chiều dịch**: **Tiếng Anh → Tiếng Việt** (mặc định) hoặc **Tiếng Việt → Tiếng Anh**. Model tự nhận ngôn ngữ đầu vào nhưng cần một ngôn ngữ đầu ra cố định; ứng dụng không tự đổi sang ngôn ngữ còn lại. Đổi chiều bằng mục chọn khi diễn giả đổi ngôn ngữ. Có thể đổi trong cùng kết nối; nhãn trên trang nghe cập nhật khi OpenAI xác nhận cấu hình mới. Phụ đề và lịch sử trước đó được giữ lại.

Ứng dụng kết nối `/v1/realtime/translations?model=gpt-realtime-translate`. AudioContext resample mic về PCM16 mono 24 kHz; AudioWorklet thu các khung 200 ms, gồm cả khoảng lặng. Server giữ âm thanh trong lúc khởi tạo phiên rồi gửi liên tục, không chờ người nói ngừng, không đợi phụ đề hoàn chỉnh, không chia lượt bằng VAD và không dùng hàng đợi bản chữ để tạo bản dịch. Model quyết định lúc đã có đủ ngữ cảnh để phát cụm dịch; ứng dụng phát âm thanh nhận được ngay theo thứ tự. Độ trễ vẫn phụ thuộc model, tốc độ nói, độ dài bản dịch, mạng và bộ đệm phát âm thanh. Xem [hướng dẫn Realtime translation](https://developers.openai.com/api/docs/guides/realtime-translation).

Bản dịch đi trực tiếp từ âm thanh vào model chuyên dịch. Ứng dụng không tự thêm lời dẫn, tóm tắt, hoàn thành câu, suy diễn thuật ngữ hay ghép nội dung từ một model hội thoại. API này không hỗ trợ prompt tùy chỉnh, glossary, VAD hoặc chọn giọng; giao diện đã bỏ chọn giọng. Không thể cam kết model luôn đúng ngữ pháp hoặc không bao giờ thêm/bỏ từ. Kiểm tra nguyên văn, bản dịch và bản ghi thật trước hội nghị, đặc biệt với tên riêng, tên thuốc, số liệu, phủ định và câu chưa nói hết.

Phụ đề nguồn dùng `gpt-realtime-whisper` trong cùng phiên, chạy độc lập với dịch âm thanh. Phụ đề nguồn và bản dịch có thể về lệch thời điểm; chúng không phải các cặp câu đã được căn chỉnh. Web ghép nguyên trạng từng mảnh chữ, kể cả mảnh nằm giữa một từ; không chèn khoảng trắng hoặc bỏ mảnh chỉ vì trùng thời gian.

Khi bấm **Dừng**, ứng dụng ngừng thu mic, gửi phần âm thanh còn lại rồi chờ OpenAI hoàn tất phần dịch cuối. Trang nghe tiếp tục phát hết âm thanh đã nhận. Nút bắt đầu được mở lại sau khi hoàn tất đóng phiên; phiên mới xóa phụ đề trực tiếp và bộ đệm âm thanh cũ, còn lịch sử vẫn được giữ. Xem [cách đóng phiên để nhận hết phần dịch cuối](https://developers.openai.com/api/docs/guides/realtime-translation#close-a-websocket-session).

Trong `.env` có thể chỉnh lọc nhiễu:

```env
# Nguồn sạch lấy trực tiếp từ mixer:
OPENAI_NOISE_REDUCTION=none
# Micro gần người nói: near_field; micro thu cả phòng: far_field.
```

Khởi động lại server sau khi thay đổi `.env`. Cấu hình cũ `VAD_SILENCE_MS` không còn được sử dụng. API key chỉ được đọc trên server.

Chạy `npm test` để kiểm tra cấu hình, thu và truyền âm thanh liên tục, giữ các từ đầu/cuối, đổi ngôn ngữ, ghép phụ đề và xử lý lỗi bằng kết nối giả lập. Các kiểm thử này không đánh giá độ chính xác của AI. Kiểm tra thực tế cần API key có quyền truy cập model và bản ghi âm để đối chiếu.

## Phát bản dịch vào hệ thống tai nghe cabin

Nếu hội nghị đã có bộ phát và tai nghe cho đại biểu, máy tính phát âm thanh AI vào bộ phát cabin; đại biểu không cần mở web.

1. Cấp tín hiệu micro diễn giả sạch từ mixer vào audio interface. Giữ đường micro diễn giả riêng với đường phát bản dịch.
2. Mở `http://localhost:3000/operator.html`, chọn thiết bị thu, chiều dịch rồi bấm **Bắt đầu phiên dịch**.
3. Mở `http://localhost:3000/listen.html` trên cùng máy tính rồi bấm **Bắt đầu nghe**.
4. Chọn đúng thiết bị phát âm thanh trên máy tính. Nối Line Out của audio interface hoặc đầu ra máy tính vào Line In của bộ phát cabin bằng kết nối phù hợp.
5. Nghe thử bằng tai nghe đại biểu để kiểm tra âm lượng, tiếng rè và độ trễ của toàn bộ đường truyền. Giữ máy tính hoạt động trong phiên hội nghị.

Âm thanh AI cần đi vào đường phát tai nghe riêng để tránh thu ngược trở lại nguồn mic AI.

## Phụ đề trên TV hoặc máy chiếu

Trên trang nghe, bấm **Bắt đầu nghe** nếu cần phát âm thanh, rồi bấm **Full Screen**. Màn hình trình chiếu chỉ có phụ đề và nút **Quay lại**; âm thanh đang nghe tiếp tục phát. Dùng nút Quay lại hoặc phím Esc để về trang nghe.

Màn hình 16:9 hiển thị tiếng Việt bên trái dưới tiêu đề **BÁO CÁO VIÊN**, tiếng Anh bên phải dưới tiêu đề **SPEAKER**. Mỗi bên hiện 5 dòng gần nhất, tự cuộn khi có chữ mới. Dịch âm thanh diễn ra song song với nhận dạng phụ đề, vẫn có độ trễ xử lý. Khi đổi chiều, phụ đề đã nhận được giữ trong cột ngôn ngữ của đoạn đó.

Nút **Xem lại toàn bộ** mở lời thoại song ngữ nhận được từ khi mở trang. Lịch sử không bị cắt khi phụ đề cuộn đi và giữ nội dung các phiên trước. Dùng **Tải lời thoại (.txt)** trước khi tải lại hoặc đóng trang; lịch sử nằm trong bộ nhớ trang nghe, không lưu trên server.

## Triển khai cho nhiều người nghe

MVP phát PCM16 mono 24 kHz, khoảng 384 kbps âm thanh thuần cho mỗi người nghe, chưa kể WebSocket overhead. Bản dịch được tạo một lần rồi chia sẻ tới tất cả người nghe.

Cho hội nghị 100–500 người, có thể giữ phiên dịch trên server và thay tầng phát PCM bằng Opus 24–48 kbps qua WebRTC SFU. Cần thử tải với số thiết bị gần thực tế, giám sát độ trễ và có đường Internet/worker dự phòng. Xem [PRODUCTION_ARCHITECTURE.md](PRODUCTION_ARCHITECTURE.md).

Tài liệu OpenAI: [Realtime translation](https://developers.openai.com/api/docs/guides/realtime-translation), [Translation client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events), [Translation server events](https://developers.openai.com/api/reference/resources/realtime/translation-server-events).
