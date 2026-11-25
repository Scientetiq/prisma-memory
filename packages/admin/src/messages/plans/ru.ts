import { pluralRu } from "../../i18n/core";
import type { PlanOp, PlanSummary, PlanApplyResult } from "../../lib/types";
// Original Russian messages for this area.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const PLAN_OP_TITLES: Messages<typeof en.PLAN_OP_TITLES> = {
    delete: "Удалить в корзину", close: "Скрыть от агентов", promote: "Перенести записи",
    move_space: "Перенести между пространствами", purge: "Удалить навсегда",
    correct_bulk: "Исправить исполнителя в событиях встречи",
    open: "Show to agents",
} as const;
export const PLAN_STATUS_TITLES: Messages<typeof en.PLAN_STATUS_TITLES> = {
    pending: "Ждёт решения", applying: "Применяется", applied: "Применён", partially_applied: "Применён частично",
    expired: "Срок истёк", cancelled: "Отменён",
} as const;
export const PLAN_ITEM_TITLES: Messages<typeof en.PLAN_ITEM_TITLES> = { pending: "В списке", excluded: "Убрана из списка", done: "Применено", skipped: "Пропущено" } as const;
export const PLAN_ITEM_BUTTONS: Messages<typeof en.PLAN_ITEM_BUTTONS> = { exclude: "Не трогать", include: "Вернуть в список" } as const;
export const PLAN_REASON_TITLES: Messages<typeof en.PLAN_REASON_TITLES> = {
    changed: "Запись изменилась после того, как вы увидели список, — её не тронули", no_rights: "У вас больше нет прав на эту запись", gone: "Запись больше недоступна",
    in_progress: "Запись сейчас переносится — повторите позже", open_check: "В записи есть то, что нельзя показывать агентам, например телефон",
    never_open: "Такие записи никогда не открывают агентам — правило администратора", expired: "Не успели до конца срока плана",
    failed: "Не получилось — попросите агента составить новый план",
    archived: "Пространство в архиве", not_found: "Запись недоступна", derived: "Идёт вместе с исходной записью",
    already_deleted: "Уже в корзине", same_space: "Уже в этом пространстве", not_current: "Это прежняя версия записи",
    not_applicable: "Карточку сотрудника заполняет справочник — её не переносят",
    extended_open: "Агент, который читает закрытое, не меняет записи для агентов без разрешения администратора памяти",
    derived_wider: "Пересказ увидели бы те, кто не видит его источники — переносите кнопкой «Перенести» на странице записи",
};
export const PLAN_APPLY_REASONS: Messages<typeof en.PLAN_APPLY_REASONS> = {
    over_threshold: "Записей много — такой список подтверждаете вы сами", many_spaces: "Записи из нескольких пространств — такой список подтверждаете вы сами",
    workplace_only_op: "Удаление навсегда подтверждаете только вы", created_in_workplace: "Список составлен здесь, в рабочем месте",
    script_key: "Список составила программа-скрипт — подтверждаете вы", preview_key: "Список составлен в предпросмотре",
};
export const PLANS_MORE: Messages<typeof en.PLANS_MORE> = [
    "Небольшой список в одном пространстве (обычно до 20 записей) агент может применить сам, но только после вашего «да» в разговоре.",
    "Большой список, записи из нескольких пространств, удаление навсегда и списки, которые вы составили сами, применяете только вы — на этой странице.",
    "Применяется ровно сохранённый список: новые записи в него не попадут, а изменившуюся после показа запись не тронут.",
] as const;
export const PLANS_EMPTY: Messages<typeof en.PLANS_EMPTY> = {
    pending: "Сейчас ничего не ждёт вашего решения.",
    all: "Планов пока нет.",
    steps: [
        "Агент предлагает: в разговоре попросите его изменить сразу много записей.",
        "Вы смотрите список: что именно изменится у каждой записи.",
        "Подтверждаете или отменяете. Без вашего решения ничего не меняется.",
    ],
    example: "«Найди мои заметки о пилоте за сентябрь и предложи удалить их в корзину»",
} as const;
export const PLAN_ITEM_CORRECTION: Messages<typeof en.PLAN_ITEM_CORRECTION> = { applied: "исправлено", proposed: "отправлено на подтверждение" } as const;
export const PLAN_REASON_CORRECT_BULK: Messages<typeof en.PLAN_REASON_CORRECT_BULK> = {
    not_applicable: "В событии нет такого исполнителя",
    failed: "Не получилось — составьте план заново на странице встречи",
};
export const PLANS_MESSAGES: Messages<typeof en.PLANS_MESSAGES> = {
    plansLead: "Сюда агент присылает список изменений сразу многих записей: посмотрите, что изменится, и решите.",
    planDueTitle: "Решить до",
    planPageTitle: "План массового изменения",
    planPurgeConfirm: "Восстановить будет нельзя",
    planCorrectProposeNotice: "Если вы не участник встречи и не владелец её пространства, по каждому событию уйдёт предложение её участникам, а не исправление.",
    planEmptyApply: "Закрыть план без изменений",
    planEmptyApplyHint: "Все записи убраны из списка: план закроется, ни одна запись не изменится.",
    thisPlanIsUnavailable: "Этого плана нет",
    aWeekHasPassedSince: "Прошла неделя после срока, ссылка не ваша или адрес неверный. Попросите агента составить новый.",
    onlyYouCanConfirmCorrections: "Исправление многих событий подтверждаете вы",
    sentForConfirmation: "Отправлено на подтверждение",
    youInTheWorkspace: "Вы в рабочем месте",
    yourAgentKeyNoLonger: "Ваш агент (ключ больше недоступен)",
    count: (op: PlanOp, n: number): string => `${n} ${pluralRu(n, op === "correct_bulk" ? ["событие", "события", "событий"] : ["запись", "записи", "записей"])}`,
    title: (op: PlanOp, n: number, target: PlanSummary["target"]): string => { const into = !target ? "" : target.kind === "personal" ? " в личное" : ` в «${target.name}»`; const head = op === "promote" && target?.kind === "personal" ? "Вернуть в личное" : `${PLAN_OP_TITLES[op]}${op === "promote" || op === "move_space" ? into : ""}`; return `${head} · ${`${n} ${pluralRu(n, op === "correct_bulk" ? ["событие", "события", "событий"] : ["запись", "записи", "записей"])}`}`; },
    applyLabel: (op: PlanOp, n: number, continuing: boolean, target: PlanSummary["target"]): string => {
        const count = `${n} ${pluralRu(n, op === "correct_bulk" ? ["событие", "события", "событий"] : ["запись", "записи", "записей"])}`;
        if (continuing)
            return `Продолжить: осталось ${count}`;
        if (!n)
            return "Закрыть план без изменений";
        const into = !target ? "" : target.kind === "personal" ? " в личное" : ` в «${target.name}»`;
        switch (op) {
            case "delete": return `Удалить в корзину ${count}`;
            case "close": return `Скрыть от агентов ${count}`;
            case "purge": return `Удалить навсегда ${count}`;
            case "correct_bulk": return `Исправить исполнителя в ${n} ${pluralRu(n, ["событии", "событиях", "событиях"])}`;
            case "promote": return target?.kind === "personal" ? `Вернуть в личное ${count}` : `Перенести ${count}${into}`;
            case "move_space": return `Перенести ${count}${into}`;
            case "open": return `Show ${count} to agents`;
        }
    },
    progress: (r: Pick<PlanApplyResult, "status" | "done" | "skipped" | "excluded" | "remaining">): string => `${r.status === "applying" ? "Применение продолжается" : "Готово"}: применено ${r.done}, пропущено ${r.skipped}, не тронуто по вашему выбору ${r.excluded}${r.remaining ? `, осталось ${r.remaining}` : ""}`,
    sharedMoveReason: "Sharing a record with a team, a project or the whole company is confirmed by you, not by an agent",
    confirmation: (one: boolean, name: string | null): string => { const where = name ? `«${name}»` : "a shared space"; return `Your agent asks to move ${one ? "this record" : "these records"} to ${where} — everyone there will be able to read ${one ? "it" : "them"}. Nothing moves until you press Apply.`; },
};
