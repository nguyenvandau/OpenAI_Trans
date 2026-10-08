# Chạy AI Cabin trên server

Gói ZIP gồm ứng dụng, logo, toàn bộ thư viện chạy và bốn file thuật ngữ hội nghị. Server cần có **Node.js 20 trở lên**. Không cần chạy `npm install` khi đã giải nén đầy đủ gói.

## 1. Giải nén và cấu hình

Giải nén ZIP, mở thư mục **AI-Cabin**. Chép file **`.env` đang dùng trên máy hiện tại** vào thư mục này, cạnh `server.mjs`. ZIP không chứa API key thật.

Sửa `PUBLIC_BASE_URL` thành địa chỉ mới của server để QR mở đúng trang nghe. Chọn một trong hai dạng:

```env
# Server trong mạng nội bộ; thay IP bằng IP thật của server:
PUBLIC_BASE_URL=http://192.168.1.50:3000
```

```env
# Server có tên miền và HTTPS:
PUBLIC_BASE_URL=https://dich.example.com
```

Giữ `OPENAI_API_KEY` thật trong `.env` và `PORT=3000`, hoặc đổi PORT nếu server đã dùng cổng đó. Có thể cấu hình bằng biến môi trường thay cho `.env`. Khi chưa có khóa, file chạy tạo `.env` mẫu và thông báo cách điền; không ghi đè `.env` đã có.

Để dùng từ khóa cho phụ đề nguồn, cấu hình mặc định là:

```env
OPENAI_SOURCE_TRANSCRIPTION=gpt-live-transcribe
OPENAI_NOISE_REDUCTION=auto
```

API key cần có quyền dùng `gpt-realtime-translate` và `gpt-live-transcribe`. Nếu project chưa dùng được Live Transcribe, chọn `OPENAI_SOURCE_TRANSCRIPTION=gpt-realtime-whisper`; lựa chọn này không dùng từ khóa chuyên ngành. Khởi động lại server sau khi đổi cấu hình.

Giữ đủ các file sau cạnh `server.mjs`, với đúng tên:

- `gpt-live-transcribe_EN_session.json`: 166 từ khóa tiếng Anh cho chiều Anh → Việt.
- `gpt-live-transcribe_VI_session.json`: 133 từ khóa cho chiều Việt → Anh, gợi ý nguồn `vi` và `en`.
- `IFR2026_glossary_EN-VI.csv`: 475 mục Anh–Việt để đối chiếu.
- `IFR2026_Thuat_ngu_Anh-Viet.xlsx`: bản tra cứu thuật ngữ, diễn giả và đơn vị.

Hai JSON dùng `delay: "medium"` cho phụ đề nguồn; không đặt độ trễ cho âm thanh dịch. Ứng dụng giữ nguyên file gốc, dùng các từ khóa nhưng thay phần mô tả chủ đề/tên/địa điểm trong prompt khi gửi API bằng yêu cầu chép nguyên văn lời nghe được, không đoán hoặc hoàn thành nội dung chưa nói. Yêu cầu này chỉ áp dụng cho phụ đề nguồn. CSV và XLSX không được dùng để tự tìm/thay từ trên phụ đề. Bộ thuật ngữ không được nạp vào `gpt-realtime-translate` vì model hiện không hỗ trợ prompt/glossary tùy chỉnh. Xem [cấu hình Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) và [giới hạn thuật ngữ của Realtime Translation](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide#test-terminology-and-names-directly).

## 2. Chạy ứng dụng

**Windows:** bấm đúp **`start-server.cmd`**. Giữ cửa sổ đang chạy mở; nhấn Ctrl+C để dừng.

**Linux/macOS:** mở Terminal trong thư mục AI-Cabin và chạy:

```sh
sh start-server.sh
```

Hoặc trên cả hai hệ điều hành, mở Terminal trong thư mục AI-Cabin:

```sh
npm start
```

Mở trên chính máy server:

- Điều khiển: `http://localhost:3000/operator.html`
- Nghe và trình chiếu: `http://localhost:3000/listen.html`

Trên máy khác, dùng IP hoặc tên miền của server. Với kết nối trực tiếp trong LAN, cho phép TCP cổng 3000 trên firewall của server. Server phải truy cập được Internet để gọi OpenAI.

## 3. Dùng tên miền cho hội nghị

Nếu điều khiển bằng máy tính khác qua IP/tên miền, trang thu microphone cần **HTTPS**; xem [điều kiện getUserMedia của MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia). `http://localhost` trên chính máy server vẫn dùng được. Cấu hình proxy HTTPS chuyển tiếp đến `http://127.0.0.1:3000` và hỗ trợ WebSocket cho `/ws/source` và `/ws/listen`.

Gói có mẫu `deploy/nginx.conf.example` theo [hướng dẫn WebSocket của Nginx](https://nginx.org/en/docs/http/websocket.html) để ghép vào cấu hình Nginx đã có HTTPS. Thay tên miền và đường dẫn chứng chỉ bằng cấu hình thật của server; mẫu không tự cấp chứng chỉ. Nếu server dùng IIS hoặc một reverse proxy khác, cấu hình cùng địa chỉ upstream và cho phép WebSocket.

Muốn chạy liên tục sau khi đóng Terminal hoặc khi server khởi động lại, đưa `node server.mjs` vào trình quản lý dịch vụ của server, đặt thư mục làm việc là AI-Cabin và nạp `.env` của ứng dụng. File chạy đi kèm là chế độ chạy trực tiếp trong Terminal.

## 4. Kiểm tra trước khi dùng

Mở trang điều khiển, chọn thiết bị thu từ mixer và chiều Anh → Việt hoặc Việt → Anh rồi bắt đầu phiên dịch. Ứng dụng giữ ngôn ngữ đầu ra đã chọn, không tự đổi chiều khi người nói đổi ngôn ngữ. Mở trang Listen, bấm Bắt đầu nghe, kiểm tra cả âm thanh và phụ đề. Âm thanh dịch dùng `gpt-realtime-translate`; phụ đề nguồn mặc định dùng kết nối `gpt-live-transcribe` riêng với từ khóa tương ứng. Dịch âm thanh không chờ phụ đề.

Nếu thu bằng mic máy tính hoặc mic phòng, dùng chế độ **Microphone / mic phòng** và đeo tai nghe khi thử. Với `OPENAI_NOISE_REDUCTION=auto`, chế độ này bật chống vọng/lọc nhiễu trong trình duyệt và bộ lọc `far_field` của API cho cả phiên dịch lẫn phụ đề nguồn. Nếu thu từ mixer/audio interface, chọn chế độ **Tín hiệu sạch từ mixer / audio interface** để tắt các bộ lọc; đường thu chỉ lấy micro diễn giả, tách khỏi đường phát bản dịch. Nếu `.env` cũ đặt `OPENAI_NOISE_REDUCTION=none`, đổi thành `auto` rồi khởi động lại; `none`, `near_field`, `far_field` vẫn được ưu tiên nếu đặt rõ trong `.env`. Xem [cấu hình lọc microphone của OpenAI](https://developers.openai.com/api/reference/resources/realtime/translation-client-events). Sự kiện API nhận lại cùng mã được chặn trước khi phát âm thanh hoặc ghép phụ đề. Các biện pháp này chưa bảo đảm model không lặp hoặc tự thêm nội dung; cần đối chiếu đoạn ghi âm xảy ra lỗi với bản dịch.

Khi Live Transcribe hoạt động, Whisper trong phiên dịch được tắt. Nếu Live gặp lỗi, ứng dụng báo trạng thái và chuyển phụ đề nguồn sang `gpt-realtime-whisper` trong phiên dịch đang chạy; không mở lại hoặc ngắt âm thanh dịch. Phụ đề nguồn cuối thay phụ đề tạm của đúng lượt nhận dạng. Hai cột chữ không được căn chỉnh từng từ hoặc từng câu.

Khi bấm Dừng, chờ cả phần dịch cuối và phụ đề nguồn hoàn chỉnh trước khi bắt đầu phiên mới. Dùng Full Screen để trình chiếu; dùng Xem lại toàn bộ và tải `.txt` để lưu lời thoại. Thử bằng bản ghi thật có tên thuốc, tên người, số liệu và phủ định; từ khóa không bảo đảm model không thêm/bỏ từ và chưa có đo đạc chứng minh chất lượng chuyên ngành được cải thiện.

Nếu server ở xa phòng hội nghị, máy tính trong phòng vẫn cần trình duyệt để thu âm và phát bản dịch vào hệ thống tai nghe cabin. Chọn thiết bị phát âm thanh trên máy tính đó đúng với đường Line In của bộ phát cabin.

Nếu thư mục `node_modules` bị thiếu, file chạy sẽ cài thư viện theo `package-lock.json`; trường hợp này server cần npm và Internet để tải thư viện.
