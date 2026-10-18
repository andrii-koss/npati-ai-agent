# PLAN additions: 2811 to2884

The committed PLAN appended Stage6 at lines1078–1118. The original2811 anchors remain unchanged;73 source-clause occurrences were added. No new requirements were invented by the audit. The stable counting rule also retains heading fragments and repeated concepts, so this is not a count of unique capabilities.

Duplicate IDs:0. Duplicate source anchors:0. Exact normalized clause duplicates against the entire ledger:0. Semantic overlap with earlier requirements is expected (isolation, approvals, lifecycle); it is retained as separately requested acceptance evidence rather than claimed to be a new feature.

| ID | Clause | Full PLAN source |
| --- | --- | --- |
| [GLOBAL.L1081.01](PLAN.md#L1081) | **Безпека `{ force: true }` у Hard Purge:** | 1. **Безпека `{ force: true }` у Hard Purge:** |
| [GLOBAL.L1082.01](PLAN.md#L1082) | Звичайні користувачі (`developer`, `reviewer`) | - Звичайні користувачі (`developer`, `reviewer`) та кодувальний агент (`service`) обмежені від обходу 30-денного retention без спеціальних прав. |
| [GLOBAL.L1082.02](PLAN.md#L1082) | кодувальний агент (`service`) обмежені від обходу 30-денного retention без спеціальних прав. | - Звичайні користувачі (`developer`, `reviewer`) та кодувальний агент (`service`) обмежені від обходу 30-денного retention без спеціальних прав. |
| [GLOBAL.L1083.01](PLAN.md#L1083) | Запит із `force: true` дозволений виключно для ролей `owner` | - Запит із `force: true` дозволений виключно для ролей `owner` та `admin`. |
| [GLOBAL.L1083.02](PLAN.md#L1083) | `admin`. | - Запит із `force: true` дозволений виключно для ролей `owner` та `admin`. |
| [GLOBAL.L1084.01](PLAN.md#L1084) | Несанкціоновані спроби відхиляються з кодом HTTP 403 `force_purge_not_permitted` | - Несанкціоновані спроби відхиляються з кодом HTTP 403 `force_purge_not_permitted` та обов'язково записуються в `AuditLog` із контекстом відхиленої дії. |
| [GLOBAL.L1084.02](PLAN.md#L1084) | обов'язково записуються в `AuditLog` із контекстом відхиленої дії. | - Несанкціоновані спроби відхиляються з кодом HTTP 403 `force_purge_not_permitted` та обов'язково записуються в `AuditLog` із контекстом відхиленої дії. |
| [GLOBAL.L1085.01](PLAN.md#L1085) | **Повна ізоляція тестових середовищ:** | 2. **Повна ізоляція тестових середовищ:** |
| [GLOBAL.L1086.01](PLAN.md#L1086) | Усі верифікаційні тести виконуються у повністю ізольованих disposable проєктах | - Усі верифікаційні тести виконуються у повністю ізольованих disposable проєктах та виділеному disposable DataBackend (`db_<backendId>_dev/prod`). |
| [GLOBAL.L1086.02](PLAN.md#L1086) | виділеному disposable DataBackend (`db_<backendId>_dev/prod`). | - Усі верифікаційні тести виконуються у повністю ізольованих disposable проєктах та виділеному disposable DataBackend (`db_<backendId>_dev/prod`). |
| [GLOBAL.L1087.01](PLAN.md#L1087) | Робочий інтернет-магазин (`715009ee-a7bf-4999-bce2-053d207b7af5`) | - Робочий інтернет-магазин (`715009ee-a7bf-4999-bce2-053d207b7af5`) та його база DataBackend залишаються недоторканими. |
| [GLOBAL.L1087.02](PLAN.md#L1087) | його база DataBackend залишаються недоторканими. | - Робочий інтернет-магазин (`715009ee-a7bf-4999-bce2-053d207b7af5`) та його база DataBackend залишаються недоторканими. |
| [GLOBAL.L1088.01](PLAN.md#L1088) | **Автоматичний Retention Worker:** | 3. **Автоматичний Retention Worker:** |
| [GLOBAL.L1089.01](PLAN.md#L1089) | Реалізовано | - Реалізовано та підтверджено автоматичний пошук прострочених проєктів (`status = 'soft_deleted' AND purge_after <= NOW()`). |
| [GLOBAL.L1089.02](PLAN.md#L1089) | підтверджено автоматичний пошук прострочених проєктів (`status = 'soft_deleted' AND purge_after <= NOW()`). | - Реалізовано та підтверджено автоматичний пошук прострочених проєктів (`status = 'soft_deleted' AND purge_after <= NOW()`). |
| [GLOBAL.L1090.01](PLAN.md#L1090) | Повне очищення MinIO медіафайлів за префіксом `${companyId}/${projectId}/*` | - Повне очищення MinIO медіафайлів за префіксом `${companyId}/${projectId}/*` та видалення метаданих після 30-денного retention. |
| [GLOBAL.L1090.02](PLAN.md#L1090) | видалення метаданих після 30-денного retention. | - Повне очищення MinIO медіафайлів за префіксом `${companyId}/${projectId}/*` та видалення метаданих після 30-денного retention. |
| [GLOBAL.L1091.01](PLAN.md#L1091) | Підтверджено ідемпотентність | - Підтверджено ідемпотентність та стійкість до збоїв/рестартів. |
| [GLOBAL.L1091.02](PLAN.md#L1091) | стійкість до збоїв/рестартів. | - Підтверджено ідемпотентність та стійкість до збоїв/рестартів. |
| [GLOBAL.L1092.01](PLAN.md#L1092) | **Повноцінний Restore:** | 4. **Повноцінний Restore:** |
| [GLOBAL.L1093.01](PLAN.md#L1093) | Перевірено повне відновлення: збережені файли робочого простору | - Перевірено повне відновлення: збережені файли робочого простору, процеси Sandbox, Live Preview proxy, медіафайли у MinIO та відновлення санкціонованого доступу до Data Studio. |
| [GLOBAL.L1093.02](PLAN.md#L1093) | процеси Sandbox | - Перевірено повне відновлення: збережені файли робочого простору, процеси Sandbox, Live Preview proxy, медіафайли у MinIO та відновлення санкціонованого доступу до Data Studio. |
| [GLOBAL.L1093.03](PLAN.md#L1093) | Live Preview proxy | - Перевірено повне відновлення: збережені файли робочого простору, процеси Sandbox, Live Preview proxy, медіафайли у MinIO та відновлення санкціонованого доступу до Data Studio. |
| [GLOBAL.L1093.04](PLAN.md#L1093) | медіафайли у MinIO | - Перевірено повне відновлення: збережені файли робочого простору, процеси Sandbox, Live Preview proxy, медіафайли у MinIO та відновлення санкціонованого доступу до Data Studio. |
| [GLOBAL.L1093.05](PLAN.md#L1093) | відновлення санкціонованого доступу до Data Studio. | - Перевірено повне відновлення: збережені файли робочого простору, процеси Sandbox, Live Preview proxy, медіафайли у MinIO та відновлення санкціонованого доступу до Data Studio. |
| [GLOBAL.L1096.01](PLAN.md#L1096) | **Створення інтернет-магазину | 5. **Створення інтернет-магазину та генерація коду:** |
| [GLOBAL.L1096.02](PLAN.md#L1096) | генерація коду:** | 5. **Створення інтернет-магазину та генерація коду:** |
| [GLOBAL.L1097.01](PLAN.md#L1097) | Автономне створення кодової структури інтернет-магазину (Node.js/Next.js) через реальний Coding Runtime. | - Автономне створення кодової структури інтернет-магазину (Node.js/Next.js) через реальний Coding Runtime. |
| [GLOBAL.L1098.01](PLAN.md#L1098) | Валідація створених файлів (`package.json`, `server.js`) | - Валідація створених файлів (`package.json`, `server.js`), маршрутизації та відсутності залежностей від небезпечних зовнішніх модулів. |
| [GLOBAL.L1098.02](PLAN.md#L1098) | маршрутизації | - Валідація створених файлів (`package.json`, `server.js`), маршрутизації та відсутності залежностей від небезпечних зовнішніх модулів. |
| [GLOBAL.L1098.03](PLAN.md#L1098) | відсутності залежностей від небезпечних зовнішніх модулів. | - Валідація створених файлів (`package.json`, `server.js`), маршрутизації та відсутності залежностей від небезпечних зовнішніх модулів. |
| [GLOBAL.L1099.01](PLAN.md#L1099) | **Автоматичне налаштування Data Studio:** | 6. **Автоматичне налаштування Data Studio:** |
| [GLOBAL.L1100.01](PLAN.md#L1100) | Створення ізольованих баз даних `db_<backendId>_dev` | - Створення ізольованих баз даних `db_<backendId>_dev` та `db_<backendId>_prod` на `postgres-projects:5432`. |
| [GLOBAL.L1100.02](PLAN.md#L1100) | `db_<backendId>_prod` на `postgres-projects:5432`. | - Створення ізольованих баз даних `db_<backendId>_dev` та `db_<backendId>_prod` на `postgres-projects:5432`. |
| [GLOBAL.L1101.01](PLAN.md#L1101) | Ініціалізація | - Ініціалізація та валідація таблиць: `products`, `users`, `orders`, `order_items`. |
| [GLOBAL.L1101.02](PLAN.md#L1101) | валідація таблиць: `products` | - Ініціалізація та валідація таблиць: `products`, `users`, `orders`, `order_items`. |
| [GLOBAL.L1101.03](PLAN.md#L1101) | `users` | - Ініціалізація та валідація таблиць: `products`, `users`, `orders`, `order_items`. |
| [GLOBAL.L1101.04](PLAN.md#L1101) | `orders` | - Ініціалізація та валідація таблиць: `products`, `users`, `orders`, `order_items`. |
| [GLOBAL.L1101.05](PLAN.md#L1101) | `order_items`. | - Ініціалізація та валідація таблиць: `products`, `users`, `orders`, `order_items`. |
| [GLOBAL.L1102.01](PLAN.md#L1102) | **Браузерне Playwright E2E тестування:** | 7. **Браузерне Playwright E2E тестування:** |
| [GLOBAL.L1103.01](PLAN.md#L1103) | Відкриття Live Preview через підписаний безпечний міст (`/preview/proxy/?token=...`). | - Відкриття Live Preview через підписаний безпечний міст (`/preview/proxy/?token=...`). |
| [GLOBAL.L1104.01](PLAN.md#L1104) | Наскрізний сценарій покупця: реєстрація (Signup) | - Наскрізний сценарій покупця: реєстрація (Signup), вхід (Login), збереження сесії при перезавантаженні сторінки (Refresh), додавання товарів до кошика (Add to Cart, 2 товари, сума $139.98), оформлення замовлення (Checkout) та вихід (Logout). |
| [GLOBAL.L1104.02](PLAN.md#L1104) | вхід (Login) | - Наскрізний сценарій покупця: реєстрація (Signup), вхід (Login), збереження сесії при перезавантаженні сторінки (Refresh), додавання товарів до кошика (Add to Cart, 2 товари, сума $139.98), оформлення замовлення (Checkout) та вихід (Logout). |
| [GLOBAL.L1104.03](PLAN.md#L1104) | збереження сесії при перезавантаженні сторінки (Refresh) | - Наскрізний сценарій покупця: реєстрація (Signup), вхід (Login), збереження сесії при перезавантаженні сторінки (Refresh), додавання товарів до кошика (Add to Cart, 2 товари, сума $139.98), оформлення замовлення (Checkout) та вихід (Logout). |
| [GLOBAL.L1104.04](PLAN.md#L1104) | додавання товарів до кошика (Add to Cart, 2 товари, сума $139.98) | - Наскрізний сценарій покупця: реєстрація (Signup), вхід (Login), збереження сесії при перезавантаженні сторінки (Refresh), додавання товарів до кошика (Add to Cart, 2 товари, сума $139.98), оформлення замовлення (Checkout) та вихід (Logout). |
| [GLOBAL.L1104.05](PLAN.md#L1104) | оформлення замовлення (Checkout) | - Наскрізний сценарій покупця: реєстрація (Signup), вхід (Login), збереження сесії при перезавантаженні сторінки (Refresh), додавання товарів до кошика (Add to Cart, 2 товари, сума $139.98), оформлення замовлення (Checkout) та вихід (Logout). |
| [GLOBAL.L1104.06](PLAN.md#L1104) | вихід (Logout). | - Наскрізний сценарій покупця: реєстрація (Signup), вхід (Login), збереження сесії при перезавантаженні сторінки (Refresh), додавання товарів до кошика (Add to Cart, 2 товари, сума $139.98), оформлення замовлення (Checkout) та вихід (Logout). |
| [GLOBAL.L1105.01](PLAN.md#L1105) | Скріншоти збережені в артефактах: `preview-initial-load.png` | - Скріншоти збережені в артефактах: `preview-initial-load.png`, `preview-signup-success.png`, `preview-logged-in.png`, `preview-cart-items.png`, `preview-order-success.png`, `preview-logged-out.png`. |
| [GLOBAL.L1105.02](PLAN.md#L1105) | `preview-signup-success.png` | - Скріншоти збережені в артефактах: `preview-initial-load.png`, `preview-signup-success.png`, `preview-logged-in.png`, `preview-cart-items.png`, `preview-order-success.png`, `preview-logged-out.png`. |
| [GLOBAL.L1105.03](PLAN.md#L1105) | `preview-logged-in.png` | - Скріншоти збережені в артефактах: `preview-initial-load.png`, `preview-signup-success.png`, `preview-logged-in.png`, `preview-cart-items.png`, `preview-order-success.png`, `preview-logged-out.png`. |
| [GLOBAL.L1105.04](PLAN.md#L1105) | `preview-cart-items.png` | - Скріншоти збережені в артефактах: `preview-initial-load.png`, `preview-signup-success.png`, `preview-logged-in.png`, `preview-cart-items.png`, `preview-order-success.png`, `preview-logged-out.png`. |
| [GLOBAL.L1105.05](PLAN.md#L1105) | `preview-order-success.png` | - Скріншоти збережені в артефактах: `preview-initial-load.png`, `preview-signup-success.png`, `preview-logged-in.png`, `preview-cart-items.png`, `preview-order-success.png`, `preview-logged-out.png`. |
| [GLOBAL.L1105.06](PLAN.md#L1105) | `preview-logged-out.png`. | - Скріншоти збережені в артефактах: `preview-initial-load.png`, `preview-signup-success.png`, `preview-logged-in.png`, `preview-cart-items.png`, `preview-order-success.png`, `preview-logged-out.png`. |
| [GLOBAL.L1106.01](PLAN.md#L1106) | Підтверджено збереження покупців | - Підтверджено збереження покупців і замовлень у таблицях Project PostgreSQL. |
| [GLOBAL.L1106.02](PLAN.md#L1106) | замовлень у таблицях Project PostgreSQL. | - Підтверджено збереження покупців і замовлень у таблицях Project PostgreSQL. |
| [GLOBAL.L1107.01](PLAN.md#L1107) | **MinIO медіафайли | 8. **MinIO медіафайли та стійкість Sandbox:** |
| [GLOBAL.L1107.02](PLAN.md#L1107) | стійкість Sandbox:** | 8. **MinIO медіафайли та стійкість Sandbox:** |
| [GLOBAL.L1108.01](PLAN.md#L1108) | Медіафайли товарів зберігаються у MinIO бакеті `npati-project-media`. | - Медіафайли товарів зберігаються у MinIO бакеті `npati-project-media`. |
| [GLOBAL.L1109.01](PLAN.md#L1109) | Стрімінг медіа через безпечні endpoints `/api/projects/:projectId/media/*` із CSP заголовками (`image/svg+xml`). | - Стрімінг медіа через безпечні endpoints `/api/projects/:projectId/media/*` із CSP заголовками (`image/svg+xml`). |
| [GLOBAL.L1110.01](PLAN.md#L1110) | Повна доступність зображень підтверджена після зупинки | - Повна доступність зображень підтверджена після зупинки та повторного запуску Sandbox процесу. |
| [GLOBAL.L1110.02](PLAN.md#L1110) | повторного запуску Sandbox процесу. | - Повна доступність зображень підтверджена після зупинки та повторного запуску Sandbox процесу. |
| [GLOBAL.L1111.01](PLAN.md#L1111) | **Континуація | 9. **Континуація та редагування існуючого проєкту:** |
| [GLOBAL.L1111.02](PLAN.md#L1111) | редагування існуючого проєкту:** | 9. **Континуація та редагування існуючого проєкту:** |
| [GLOBAL.L1112.01](PLAN.md#L1112) | Успішна модифікація існуючого сайту в межах тієї ж розмови (додавання бейджа `🔥 HOT DEAL`, оновлення брендингу). | - Успішна модифікація існуючого сайту в межах тієї ж розмови (додавання бейджа `🔥 HOT DEAL`, оновлення брендингу). |
| [GLOBAL.L1113.01](PLAN.md#L1113) | Підтверджено збереження незмінного Project ID | - Підтверджено збереження незмінного Project ID, оновлення ревізії та повне збереження існуючих замовлень у базі даних (0 втрат даних). |
| [GLOBAL.L1113.02](PLAN.md#L1113) | оновлення ревізії | - Підтверджено збереження незмінного Project ID, оновлення ревізії та повне збереження існуючих замовлень у базі даних (0 втрат даних). |
| [GLOBAL.L1113.03](PLAN.md#L1113) | повне збереження існуючих замовлень у базі даних (0 втрат даних). | - Підтверджено збереження незмінного Project ID, оновлення ревізії та повне збереження існуючих замовлень у базі даних (0 втрат даних). |
| [GLOBAL.L1114.01](PLAN.md#L1114) | **Негативні безпекові перевірки:** | 10. **Негативні безпекові перевірки:** |
| [GLOBAL.L1115.01](PLAN.md#L1115) | Міжпроєктна ізоляція: спроба доступу до файлів проєкту A з чужої компанії повертає HTTP 403 Forbidden. | - Міжпроєктна ізоляція: спроба доступу до файлів проєкту A з чужої компанії повертає HTTP 403 Forbidden. |
| [GLOBAL.L1116.01](PLAN.md#L1116) | SQL-ізоляція: створені сайти | - SQL-ізоляція: створені сайти та користувачі `postgres-projects` не мають доступу до таблиць NPATI Core PostgreSQL (`audit_logs` тощо). |
| [GLOBAL.L1116.02](PLAN.md#L1116) | користувачі `postgres-projects` не мають доступу до таблиць NPATI Core PostgreSQL (`audit_logs` тощо). | - SQL-ізоляція: створені сайти та користувачі `postgres-projects` не мають доступу до таблиць NPATI Core PostgreSQL (`audit_logs` тощо). |
| [GLOBAL.L1117.01](PLAN.md#L1117) | Data Studio захист: неавторизовані відвідувачі позбавлені доступу до Data Studio schema mutation API (HTTP 401 Access Denied). | - Data Studio захист: неавторизовані відвідувачі позбавлені доступу до Data Studio schema mutation API (HTTP 401 Access Denied). |
| [GLOBAL.L1118.01](PLAN.md#L1118) | Force Purge захист: спроба звичайного користувача виконати примусове видалення повертає HTTP 403 `force_purge_not_permitted`. | - Force Purge захист: спроба звичайного користувача виконати примусове видалення повертає HTTP 403 `force_purge_not_permitted`. |
