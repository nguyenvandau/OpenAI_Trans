# Chạy AI Cabin trên server

Gói ZIP gồm ứng dụng, logo và toàn bộ thư viện chạy. Server cần có **Node.js 20 trở lên**. Không cần chạy `npm install` khi đã giải nén đầy đủ gói.

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

Mở trang điều khiển, chọn thiết bị thu từ mixer và chiều Anh → Việt hoặc Việt → Anh rồi bắt đầu phiên dịch. Mở trang Listen, bấm Bắt đầu nghe, kiểm tra cả âm thanh và phụ đề. Hệ thống dùng `gpt-realtime-translate` để dịch song song và `gpt-realtime-whisper` cho phụ đề nguyên văn; API key cần có quyền truy cập cả hai. Khi bấm Dừng, chờ phần dịch cuối hoàn tất trước khi bắt đầu phiên mới. Dùng Full Screen để trình chiếu; dùng Xem lại toàn bộ và tải `.txt` để lưu lời thoại.

Nếu server ở xa phòng hội nghị, máy tính trong phòng vẫn cần trình duyệt để thu âm và phát bản dịch vào hệ thống tai nghe cabin. Chọn thiết bị phát âm thanh trên máy tính đó đúng với đường Line In của bộ phát cabin.

Nếu thư mục `node_modules` bị thiếu, file chạy sẽ cài thư viện theo `package-lock.json`; trường hợp này server cần npm và Internet để tải thư viện.
