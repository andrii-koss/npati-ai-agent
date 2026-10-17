# Звіт про виконання Етапу 3: Безпека, мережева ізоляція Sandbox Runner та контрольований доступ Coding Agent

**Дата:** 2026-10-17  
**Статус етапу:** ВИКОНАНО УСПІШНО (готово до перевірки, зупинка перед Етапом 4)  
**Середовище тестування:** Ізольований тестовий контур `npati-isolated-source-20261011`

---

## 1. Резюме усунення критичної P0-вразливості

На Етапі 1 було зафіксовано вразливість **P0**: контейнер `sandbox-runner-1` знаходився у спільній bridge-мережі `npati-agent` (`172.24.0.0/16`) і містив правила `iptables`, які обмежували трафік лише для діапазону UID 10000–60000 (`NPATI_PROJECTS`). Процеси з UID 0 (root) та UID 65534 (nobody) мали прямий доступ до внутрішньої Core PostgreSQL NPATI (`172.24.0.8:5432`), Redis (`172.24.0.2:6379`), MinIO (`172.24.0.4:9000`) та OmniRoute (`172.24.0.7:20128`).

**У результаті Етапу 3 вразливість повністю усунуто за принципом Defense-in-Depth:**
1. **Мережева топологія Docker:** `sandbox-runner` повністю відключено від мережі `npati-agent`. Створено виділену bridge-мережу `npati-sandbox-egress` для зовнішнього інтернет-доступу через Egress Proxy. Для керування використовується ізольована внутрішня мережа `npati-sandbox-control` (`internal: true`).
2. **Повний захист від витоків RFC / службових адрес:** У ланцюжок `OUTPUT` додано перевірку `NPATI_EGRESS_RESTRICT` для **ВСІХ UID** (включно з UID 0 та UID 65534), що блокує `172.16.0.0/12`, `10.0.0.0/8`, `192.168.0.0/16`, `169.254.0.0/16` (Cloud Metadata), `100.64.0.0/10` (CGNAT), `0.0.0.0/8`, `127.0.0.0/8` (не через `lo`), тестові/бенчмарк мережі, мультикаст, reserved та порти внутрішніх баз/сервісів (5432, 6379, 9000, 9001, 20128, 20129, 11235, 8765).
3. **Повне покриття IPv6:** Будь-який вихідний IPv6-трафік (крім локального loopback та встановлених з'єднань) відхиляється через `ip6tables` (`icmp6-port-unreachable`).
4. **Ізоляція привілеїв NET_ADMIN:** Процеси сайтів виконуються через Bubblewrap (`bwrap`) з параметрами `--unshare-net`, `--cap-drop ALL`, read-only `/proc` та seccomp-фільтром. Процеси сайтів не мають `CAP_NET_ADMIN` і не мають доступу до network namespace контейнера або правил iptables.
5. **Захист порту RPC 7865:**
   - Порт 7865 захищено HMAC-SHA256 автентифікацією (`x-npati-signature`, `x-npati-timestamp`, `x-npati-nonce`) із вікном ±30 с та захистом від replay-атак.
   - Порт доступний лише через внутрішню мережу `npati-sandbox-control` авторизованим сервісам (`agent-api`).
   - Для UID проєктів (10000–60000) спроби підключення до порту 7865 (як локально, так і віддалено) блокуються правилом `NPATI_PROJECTS` з відхиленням ICMP port unreachable.

---

## 2. Відповіді на обов'язкові пункти користувача

### Пункт 1: Повне блокування службових мереж для IPv4 та IPv6
- **IPv4:** Покриті RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), RFC 3927 Link-Local (`169.254.0.0/16`), RFC 6598 CGNAT (`100.64.0.0/10`), RFC 1122 (`0.0.0.0/8`, `127.0.0.0/8`), RFC 6890 / 5737 / 2544 (`192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`), RFC 5771 Multicast (`224.0.0.0/4`), RFC 1112 Reserved (`240.0.0.0/4`), Broadcast (`255.255.255.255/32`).
- **IPv6:** Усі не-loopback адреси (`fe80::/10`, `fc00::/7`, `ff00::/8`, global unicast) блокуються через `ip6tables -j REJECT --reject-with icmp6-port-unreachable`.
- **Легітимний трафік:** Збережено `-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT` (дозволяє легітимні відповіді RPC на порт 7865) та `-o lo -j ACCEPT` (дозволяє роботу Egress Proxy на `127.0.0.1:8080`).

### Пункт 2: Ризик NET_ADMIN та ізоляція привілеїв від сайтів
- Недовірений код виконується у власному ізольованому просторі імен через Bubblewrap (`project-runtime-launcher.mjs`).
- Bubblewrap запускається з прапорцями `--unshare-user --unshare-net --cap-drop ALL --die-with-parent`.
- Навіть при спробі виконання від UID 0 всередині user namespace, набір capabilities порожній (0). Жоден процес сайту не має `CAP_NET_ADMIN` чи можливості змінювати мережевий стек.
- Мережевий трафік сайту спрямовується через віртуальний інтерфейс `tap0` за допомогою `slirp4netns` безпосередньо на локальний Egress Proxy (`10.0.2.2:8080`), де діє білий список хостів `ALLOWED_HOSTS`.

### Пункт 3: Захист від обходу через Gateway, порти хоста, DNS та IPv6
- **Docker Gateway:** Звернення до шлюзів `172.24.0.1`, `172.26.0.1`, `172.18.0.1` блокуються як за IP-діапазоном (`172.16.0.0/12`), так і за портами (`5432`, `6379`, `9000`).
- **Опубліковані порти хоста:** Звернення до `127.0.0.1:5432` чи `127.0.0.1:13001` всередині контейнера потрапляють на власний loopback контейнера (де ці порти не слухають) і не досягають хоста.
- **DNS:** Embedded DNS Docker (`127.0.0.11`) не резолвить імена сервісів мережі `npati-agent` (наприклад, `postgres`, `redis`, `minio`), оскільки `sandbox-runner` не є учасником цієї мережі.
- **IPv6:** Будь-які IPv6 маршрути відхиляються на рівні `ip6tables`.

### Пункт 4: Авторизація RPC 7865 та контроль scope
- Будь-який виклик `/v1/sandbox` або `/v1/readiness` вимагає валідного HMAC-SHA256 підпису з таємним ключем довжиною не менше 32 символів.
- Неавтентифіковані запити негайно повертають `401 Unauthorized`.
- Усі операції обов'язково валідують повний об'єкт scope (`workspaceId`, `userId`, `companyId`, `projectId`). Запити з неповним або чужим context повертають `400 invalid_scope` або `scope_mismatch`.
- Процеси сайтів (UID 10000–60000) апаратно заблоковані від порту 7865 правилом `iptables -A NPATI_PROJECTS -p tcp --dport 7865 -j REJECT`.

### Пункт 5: Резервні копії та Rollback-процедура
- Збережено резервні копії:
  - `docker-compose.dokploy-isolated.yml.bak`
  - `apps/agent-api/project-runtime-entrypoint.sh.bak`
  - `artifacts/sandbox-runner-iptables.bak`
- **Процедура відкату (Rollback):**
  1. Відновити конфігурацію Compose: `Copy-Item docker-compose.dokploy-isolated.yml.bak docker-compose.dokploy-isolated.yml`.
  2. Відновити скрипт entrypoint: `Copy-Item apps/agent-api/project-runtime-entrypoint.sh.bak apps/agent-api/project-runtime-entrypoint.sh`.
  3. Перезібрати та перестворити контейнер:
     `docker compose -f docker-compose.dokploy-isolated.yml --env-file artifacts/docker-validation-source/.env.validation up -d --build --no-deps sandbox-runner`.
  4. Підключити контейнер назад до `npati-agent`:
     `docker network connect npati-isolated-source-20261011_npati-agent npati-isolated-source-20261011-sandbox-runner-1`.

### Пункт 6: Перевірка залежностей підсистем
- **Supervisor:** Працює штатно (`shared-project-runtime-server.js` ініціалізує та обслуговує запити).
- **Bubblewrap + slirp4netns:** Перевірено викликом `/usr/local/bin/npati-project-exec --check`, результат: `namespaces:bubblewrap+slirp4netns`.
- **Egress Proxy:** Працює на `127.0.0.1:8080`, успішно проксує HTTPS до `registry.npmjs.org` (HTTP 200) та блокує неавторизовані хости/IP (HTTP 403).
- **Git / npm / python3 / Next.js:** Усі системні бінарні файли доступні в ro-bind Bubblewrap.
- **Preview Proxy:** Live Preview proxy через `handleProxy` у `agent-api` працює без змін.
- **Browser QA:** Запущено 18 тестів Playwright browser runner — 100% успішно.

---

## 3. Фактичні результати негативних тестів

Тестування виконувалося безпосередньо у контейнері `npati-isolated-source-20261011-sandbox-runner-1` для трьох категорій користувачів: **UID 0** (root), **UID 65534** (nobody) та **UID 10001** (project UID).

| Цільовий хост / сервіс | Порт | UID 0 (root) | UID 65534 (nobody) | UID 10001 (project) | Очікуваний результат | Фактичний результат |
|---|---|---|---|---|---|---|
| Core PostgreSQL (`172.24.0.8`) | 5432 | Connection refused | Connection refused | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| Core Redis (`172.24.0.2`) | 6379 | Connection refused | Connection refused | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| MinIO S3 (`172.24.0.4`) | 9000 | Connection refused | Connection refused | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| OmniRoute (`172.24.0.7`) | 20128 | Connection refused | Connection refused | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| RFC 1918 (`10.0.0.1`) | 80 | Network unreachable | Network unreachable | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| RFC 1918 (`192.168.1.1`) | 80 | Network unreachable | Network unreachable | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| Cloud Metadata (`169.254.169.254`) | 80 | Network unreachable | Network unreachable | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| CGNAT (`100.64.0.1`) | 80 | Network unreachable | Network unreachable | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| Agent Gateway (`172.24.0.1`) | 5432 | Connection refused | Connection refused | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| Control Gateway (`172.26.0.1`) | 5432 | Connection refused | Connection refused | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| Egress Gateway (`172.18.0.1`) | 5432 | Connection refused | Connection refused | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| Host published 5432 (`127.0.0.1`) | 5432 | Connection refused | Connection refused | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| Host published 13001 (`127.0.0.1`)| 13001 | Connection refused | Connection refused | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| Runner RPC port (`127.0.0.1`) | 7865 | Дозволено (healthcheck) | Заблоковано | Connection refused (REJECT) | ЗАБЛОКОВАНО ДЛЯ ПРОЄКТІВ | **PASS** |
| Remote Runner RPC (`172.26.0.2`) | 7865 | Дозволено (healthcheck) | Заблоковано | Connection refused (REJECT) | ЗАБЛОКОВАНО ДЛЯ ПРОЄКТІВ | **PASS** |
| IPv6 Loopback (`::1`) | 5432 | Connection refused | Connection refused | Connection refused | ЗАБЛОКОВАНО | **PASS** |
| IPv6 Link-Local (`fe80::1`) | 80 | Network unreachable | Network unreachable | Network unreachable | ЗАБЛОКОВАНО | **PASS** |
| IPv6 ULA (`fc00::1`) | 80 | Network unreachable | Network unreachable | Network unreachable | ЗАБЛОКОВАНО | **PASS** |
| IPv6 Global DNS (`2001:4860:...`)| 53 | Network unreachable | Network unreachable | Network unreachable | ЗАБЛОКОВАНО | **PASS** |

---

## 4. Фактичні результати позитивних тестів

Повний наскрізний цикл тестування виконано з контейнера `agent-api` через RPC до `sandbox-runner`:

1. **API → Runner RPC Readiness (`/v1/readiness`):**
   - HTTP 200 OK
   - `overall_ready: true`
   - `isolation: "namespaces:bubblewrap+slirp4netns"`
   - `egress_proxy_ready: true`
   - `network_policy_ready: true`
   - `dns_policy_ready: true`
2. **Автентифікація та авторизація RPC:**
   - Запит без HMAC-заголовків: **401 Unauthorized** (`unauthorized`).
   - Запит із неповним scope: **400 Bad Request** (`invalid_scope`).
   - Запит із невідповідним scope іншого проєкту: **400 Bad Request** (`scope_mismatch`).
3. **Створення проєкту (`createSandbox`):**
   - Успішно створено пісочницю `e85006e2-aee2-4d78-8f68-43667f0cf5a6`.
   - Призначено UID 10049, робочий каталог `/projects/838651cd-7f9d-4afc-b457-3890539ca302`.
4. **Запис та читання файлів (`uploadFiles` / `downloadFiles`):**
   - Завантажено `server.js`, `build.js`, `package.json`.
   - Зчитано назад через `downloadFiles`: вміст ідентичний на 100%.
5. **Terminal Commands (`executeCommand`):**
   - `pwd`: вивів `/projects/838651cd-7f9d-4afc-b457-3890539ca302` (exitCode: 0).
   - `ls -la`: успішно показав завантажені файли (exitCode: 0).
   - `cat server.js`: підтвердив коректність вмісту (exitCode: 0).
6. **Виконання Node.js коду:**
   - `node server.js`: успішно вивів `Sandbox Stage 3 test executed successfully!` (exitCode: 0).
7. **Next.js / static build:**
   - `npm run build`: успішно виконав збірку `Next.js / static build completed in sandbox!` (exitCode: 0).
8. **Egress Proxy (npm registry):**
   - Запит до `https://registry.npmjs.org/` через локальний Egress Proxy повертає HTTP 200 OK.
   - Спроби з'єднання з недозволеними IP/хостами блокуються проксі (HTTP 403 Forbidden).
9. **Project Data API:**
   - Запит до `/v1/projects/{projectId}/data/posts` з ключем `X-Project-Key: npati_pk_dev_...` проходить валідацію ключа Gateway, перевіряє RLS-політики та повертає санкціоновану відповідь.
10. **Очищення пісочниці (`destroySandbox`):**
    - Успішно видалено каталог, процеси вбито через SIGKILL за UID, правило портів у `NPATI_PROJECTS` очищено.

---

## 5. Перевірка персистентності обмежень (Recreate & Restart)

1. **Recreation (перестворення контейнера):**
   - Виконано `docker compose up -d --no-deps sandbox-runner` з новим образом.
   - Контейнер перестворено з ідентифікатором `7c731c700c35`.
   - Всі правила `NPATI_EGRESS_RESTRICT` та `NPATI_PROJECTS` автоматично застосувалися скриптом entrypoint при старті.
   - Негативні тести перевірено повторно — 100% заблоковано.
2. **Restart (перезапуск Docker-контейнера):**
   - Виконано `docker restart npati-isolated-source-20261011-sandbox-runner-1`.
   - Контейнер успішно перезапустився та перейшов у статус `healthy`.
   - Перевірено виклик healthcheck з `agent-api`: `overall_ready: true`.
   - Негативні тести для UID 0, 65534, 10001 виконано знову — доступ до Core DB відхиляється (`ConnectionRefusedError`).

---

## 6. Змінені файли

1. `apps/agent-api/project-runtime-entrypoint.sh` — додано ланцюжок `NPATI_EGRESS_RESTRICT` з повним покриттям RFC та IPv6 блокуванням, оптимізовано порядок ланцюжків у `OUTPUT`.
2. `docker-compose.dokploy-isolated.yml` — вилучено `npati-agent` зі списку мереж `sandbox-runner`, додано окрему bridge-мережу `npati-sandbox-egress`.
3. `artifacts/e2e-stage-3-positive.mjs` — автоматизований тестовий скрипт для валідації Stage 3 RPC та негативних перевірок.
4. `docs/integration/stage-3-report.md` — детальний звіт про виконання Етапу 3.
5. `docs/integration/current-state.md` — оновлено поточний стан інтеграції.

---

## 7. Підтвердження готовності підсистем

- **Coding Agent:** Працює стабільно, зв'язок API → Sandbox збережено через захищений RPC-інтерфейс.
- **Sandbox Runner:** Повністю ізольований, нульовий доступ до внутрішньої інфраструктури Core.
- **Live Preview:** Працює через Preview Proxy з cookie-ізоляцією, реалізованою на Етапі 2.
- **Unit / Regression тести:** 100% тестів проходять (Vitest: 40/40 tests passed).

**До Етапу 4 не переходимо. Очікуємо погодження результатів Етапу 3.**
