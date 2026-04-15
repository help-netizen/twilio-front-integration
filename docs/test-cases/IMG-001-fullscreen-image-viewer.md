# Тест-кейсы: IMG-001 — Fullscreen Image Viewer

## Покрытие
- Всего тест-кейсов: 8
- P0: 3 | P1: 3 | P2: 2 | P3: 0
- Unit: 8 | Integration: 0 | E2E: 0

---

### TC-IMG-001: Fullscreen viewer renders on image click

- **Приоритет:** P0
- **Тип:** Unit (React Testing Library)
- **Связанный сценарий:** SC-01
- **Предусловия:** AttachmentsSection rendered with image attachments, showLargePreview=true
- **Входные данные:**
  - attachments: [{url: 'test.jpg', kind: 'image', filename: 'test.jpg'}]
  - galleryIndex: 0
- **Шаги:**
  1. Click on preview area (dark container)
  2. Assert FullscreenImageViewer mounts (fixed overlay with z-[9999])
  3. Assert image src matches attachment URL
- **Ожидаемый результат:** Fullscreen overlay visible with correct image
- **Файл для теста:** `frontend/src/components/payments/__tests__/AttachmentsFullscreen.test.tsx`

---

### TC-IMG-002: Navigation with arrow keys

- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** SC-02
- **Предусловия:** FullscreenViewer open, 3 image attachments, index=0
- **Шаги:**
  1. Press ArrowRight → index becomes 1
  2. Press ArrowRight → index becomes 2
  3. Press ArrowRight → index stays 2 (boundary)
  4. Press ArrowLeft → index becomes 1
- **Ожидаемый результат:** Index changes correctly, boundary respected

---

### TC-IMG-003: Close on Escape key

- **Приоритет:** P0
- **Тип:** Unit
- **Связанный сценарий:** SC-04
- **Предусловия:** FullscreenViewer open
- **Шаги:**
  1. Press Escape
  2. Assert onClose callback fired
- **Ожидаемый результат:** Viewer closes

---

### TC-IMG-004: Close on backdrop click

- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** SC-04
- **Предусловия:** FullscreenViewer open
- **Шаги:**
  1. Click on backdrop (dark overlay, not on image or controls)
  2. Assert onClose callback fired
- **Ожидаемый результат:** Viewer closes

---

### TC-IMG-005: Rotation resets on navigation

- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** SC-02 + SC-03
- **Предусловия:** FullscreenViewer open, rotation=90
- **Шаги:**
  1. Navigate to next image
  2. Assert rotation reset to 0
- **Ожидаемый результат:** Rotation is 0 after navigation

---

### TC-IMG-006: Thumbnail strip shows only images

- **Приоритет:** P1
- **Тип:** Unit
- **Связанный сценарий:** SC-02
- **Предусловия:** attachments mix of images and files
- **Шаги:**
  1. Open fullscreen viewer
  2. Count thumbnail buttons
- **Ожидаемый результат:** Only image attachments shown in strip

---

### TC-IMG-007: Body scroll locked when open

- **Приоритет:** P2
- **Тип:** Unit
- **Связанный сценарий:** SC-01
- **Предусловия:** FullscreenViewer mounted
- **Шаги:**
  1. Assert document.body.style.overflow === 'hidden'
  2. Unmount viewer
  3. Assert document.body.style.overflow === ''
- **Ожидаемый результат:** Scroll lock applied and cleaned up

---

### TC-IMG-008: No fullscreen for non-image attachments

- **Приоритет:** P2
- **Тип:** Unit
- **Связанный сценарий:** Граничный случай 2
- **Предусловия:** Current attachment is kind='file'
- **Шаги:**
  1. Click on preview area
  2. Assert fullscreen does NOT open
- **Ожидаемый результат:** No fullscreen overlay rendered
