Я створюю новий open source проект **NPATI Agent**.

Локальна папка проекту:

`NPATI Agent`

Технічні назви package/repository/container повинні використовувати формат:

`npati-agent`

Проект поки що розробляється **тільки локально**.

Не потрібно нічого публікувати в GitHub, не потрібно deploy у production.

Усе повинно запускатися і тестуватися локально через **Docker Desktop**.

## Основна концепція

NPATI Agent це open source AI business agent, який у майбутньому повинен допомагати користувачам:

1. продавати товари;
2. запускати бізнес;
3. розвивати існуючий бізнес;
4. оптимізувати бізнес;
5. створювати маркетингову стратегію;
6. створювати listings;
7. створювати контент;
8. створювати SEO статті;
9. створювати та планувати публікації;
10. рекомендувати канали продажів;
11. працювати з NPATI Hub;
12. працювати з WordPress через NPATI;
13. у майбутньому працювати з Etsy, eBay, Amazon, Shopify, WooCommerce та іншими сервісами;
14. мати довготривалу пам'ять про бізнес користувача;
15. аналізувати результати та рекомендувати наступні дії.

Для AI infrastructure використовується:

https://github.com/diegosouzapw/OmniRoute

OmniRoute повинен використовуватися як **AI engine**, а не як основний продукт для користувача.

Користувач повинен бачити тільки бренд та інтерфейс **NPATI Agent**.

---

# КРИТИЧНО ВАЖЛИВА АРХІТЕКТУРНА ВИМОГА

Не переписувати OmniRoute.

Не змішувати бізнес логіку NPATI із source code OmniRoute.

Не робити сотні змін у файлах OmniRoute.

Не змінювати OmniRoute UI для створення NPATI UI.

NPATI повинен мати власний frontend.

OmniRoute має працювати як внутрішній engine/service.

Потрібно максимально ізолювати OmniRoute, щоб у майбутньому можна було легко перейти, наприклад:

`OmniRoute 3.x → 3.y → 4.x`

без переписування NPATI Agent.

---

# Архітектура

Побудувати monorepo приблизно такого типу:

```text
NPATI Agent/
│
├── apps/
│   │
│   ├── web/
│   │   └── NPATI Agent frontend
│   │
│   └── agent-api/
│       └── NPATI Agent backend/API
│
├── packages/
│   │
│   ├── agent/
│   │   └── головна логіка NPATI Agent
│   │
│   ├── business-brain/
│   │   └── бізнес логіка, planning, goals, recommendations
│   │
│   ├── memory/
│   │   └── NPATI Business Memory abstraction
│   │
│   ├── skills/
│   │   └── NPATI Skills
│   │
│   ├── branding/
│   │   └── NPATI branding, theme, logo configuration
│   │
│   ├── omniroute-adapter/
│   │   └── єдина точка взаємодії NPATI з OmniRoute
│   │
│   ├── hub-connector/
│   │   └── єдина точка взаємодії з NPATI Hub
│   │
│   └── shared/
│       └── shared types, schemas, utilities
│
├── vendor/
│   └── omniroute/
│       └── upstream OmniRoute source
│
├── docker/
│
├── docs/
│
├── scripts/
│
├── tests/
│
├── .env.example
├── docker-compose.yml
├── README.md
└── THIRD_PARTY_NOTICES.md
```

Це орієнтовна структура.

Якщо поточна архітектура OmniRoute вимагає невеликої адаптації структури, можна її зробити, але **не порушувати принцип ізоляції**.

---

# OmniRoute integration

OmniRoute повинен знаходитися:

`vendor/omniroute`

Бажано підключити його як Git submodule або іншим чистим способом, який дозволяє:

1. бачити конкретну версію OmniRoute;
2. оновлювати її окремо;
3. не змішувати Git history NPATI та OmniRoute;
4. легко робити upgrade;
5. легко робити rollback.

Не використовувати випадковий latest commit.

OmniRoute потрібно pin до конкретної stable release/tag.

Додати файл, наприклад:

`OMNIROUTE_VERSION`

або інший централізований механізм, де буде видно поточну базову версію.

Наприклад:

```text
OMNIROUTE_VERSION=vX.Y.Z
```

---

# OmniRoute Adapter

Створити:

`packages/omniroute-adapter`

Це дуже важливий шар.

NPATI Agent, Business Brain, UI та Skills не повинні напряму залежати від внутрішніх файлів OmniRoute.

Правильна схема:

```text
NPATI Agent
     ↓
OmniRoute Adapter
     ↓
OmniRoute
```

Неправильно:

```text
Business Brain
     ↓
../../vendor/omniroute/src/internal/something
```

Не робити таких dependency.

Якщо структура OmniRoute зміниться, ми повинні змінити переважно:

`packages/omniroute-adapter`

а не весь NPATI Agent.

Створити початковий interface, наприклад:

```text
AIEngine
```

з майбутніми можливостями:

```text
chat()
stream()
listModels()
getModel()
executeTool()
searchMemory()
saveMemory()
getCapabilities()
healthCheck()
```

На цьому етапі методи можуть бути мінімальними або частково stub, якщо повна інтеграція ще не потрібна.

Не потрібно зараз реалізовувати весь OmniRoute API.

---

# NPATI Hub Connector

Створити:

`packages/hub-connector`

Схема:

```text
NPATI Agent
     ↓
Hub Connector
     ↓
NPATI Hub
```

Agent не повинен містити HTTP endpoints NPATI Hub у своїй business logic.

Hub Connector у майбутньому відповідатиме за:

```text
social channels
scheduled posts
social publishing
WordPress
NPATI listings
connected integrations
media
marketplace connections
analytics
```

Створити abstraction/interface.

Наприклад:

```text
HubClient

getConnections()
getCapabilities()
createSocialDraft()
scheduleSocialPost()
createListing()
createWordPressDraft()
publishWordPressPost()
healthCheck()
```

На першому етапі не потрібно реалізовувати всі функції.

Головне зараз правильно створити boundary.

---

# NPATI Agent

Створити:

`packages/agent`

Це orchestration layer.

Agent повинен у майбутньому отримувати:

```text
User message
+
Business Memory
+
Business Brain
+
Skills
+
Available integrations
+
OmniRoute AI
```

і вирішувати:

```text
understand
→ plan
→ recommend
→ ask for required information
→ execute tools when allowed
→ remember useful information
→ analyze result
```

Поки що створити тільки базову структуру.

Не будувати зараз складну autonomous agent систему.

---

# Business Brain

Створити:

`packages/business-brain`

Цей модуль не повинен залежати від UI.

У майбутньому тут будуть:

```text
business profile
business goals
business assessment
business health
recommendations
business planning
channel recommendations
marketplace recommendations
content strategy
growth strategy
experiments
performance reviews
```

Закласти модульну структуру.

Наприклад:

```text
business-brain/
├── profile/
├── goals/
├── planning/
├── recommendations/
├── channels/
├── analysis/
└── types/
```

На цьому етапі реалізувати тільки мінімальний фундамент.

---

# NPATI Memory

Створити:

`packages/memory`

NPATI Memory не повинна бути жорстко прив'язана до конкретної memory implementation OmniRoute.

Потрібно створити abstraction.

Наприклад:

```text
MemoryProvider
```

з методами:

```text
remember()
search()
forget()
update()
list()
```

У майбутньому NPATI Business Memory повинна зберігати:

```text
business profile
brand information
products
customers
goals
preferences
sales channels
decisions
experiments
performance
previous recommendations
```

Не зберігати API keys, OAuth tokens або passwords у business memory.

Secrets повинні знаходитися окремо.

---

# NPATI Skills

Створити:

`packages/skills`

Підготувати структуру під skills.

Наприклад:

```text
skills/
├── business-startup/
├── business-growth/
├── business-audit/
├── sell-product/
├── listing-creator/
├── listing-optimizer/
├── seo/
├── content/
├── social-media/
├── market-research/
└── marketplace-advisor/
```

Поки що не потрібно реалізовувати всі skills.

Створити 1 простий demonstration skill, наприклад:

`business-startup`

щоб перевірити архітектуру.

---

# NPATI Branding

Створити:

`packages/branding`

Branding повинен бути централізованим.

Не hardcode назву NPATI у сотнях React components.

Наприклад:

```text
branding/
├── brand.config.ts
├── theme.css
├── types.ts
└── assets/
```

Конфіг повинен містити приблизно:

```text
name: NPATI Agent
shortName: NPATI
description: AI Business Agent
```

Дизайн:

```text
white
black
red
```

Не використовувати синій як основний brand color.

UI поки що зробити простим та чистим.

Не потрібно зараз витрачати час на складний дизайн.

---

# NPATI Web UI

Створити окремий frontend:

`apps/web`

Користувач НЕ повинен користуватися OmniRoute dashboard як основним UI.

NPATI Web повинен бути незалежним frontend.

Перший екран:

```text
NPATI Agent

Your AI Business Agent

What would you like to do?
```

Кнопки:

```text
Sell something
Start a business
Grow my business
Improve my business
Create content
Ask NPATI Agent
```

Після вибору поки що достатньо відкривати базовий Chat screen.

Створити sidebar приблизно:

```text
Chat
Business
Goals
Content
Connections
Memory
Skills
Settings
```

Поки що більшість сторінок можуть бути placeholder.

Головна задача зараз перевірити routing та architecture.

---

# Agent API

Створити backend:

`apps/agent-api`

Він буде центральною API точкою між frontend та внутрішніми модулями.

Схема:

```text
NPATI Web
     ↓
NPATI Agent API
     ↓
NPATI Agent
     ├── Business Brain
     ├── Memory
     ├── Skills
     ├── OmniRoute Adapter
     └── NPATI Hub Connector
```

Frontend не повинен напряму звертатися до OmniRoute.

Frontend не повинен напряму звертатися до NPATI Hub.

---

# Docker

Усе повинно запускатися локально через Docker Desktop.

Створити:

`docker-compose.yml`

Початкова схема контейнерів:

```text
npati-web
npati-agent-api
omniroute
```

Якщо OmniRoute потребує Redis/PostgreSQL/Qdrant або інших залежностей для базового запуску, додати тільки реально необхідні сервіси.

Не додавати зайву infrastructure "на майбутнє".

Docker Compose повинен використовувати одну internal network:

`npati-agent-network`

Назви контейнерів повинні мати префікс:

`npati-agent-*`

---

# Environment

Створити:

`.env.example`

Не записувати реальні API keys.

Приклад:

```text
NPATI_ENV=development

NPATI_AGENT_API_PORT=
NPATI_WEB_PORT=

OMNIROUTE_BASE_URL=
OMNIROUTE_API_KEY=

NPATI_HUB_BASE_URL=
NPATI_HUB_API_KEY=
```

Якщо OmniRoute потребує додаткових environment variables, додати їх.

Усі secrets тільки через environment.

---

# Health checks

Додати базові health endpoints.

Наприклад:

```text
GET /health
```

Agent API повинен показувати приблизно:

```json
{
  "status": "ok",
  "services": {
    "agent": "ok",
    "omniroute": "ok",
    "hub": "not_configured"
  }
}
```

NPATI Hub локально може бути `not_configured`, це не повинно ламати запуск NPATI Agent.

---

# Update strategy

Це критична частина.

Створити документацію:

`docs/OMNIROUTE_UPDATES.md`

Описати процес:

```text
current OmniRoute version
→ fetch new stable version
→ create update branch
→ update pinned version
→ rebuild Docker
→ run tests
→ resolve adapter incompatibilities
→ test NPATI Agent
→ merge
```

NPATI custom code повинен максимально залишатися незмінним.

Якщо upgrade OmniRoute змінює API, ми спочатку змінюємо:

`packages/omniroute-adapter`

---

# Patches

Якщо абсолютно необхідно змінити OmniRoute source code:

1. не змінювати його безпосередньо без документації;
2. створити мінімальний patch;
3. зберігати patches окремо;
4. пояснити причину кожного patch;
5. уникати UI patches;
6. уникати branding patches;
7. уникати business logic patches.

Створити при необхідності:

```text
patches/omniroute/
```

Але на першому етапі бажано мати:

```text
0 OmniRoute patches
```

---

# Third party attribution

Оскільки використовується OmniRoute, зберегти його original license та attribution.

Створити:

`THIRD_PARTY_NOTICES.md`

Не видаляти license information OmniRoute.

Не вибирати зараз остаточну license для NPATI Agent, якщо вона ще не визначена.

---

# Tests

Створити мінімальні automated tests для boundaries.

Перевірити:

1. branding config завантажується;
2. Agent API стартує;
3. web стартує;
4. OmniRoute Adapter може виконати health check;
5. Hub Connector коректно повертає `not configured`;
6. frontend може отримати `/health`;
7. Docker Compose запускається.

---

# README

Створити початковий README.

Вказати:

```text
NPATI Agent
Open Source AI Business Agent
```

Коротко пояснити архітектуру.

Додати:

```text
Architecture
Local Development
Docker
OmniRoute
Project Structure
```

Поки що не писати маркетингові обіцянки про функції, які ще не реалізовані.

---

# Чого зараз НЕ робити

Не реалізовувати:

```text
Etsy integration
eBay integration
Amazon integration
Shopify integration
full social publishing
full WordPress integration
complex autonomous planning
payments
subscriptions
multi-agent architecture
analytics engine
complex vector databases
production deployment
Kubernetes
mobile apps
```

Це буде пізніше.

Зараз головна задача:

**створити правильний фундамент NPATI Agent.**

---

# Перший milestone

Після виконання цього завдання я повинен мати можливість виконати локально:

```bash
docker compose up --build
```

Після цього:

NPATI Web відкривається в браузері.

Я бачу:

```text
NPATI Agent
Your AI Business Agent
```

Я можу відкрити Chat.

Agent API працює.

OmniRoute запускається окремим container/service.

NPATI Web не залежить від OmniRoute UI.

NPATI custom logic знаходиться поза OmniRoute source.

OmniRoute Adapter існує.

Hub Connector існує.

Memory abstraction існує.

Skills structure існує.

Business Brain structure існує.

У логах немає критичних помилок.

---

# Правила виконання

Перед написанням коду:

1. Проаналізуй структуру актуального OmniRoute repository.
2. Перевір його Docker setup.
3. Перевір package manager та framework.
4. Перевір, як найкраще запускати OmniRoute як внутрішній service.
5. Не припускай назви endpoints або environment variables, перевір їх у source.
6. Після аналізу адаптуй запропоновану структуру NPATI під реальний OmniRoute.
7. Не змінюй core OmniRoute без реальної необхідності.
8. Якщо є два варіанти реалізації, обирай той, який створює менше coupling з OmniRoute.
9. Не створюй зайвий код.
10. Не реалізовуй майбутні функції наперед.

Після завершення покажи:

1. фінальне дерево проекту;
2. які файли створено;
3. які файли OmniRoute були змінені;
4. очікуваний результат для пункту 3: `0`, якщо це можливо;
5. як запустити проект;
6. які Docker containers повинні запуститися;
7. URL локального NPATI Web;
8. URL health endpoint;
9. поточну pinned версію OmniRoute;
10. наступний логічний крок розробки.

Не переходь до наступного етапу NPATI Agent самостійно.

Заверши тільки фундамент першого milestone.