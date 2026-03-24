# Настройка системы агентов для проекта Blanc Contact Center

## Статус: ✅ Подготовка завершена

Дата: 2026-03-23

---

## Обзор

Проект настроен для работы с системой агентов по следующему workflow:

**Product(01) → Architect(02) → SpecWriter(03) → TestCases(04) → Planner(05) → Implementer(06) → Tester(07) → Reviewer(08) → ProjectSpec(09)**

Все агенты работают на основе единой базы знаний:
- `Docs/requirements.md` — требования и фичи
- `Docs/architecture.md` — архитектура и модули
- `Docs/tasks.md` — активные задачи
- `Docs/changelog.md` — история изменений
- `Docs/specs/` — функциональные спецификации
- `Docs/test-cases/` — тест-кейсы
- `Docs/project-spec.md` — спецификация проекта

---

## Инструкции агентов

Все инструкции находятся в `Docs/agents/`:

1. **`agent-orchestrator.md`** — Управляет процессом (10 шагов).
2. **`agent-01-product-requirements.md`** — Product Analyst. Формализует требования.
3. **`agent-02-architect.md`** — Architect. Проектирует архитектурное решение.
4. **`agent-03-spec-writer.md`** — Spec Writer. Пишет функциональные спецификации.
5. **`agent-04-test-cases.md`** — Test Case Writer. Создаёт тест-кейсы (P0-P3).
6. **`agent-05-planner.md`** — Planner. Разбивает на атомарные задачи.
7. **`agent-06-implementer.md`** — Implementer. Пишет код.
8. **`agent-07-tester.md`** — Tester. Пишет тесты (Jest).
9. **`agent-08-reviewer.md`** — Reviewer. Проводит ревью.
10. **`agent-09-project-spec.md`** — Project Spec Updater. Обновляет спецификацию проекта.

---

## Правила работы

### Обязательное правило для ВСЕХ агентов:

**Перед любыми изменениями кода:**
1. Прочитать `Docs/requirements.md`
2. Прочитать `Docs/architecture.md`
3. Прочитать `Docs/tasks.md`
4. Прочитать `Docs/changelog.md`
5. **ПОТОМ** уже читать код

### Workflow выполнения задач:

```
User Request
    ↓
[1] Product Agent → формализует требования → обновляет requirements.md
    ↓
[2] Architect Agent → проектирует решение → обновляет architecture.md
    ↓
[3] Spec Writer Agent → детализирует поведение → Docs/specs/
    ↓
[4] Test Case Writer Agent → создаёт тест-кейсы → Docs/test-cases/
    ↓
[5] Planner Agent → разбивает на задачи → обновляет tasks.md
    ↓
For each task:
    [6] Implementer → пишет код
    [7] Tester → пишет тесты (Jest)
    [8] Reviewer → ревью → APPROVED / ИСПРАВЛЕНИЯ
    (если OK → следующая задача)
    ↓
[9] ⚡ Верификация плана (макс 3 итерации)
    ↓
[10] Обновление changelog.md
    ↓
[11] Project Spec Updater → обновляет project-spec.md
    ↓
[12] Итоговый отчёт
```

---

## Структура проекта

```
twilio-front-integration/
├── Docs/
│   ├── requirements.md       ← Source of truth для требований
│   ├── architecture.md       ← Source of truth для архитектуры
│   ├── tasks.md              ← Source of truth для задач
│   ├── changelog.md          ← История изменений
│   ├── project-spec.md       ← Спецификация проекта
│   ├── specs/                ← Функциональные спецификации
│   ├── test-cases/           ← Тест-кейсы
│   ├── agents/               ← Инструкции для агентов
│   └── AGENTS_SETUP.md       ← Этот файл
├── src/                      ← Backend (Express)
├── backend/                  ← Extended backend (DB, AI, cron)
├── frontend/                 ← Frontend (Vite + React + TS)
└── tests/                    ← Тесты (Jest)
```

---

## Пример запроса:
```
"Добавить push-уведомления в браузере для входящих звонков"
```
