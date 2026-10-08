# Kiến trúc production cho 100–500 người

## Luồng hiện tại và tầng phát đề xuất

1. Mixer tạo một AUX bus sạch chỉ chứa micro sân khấu.
2. USB audio interface đưa âm thanh vào máy Operator. AudioWorklet thu PCM16 mono 24 kHz theo khung 200 ms và gửi tới server liên tục, gồm cả khoảng lặng.
3. Server gửi cùng âm thanh tới hai kết nối độc lập: phiên dịch `/v1/realtime/translations?model=gpt-realtime-translate` và phiên phụ đề nguồn `/v1/realtime?intent=transcription` dùng `gpt-live-transcribe`.
4. Phiên dịch trả âm thanh và chữ dịch theo ngôn ngữ đầu ra đã chọn (`vi` hoặc `en`). Không chờ VAD, ngắt câu hoặc nhận dạng hoàn chỉnh mới dịch. Người điều khiển đổi chiều khi diễn giả đổi ngôn ngữ; ứng dụng không tự đổi chiều.
5. Phiên phụ đề nguồn nhận từ khóa từ hai JSON hội nghị: 166 từ khóa EN cho Anh → Việt, 133 từ khóa VI cho Việt → Anh; profile VI gợi ý cả `vi` và `en`. Khi gửi API, thay phần mô tả chủ đề/tên/địa điểm bằng yêu cầu chép nguyên văn lời nghe được, không đoán hay tự hoàn thành câu. `delay: "medium"` điều chỉnh phụ đề, không điều chỉnh âm thanh dịch.
6. Khi Live hoạt động, tắt phụ đề Whisper trong phiên dịch để tránh nguồn chữ trùng. Nếu Live lỗi, bật lại `gpt-realtime-whisper` trong cùng phiên dịch và thông báo trạng thái. Âm thanh dịch không chờ phụ đề và không phải khởi tạo lại kết nối.
7. Khi dừng, kết thúc cả hai luồng: gửi `session.close` cho phiên dịch và nhận hết phần đuôi trước `session.closed`; commit phần âm thanh nhận dạng còn lại rồi nhận bản phụ đề cuối. Kết quả nguồn cuối thay bản tạm theo đúng `item_id`, không nối thêm một bản trùng.
8. MVP phát PCM tới người nghe qua WebSocket. Với hệ thống đông người, thêm Media Gateway để mã hóa Opus 24–48 kbps rồi phát một track bản dịch qua WebRTC SFU. Phụ đề có thể đi qua data channel hoặc WebSocket.

Cả phòng dùng chung một phiên dịch và một phiên nhận dạng nguồn; không tạo hai phiên cho mỗi điện thoại. Phụ đề nguồn, phụ đề dịch và âm thanh có độ trễ khác nhau. Không coi các đoạn hiển thị là cặp đã căn chỉnh từng câu hoặc từng từ; `gpt-live-transcribe` không cung cấp timestamp từng từ. Xem [hướng dẫn Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) và [Realtime translation](https://developers.openai.com/api/docs/guides/realtime-translation).

Operator gửi chế độ nguồn thu khi mở WebSocket. Với `OPENAI_NOISE_REDUCTION=auto` (mặc định), mic máy tính/phòng dùng chống vọng và lọc nhiễu trình duyệt cùng `far_field` của API; tín hiệu sạch từ mixer tắt các bộ lọc. Server giữ cùng lựa chọn cho cả hai kết nối trong suốt phiên, kể cả đổi chiều và chuyển phụ đề dự phòng. Không bỏ các khung khoảng lặng. Cấu hình rõ `none`, `near_field`, `far_field` trong môi trường được ưu tiên hơn `auto`.

## Bộ thuật ngữ và giới hạn sử dụng

Gói ZIP giữ đủ `IFR2026_glossary_EN-VI.csv`, `IFR2026_Thuat_ngu_Anh-Viet.xlsx`, `gpt-live-transcribe_EN_session.json` và `gpt-live-transcribe_VI_session.json`. CSV gồm 475 mục: 407 thuật ngữ, 50 diễn giả và 18 đơn vị. XLSX là bản tra cứu; không thêm bộ đọc XLSX vào đường xử lý trực tiếp.

Chỉ lấy các trường nhận dạng được cho phép từ JSON: model, prompt, keywords, languages và delay. Kiểm tra prompt gốc nhưng thay bằng yêu cầu nguyên văn khi gửi API để không đưa sẵn chủ đề/tên/địa điểm làm ngữ cảnh nhận dạng; không sửa file JSON người dùng. Từ khóa là gợi ý; prompt yêu cầu chỉ ghi từ khóa khi nghe được trong âm thanh, nhưng không có bộ lọc nội dung cưỡng chế điều đó. Giữ nguyên các cặp có nhiều nghĩa, ghi chú và học hàm trong bộ đối chiếu; không tìm/thay trên phụ đề hoặc sửa âm thanh theo bảng từ. `DM` có hai nghĩa và một số dòng có `/` chứa hai khái niệm khác nhau, nên thay thế máy móc có thể làm sai lời nói.

`gpt-realtime-translate` hiện không hỗ trợ prompt hoặc glossary tùy chỉnh. Những file này cung cấp từ khóa cho phụ đề nguồn và làm bộ đối chiếu; không truyền bản chữ nhận dạng sang model dịch, không dùng glossary để buộc âm thanh đổi thuật ngữ. Xem [giới hạn và cách kiểm thử thuật ngữ của OpenAI](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide#test-terminology-and-names-directly). Cần đo chất lượng bằng bản ghi hội nghị thực tế; việc nạp từ khóa chưa chứng minh chất lượng nhận dạng hoặc dịch chuyên ngành đã tốt hơn.

## Vận hành và dự phòng

- Worker A hoạt động, Worker B dự phòng; kiểm tra thời gian khởi tạo và cách chuyển luồng trước hội nghị.
- Internet chính qua dây/quang, Internet dự phòng qua 5G hoặc nhà mạng khác.
- UPS cho mixer, switch, AP, laptop và server.
- Theo dõi riêng độ trễ âm thanh, phụ đề, trạng thái chuyển Whisper và lỗi OpenAI. Chỉ ghi transcript khi cần cho vận hành hoặc đánh giá.
- Có thể đặt `OPENAI_SOURCE_TRANSCRIPTION=gpt-realtime-whisper` để dùng phụ đề nguồn trong phiên dịch; lựa chọn này không sử dụng ngữ cảnh hoặc từ khóa JSON.

## Mạng Wi-Fi

- AP có wired backhaul; ưu tiên 5 GHz/6 GHz.
- Tách SSID hoặc VLAN hội nghị nếu hạ tầng cho phép.
- Thử tải với số thiết bị gần thực tế và kiểm tra độ trễ từng thiết bị.
- Raw PCM16 mono 24 kHz tốn khoảng 384 kbps/người nghe chưa tính overhead; production đông người nên dùng Opus/WebRTC.

## Đánh giá trước hội nghị

Tạo bộ ghi âm và bản đối chiếu được người biết chuyên ngành kiểm tra. Dùng CSV/XLSX làm danh sách thuật ngữ cần đưa vào bài thử, không làm nội dung để model tự bổ sung. Bao gồm:

- Tên thuốc, hoạt chất và tên người.
- Viết tắt DAS28, ACR20/50/70, EULAR, DMARD, bDMARD, tsDMARD, JAK; kiểm tra riêng viết tắt mơ hồ như DM.
- Tên bệnh rheumatoid arthritis, axial spondyloarthritis và psoriatic arthritis.
- Số liệu, phần trăm, HR/RR/OR, CI, p-value, phủ định và liều lượng.
- Nói chen Anh–Việt, tốc độ nói, giọng địa phương, tiếng ồn và phiên nói dài.

Chấm riêng phụ đề nguyên văn, ý nghĩa bản dịch, thuật ngữ và độ trễ. So sánh có/không có từ khóa trên cùng bản ghi; nghe kiểm tra bản gốc và âm thanh dịch, không lấy phụ đề tự động làm đáp án chuẩn. Thử phần đầu/cuối, đổi chiều, dừng phiên và lỗi luồng phụ đề. Không thể bảo đảm model không thêm/bỏ hoặc dịch sai nội dung.
