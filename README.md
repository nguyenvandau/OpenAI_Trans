# AI Cabin – OpenAI Realtime Translation MVP

MVP một phòng hội nghị: **dịch song song Anh ↔ Việt bằng `gpt-realtime-translate`**, tạo một luồng âm thanh trên server rồi phát PCM và phụ đề cho nhiều người nghe. Mặc định Anh → Việt; chọn Việt → Anh khi đổi ngôn ngữ diễn giả.

## Sơ đồ

Mixer AUX/REC OUT → USB Audio Interface → Laptop Operator → `gpt-realtime-translate` dịch trực tiếp từ âm thanh → trang nghe → hệ thống tai nghe cabin hoặc điện thoại người nghe.

Mặc định, cùng âm thanh mic được gửi sang một kết nối `gpt-live-transcribe` riêng để tạo phụ đề nguyên văn với từ khóa chuyên ngành. Dịch âm thanh chạy liên tục, không chờ kết quả nhận dạng. Cả phòng dùng chung hai kết nối này; không tạo phiên OpenAI cho từng người nghe.

## Yêu cầu và cài đặt

- Node.js 20 trở lên.
- OpenAI API key có quyền dùng `gpt-realtime-translate` và `gpt-live-transcribe` cho phụ đề nguyên văn có từ khóa. Có thể chọn `gpt-realtime-whisper` nếu chưa có quyền dùng Live Transcribe.
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

Điền **Tên diễn giả (Speaker)** và **Tên bài trình bày** trên trang điều khiển, rồi bấm **Cập nhật thông tin**. Trang phụ đề và chế độ Full Screen cập nhật ngay cho mọi người nghe, kể cả khi phiên dịch đang chạy. Bấm Bắt đầu cũng lưu các ô vừa sửa. Để trống một ô để ẩn dòng đó; để trống cả hai rồi cập nhật để ẩn toàn bộ thông tin. Thông tin được giữ qua các phiên dịch và cần nhập lại sau khi khởi động lại server.

Trang điều khiển có mục **Chiều dịch**: **Tiếng Anh → Tiếng Việt** (mặc định) hoặc **Tiếng Việt → Tiếng Anh**. Model tự nhận ngôn ngữ đầu vào nhưng cần một ngôn ngữ đầu ra cố định; ứng dụng không tự đổi sang ngôn ngữ còn lại. Đổi chiều bằng mục chọn khi diễn giả đổi ngôn ngữ. Có thể đổi trong cùng kết nối; nhãn trên trang nghe cập nhật khi OpenAI xác nhận cấu hình mới. Phụ đề và lịch sử trước đó được giữ lại.

Ứng dụng kết nối `/v1/realtime/translations?model=gpt-realtime-translate`. AudioContext resample mic về PCM16 mono 24 kHz; AudioWorklet thu các khung 200 ms, gồm cả khoảng lặng. Server giữ âm thanh trong lúc khởi tạo phiên rồi gửi liên tục, không chờ người nói ngừng, không đợi phụ đề hoàn chỉnh, không chia lượt bằng VAD và không dùng hàng đợi bản chữ để tạo bản dịch. Model quyết định lúc đã có đủ ngữ cảnh để phát cụm dịch; ứng dụng phát âm thanh nhận được ngay theo thứ tự. Độ trễ vẫn phụ thuộc model, tốc độ nói, độ dài bản dịch, mạng và bộ đệm phát âm thanh. Xem [hướng dẫn Realtime translation](https://developers.openai.com/api/docs/guides/realtime-translation).

Bản dịch đi trực tiếp từ âm thanh vào model chuyên dịch. Ứng dụng không tự thêm lời dẫn, tóm tắt, hoàn thành câu, suy diễn thuật ngữ hay ghép nội dung từ một model hội thoại. API này không hỗ trợ prompt tùy chỉnh, glossary, VAD hoặc chọn giọng; giao diện đã bỏ chọn giọng. Bộ thuật ngữ chỉ được dùng cho phụ đề nguồn, không được gửi làm prompt hay glossary cho âm thanh dịch. Xem [giới hạn tùy chỉnh và kiểm thử thuật ngữ của OpenAI](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide#test-terminology-and-names-directly). Không thể cam kết model luôn đúng ngữ pháp hoặc không bao giờ thêm/bỏ từ. Kiểm tra nguyên văn, bản dịch và bản ghi thật trước hội nghị, đặc biệt với tên riêng, tên thuốc, số liệu, phủ định và câu chưa nói hết.

Phụ đề nguồn mặc định dùng `gpt-live-transcribe` trong một kết nối riêng. Khi Live Transcribe hoạt động, nhận dạng `gpt-realtime-whisper` trong phiên dịch được tắt để tránh nhận và hiển thị hai bản nguyên văn. Nếu Live gặp lỗi, ứng dụng tự chuyển phụ đề nguồn sang `gpt-realtime-whisper` trong phiên dịch hiện tại và báo trạng thái; âm thanh dịch tiếp tục, không cần chờ hoặc mở lại phiên dịch. Phụ đề Whisper dự phòng không dùng prompt hoặc từ khóa chuyên ngành.

Phụ đề nguồn và bản dịch có thể về lệch thời điểm, không được căn chỉnh từng từ hoặc từng câu. Web giữ nguyên các mảnh chữ, kể cả mảnh nằm giữa một từ; không chèn khoảng trắng hoặc bỏ mảnh chỉ vì trùng thời gian. Khi nhận kết quả nguồn hoàn chỉnh, bản cuối thay bản tạm của đúng lượt nhận dạng; ứng dụng không dùng bảng thuật ngữ để tìm/thay từ sau nhận dạng. Cách xử lý deltas và bản cuối dựa trên [hướng dẫn Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription).

Khi bấm **Dừng**, ứng dụng ngừng thu mic, gửi phần âm thanh còn lại rồi chờ cả phần dịch cuối và các phụ đề nguồn chưa hoàn tất. Trang nghe tiếp tục phát hết âm thanh đã nhận. Nút bắt đầu được mở lại sau khi hoàn tất đóng phiên hoặc kết thúc xử lý lỗi; phiên mới xóa phụ đề trực tiếp và bộ đệm âm thanh cũ, còn lịch sử vẫn được giữ. Xem [cách đóng phiên để nhận hết phần dịch cuối](https://developers.openai.com/api/docs/guides/realtime-translation#close-a-websocket-session).

## Bộ thuật ngữ hội nghị và phụ đề nguồn

Gói triển khai giữ nguyên 16 file người dùng cung cấp: bộ gốc và ba bản `_v2`, `_v3`, `_v4`, đều nằm cạnh `server.mjs`. Các bản mới mở rộng tích lũy; ứng dụng hợp nhất và loại các mục/từ khóa trùng khi khởi động:

| File | Cách dùng |
| --- | --- |
| `gpt-live-transcribe_EN_session*.json` | Hợp nhất 337 từ khóa EN trong bốn JSON; bổ sung ba tên đơn vị đầy đủ từ XLSX, tổng **340** từ khóa cho Anh → Việt. |
| `gpt-live-transcribe_VI_session*.json` | Hợp nhất 287 từ khóa trong bốn JSON; bổ sung ba tên đơn vị đầy đủ từ XLSX, tổng **290** từ khóa cho Việt → Anh; giữ gợi ý ngôn ngữ `vi` và `en`. |
| `IFR2026_glossary_EN-VI*.csv` | Bộ gốc 475 mục; v2 671, v3 792, v4 955. Giữ trường `source`, `pair_type` của bản mới và các nghĩa/ghi chú khác nhau. |
| `IFR2026_Thuat_ngu_Anh-Viet*.xlsx` | Bốn bản tra cứu với các sheet thuật ngữ, diễn giả, đơn vị và từ khóa; không đọc XLSX trong lúc thu/dịch. |
| `IFR2026_glossary_EN-VI_supplement.csv` | Bốn cặp tên đơn vị chỉ có trong sheet `Don vi` của XLSX v2–v4; có địa chỉ ô để đối chiếu. |

Sau hợp nhất có **959 mục đối chiếu: 865 thuật ngữ, 72 diễn giả, 22 đơn vị**, tăng 484 mục so với bộ gốc. Các dòng lặp qua nhiều phiên bản chỉ được tính một lần; ghi chú hoặc nguồn khác nhau được giữ. File gốc không bị ghi đè. Tự nhận các nhóm CSV và hai JSON cùng hậu tố `_vN`; khi bổ sung một nhóm mới, chép đủ các file rồi khởi động lại server.

Ứng dụng chỉ lấy các trường cấu hình nhận dạng đã cho phép từ JSON, kiểm tra từ khóa và ngôn ngữ, rồi bổ sung chỉ dẫn bám nội dung thực sự nghe được như bản đang dùng. Giữ model, prompt, ngôn ngữ và delay của hai JSON gốc; các bản bổ sung chỉ mở rộng từ khóa, không nối các prompt. Từ khóa là gợi ý chính tả, không phải nội dung bắt buộc phải phát ra. Nghĩa có `/`, tên có học hàm và ghi chú được giữ nguyên trong bộ đối chiếu; không tự chọn một nghĩa hoặc bổ sung học hàm vào lời thoại. Ví dụ `DM` có thể là viêm da cơ hoặc đái tháo đường nên không được tự thay theo viết tắt.

Các CSV/XLSX/JSON được lưu trên server web. Khi mở phiên phụ đề nguồn hoặc đổi chiều dịch, server gửi cấu hình gọn gồm prompt và từ khóa của ngôn ngữ nguồn sang OpenAI qua `session.update`; không tải toàn bộ CSV/XLSX, không tạo kho thuật ngữ hay huấn luyện model riêng. Âm thanh dịch `gpt-realtime-translate` không nhận bảng thuật ngữ hoặc kết quả phụ đề.

Các file được đọc/hợp nhất một lần khi server khởi động. Mỗi phiên chỉ gửi danh sách từ khóa đã loại trùng, không gửi lại ở mỗi gói mic và không mở thêm phiên API theo số file. Thêm từ khóa tăng kích thước cấu hình và có thể ảnh hưởng thời gian khởi tạo/nhận dạng; chưa đo được mức tăng độ trễ trên hội nghị thực tế. Luồng dịch âm thanh không đợi phụ đề hoặc xử lý thuật ngữ. OpenAI không công bố mức chậm theo số từ khóa; cần đo bằng âm thanh thật. Xem [ngữ cảnh nhận dạng](https://developers.openai.com/api/docs/guides/realtime-transcription#add-transcription-context) và [đánh đổi độ trễ/chất lượng](https://developers.openai.com/api/docs/guides/realtime-transcription#tune-latency-and-accuracy).

Hai JSON gốc đang đặt `delay: "medium"`; các bản mới cũng cùng giá trị. Tham số này chỉ điều chỉnh nhận dạng phụ đề nguồn, không làm dịch âm thanh chờ phụ đề. Có thể đổi `delay` trong hai JSON gốc rồi khởi động lại server; các giá trị hợp lệ là `minimal`, `low`, `medium`, `high`, `xhigh`. Độ trễ thực tế cần đo bằng âm thanh hội nghị. Việc nạp từ khóa chưa chứng minh chất lượng nhận dạng hoặc dịch chuyên ngành đã tốt hơn; cần đối chiếu bản ghi thật. Xem [cấu hình ngữ cảnh và độ trễ nhận dạng](https://developers.openai.com/api/docs/guides/realtime-transcription#add-transcription-context).

Trong `.env`, lựa chọn mặc định là:

```env
OPENAI_SOURCE_TRANSCRIPTION=gpt-live-transcribe
```

Nếu muốn dùng phụ đề nguyên văn trong phiên dịch mà không mở kết nối Live riêng:

```env
OPENAI_SOURCE_TRANSCRIPTION=gpt-realtime-whisper
```

Trong `.env` có thể chỉnh lọc nhiễu:

```env
# Nguồn sạch lấy trực tiếp từ mixer:
OPENAI_NOISE_REDUCTION=none
# Micro gần người nói: near_field; micro thu cả phòng: far_field.
```

Khởi động lại server sau khi thay đổi `.env`. Cấu hình cũ `VAD_SILENCE_MS` không còn được sử dụng. API key chỉ được đọc trên server.

Chạy `npm test` để kiểm tra cấu hình, đọc bộ thuật ngữ, thu và truyền âm thanh liên tục, giữ các từ đầu/cuối, đổi ngôn ngữ, cập nhật phụ đề cuối và xử lý lỗi bằng kết nối giả lập. Các kiểm thử này không đánh giá độ chính xác của AI. Kiểm tra thực tế cần API key có quyền truy cập model và bản ghi âm để đối chiếu.

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

Màn hình 16:9 hiển thị tiếng Việt bên trái dưới tiêu đề **BÁO CÁO VIÊN**, tiếng Anh bên phải dưới tiêu đề **SPEAKER**. Mỗi bên đặt câu hoặc đoạn mới nhất ở trên cùng, giữ nguyên thứ tự từ trong câu. Cách hiển thị này áp dụng cả trang nghe và Full Screen. Dịch âm thanh diễn ra song song với nhận dạng phụ đề, vẫn có độ trễ xử lý. Khi đổi chiều, phụ đề đã nhận được giữ trong cột ngôn ngữ của đoạn đó.

Nút **Xem lại toàn bộ** mở lời thoại song ngữ nhận được từ khi mở trang, với đoạn mới nhất ở trên cùng. Lịch sử giữ nội dung các phiên trước. Dùng **Tải lời thoại (.txt)** trước khi tải lại hoặc đóng trang; file tải xuống giữ thứ tự diễn tiến hội nghị. Lịch sử nằm trong bộ nhớ trang nghe, không lưu trên server.

## Triển khai cho nhiều người nghe

MVP phát PCM16 mono 24 kHz, khoảng 384 kbps âm thanh thuần cho mỗi người nghe, chưa kể WebSocket overhead. Bản dịch được tạo một lần rồi chia sẻ tới tất cả người nghe.

Cho hội nghị 100–500 người, có thể giữ phiên dịch trên server và thay tầng phát PCM bằng Opus 24–48 kbps qua WebRTC SFU. Cần thử tải với số thiết bị gần thực tế, giám sát độ trễ và có đường Internet/worker dự phòng. Xem [PRODUCTION_ARCHITECTURE.md](PRODUCTION_ARCHITECTURE.md).

Tài liệu OpenAI: [Realtime translation](https://developers.openai.com/api/docs/guides/realtime-translation), [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription), [giới hạn tùy chỉnh thuật ngữ](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide#test-terminology-and-names-directly), [Translation client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events), [Translation server events](https://developers.openai.com/api/reference/resources/realtime/translation-server-events).
