import { pluralRu } from "../../i18n/core";
// Original Russian messages for this area.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import type { ConfirmSpec } from "../../components/confirm-dialog";
export const TRASH_TEXT: Messages<typeof en.TRASH_TEXT> = {
    deleteConfirm: "Удалить запись? Она сразу исчезнет из поиска и чтения и попадёт в корзину: восстановить её можно, пока не истёк срок корзины (30 дней).",
};
export const PURGE_SPEC: Messages<typeof en.PURGE_SPEC> = {
    question: "Удалить запись навсегда?",
    change: "Запись, извлечённые из неё записи и исходный файл будут очищены ближайшим заданием.",
    undo: "Восстановить будет нельзя.",
    danger: true,
    ack: { name: "confirm", label: "Восстановить будет нельзя" },
};
export const TRASH_MESSAGES: Messages<typeof en.TRASH_MESSAGES> = {
    purgeConfirm: "Удалить навсегда? Запись, её производные и оригинал файла будут очищены ближайшим заданием — восстановить их будет нельзя.",
    trashHeld: "хранится, пока записи прежнего организатора хранятся",
    trashHeldNote: "Встреча перешла к вам от ушедшего сотрудника. Пока его записи хранятся, её нельзя удалить навсегда — восстановить можно.",
    trashHint: "Здесь то, что удалили вы, и то, что удалено в ваших записях или в пространствах, которыми вы владеете. Автор записи и владелец пространства равны: оба видят запись здесь, оба могут восстановить её или удалить навсегда. По истечении срока запись очищается безвозвратно вместе с оригиналом.",
    deletedRecordsAreKeptHere: "Удалённое хранится здесь до конца срока корзины — его можно вернуть.",
    personal: "Личное",
    unnamedSpace: "пространство без названия",
    deletedByYou: "Кто удалил: вы",
    spaceOwner: " (владелец пространства)",
    deletedBy: (value1: string | number, value2: string | number): string => `Кто удалил: ${value1}${value2}`,
    deletedByAnAdministratorAt: "Удалил администратор по просьбе участника встречи",
    deletedAutomatically: "Удалено автоматически",
    willBeDeletedToday: "сотрётся сегодня",
    willBeDeletedTomorrow: "сотрётся завтра",
    appliesToEveryRecordOn: (value1: string | number): string => `${value1} — так у всех записей на этой странице`,
    permanentlyDelete: (value1: string | number): string => `Удалить навсегда «${value1}»?`,
    permanentlyDeleteThisRecord: (value1: string | number, value2: string | number): string => `Удалить навсегда эту запись (${value1}, удалена ${value2})?`,
    recoveryWillBeImpossibleThe: "Вернуть будет нельзя: сотрутся сама запись, извлечённое из неё и исходный файл.",
    open: "Открыть",
    undo: "Отменить",
    recordReturnedToTrash: "Запись снова в корзине",
    itCanBeFoundIn: "Она снова находится поиском и читается.",
    itWasRestoredAsClosed: "Она вернулась закрытой: показ агентам в командах и проектах сейчас выключен администратором, поэтому агенты её не найдут.",
    itWasRestoredHiddenFrom: "Она вернулась скрытой от агентов: в ней найдено название заказчика из списка NDA (список пополнили). Люди видят её как обычно.",
    itWasRestoredHiddenFrom2: "Она вернулась скрытой от агентов: показать её агентам решал прежний организатор, а его решение к вам не переходит. Люди видят её как обычно; показать агентам можно обычной кнопкой.",
    deleteThisMeeting: "Удалить встречу?",
    youCanRestoreItFrom: "Восстановить можно из корзины, пока не истёк её срок (30 дней).",
    deleteMeeting: "Удалить встречу",
    deletedRecordsAreKeptHere2: (n: number): string => `Удалённое хранится здесь ${n} ${pluralRu(n, ["день", "дня", "дней"])} — его можно вернуть.`,
    willBeDeletedIn: (n: number): string => `сотрётся через ${n} ${pluralRu(n, ["день", "дня", "дней"])}`,
    keptFor: (n: number, normal: number, automatic: boolean): string => `Хранится ${n} ${pluralRu(n, ["день", "дня", "дней"])}, а не ${normal}: ${automatic ? "при автоматической уборке срок короче" : "такой срок задан при удалении"}`,
    appliesTo: (note: string, n: number): string => `${note} — так у ${n} ${pluralRu(n, ["записи", "записей", "записей"])} на этой странице`,
    derivedPart: (type: string, n: number): string => {
        const forms: Record<string, readonly [
            string,
            string,
            string
        ]> = { summary: ["резюме", "резюме", "резюме"], event: ["решением или задачей", "решениями и задачами", "решениями и задачами"], note: ["заметкой", "заметками", "заметками"], document: ["документом", "документами", "документами"], transcript: ["встречей", "встречами", "встречами"], profile: ["карточкой", "карточками", "карточками"] };
        const f = forms[type] ?? ["записью", "записями", "записями"];
        return n === 1 ? f[0] : `${n} ${pluralRu(n, f)}`;
    },
    derivedRecords: (n: number): string => `${n} ${pluralRu(n, ["извлечённой записью", "извлечёнными записями", "извлечёнными записями"])}`,
    derivedList: (parts: readonly string[]): string => `вместе с ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} и ${parts[parts.length - 1]}` : parts[0]}`,
    restoreDone: (title: string | null, n: number): string => `Восстановлено${title ? `: «${title}»` : ""}${n > 1 ? ` вместе с извлечёнными записями (всего ${n})` : ""}`,
    restoreWhere: (title: string | null, n: number, space: {
        name: string;
        kind: string;
    }): string => `${title ? `«${title}»` : "Запись"} снова в «${space.kind === "personal" ? "Личном" : space.name}»${n > 1 ? ` вместе с извлечёнными записями (всего ${n})` : ""}`,
    meetingChange: (summary: boolean, decisions: number): string => { const parts = ["стенограмма", ...(summary ? ["резюме"] : []), ...(decisions ? [`все решения и задачи (${decisions})`] : [])]; const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} и ${parts[parts.length - 1]}` : parts[0]; return `В корзину уйдут ${list} — всё вместе. Встреча сразу исчезнет из поиска.`; },
    meetingWho: (ps: readonly string[] | null, space: {
        name: string | null;
    } | null): string => { const names = ps ? ps.slice(0, 5).join(", ") + (ps.length > 5 ? ` и ещё ${ps.length - 5}` : "") : ""; const inSpace = space ? `все, кто видит её в пространстве${space.name ? ` «${space.name}»` : ""}` : null; return ps === null ? `Участники встречи${inSpace ? ` и ${inSpace},` : ""} сразу потеряют доступ.` : ps.length ? `Участники сразу потеряют доступ: ${names}.${inSpace ? ` И ${inSpace}.` : ""}` : inSpace ? `${inSpace[0]!.toUpperCase()}${inSpace.slice(1)}, сразу потеряют доступ.` : "Других участников у встречи нет."; },
};
