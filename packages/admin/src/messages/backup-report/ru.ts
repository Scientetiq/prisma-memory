import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import { formatCount } from "../../i18n/format";
import { pluralRu } from "../../i18n/core";
const daysText = (n: number): string => `${formatCount(n)} ${pluralRu(n, ["день", "дня", "дней"])}`;
const daysGen = (n: number): string => `${formatCount(n)} ${pluralRu(n, ["дня", "дней", "дней"])}`;
const copiesText = (n: number): string => `${formatCount(n)} ${pluralRu(n, ["копия", "копии", "копий"])}`;

export const backupText: Messages<typeof en.backupText> = {
  retention: (days: number): string => `Копии баз на сервере хранятся ${daysText(days)}, потом удаляются; три последние годные копии не удаляются никогда. Срок меняется в настройках, раздел «Хранилище» («Сколько дней хранить резервные копии на сервере»).`,
  pruneSummary: (at: string, by: string, copies: number, retention: number, removed: number, freed: string, kept: number, consistent: number, nothing: boolean): string => { const head = `Последняя чистка — ${at}, ${BY_TEXT[by] ?? BY_TEXT.manual}: было ${copiesText(copies)}`;
    return nothing ? `${head}, ничего не удалено.` : removed ? `${head}, удалено ${formatCount(removed)} старше ${daysGen(retention)} (освобождено ${freed}), осталось ${formatCount(kept)}, годных из них — ${formatCount(consistent)}.` : `${head}, копий старше ${daysGen(retention)} не нашлось — ничего не удалено. Годных копий — ${formatCount(consistent)}.`; },
  noFresh: (retention: number): string => `Моложе ${daysGen(retention)} нет ни одной годной копии — похоже, копии перестали получаться. Старые копии поэтому не удаляются, чтобы сервер не остался без копий. Снимите свежую копию и проверьте, что она годна, — следующая чистка удалит старое сама.`,
  unverified: (count: number): string => `Из оставшихся копий без описи содержимого — ${formatCount(count)}: ${count === 1 ? "она снята" : "они сняты"} прежним способом и не ${count === 1 ? "проверена" : "проверены"}. Годными такие копии считаются, только пока на сервере нет ни одной проверенной.`,
  waiting: (count: number, bytes: string): string => `${copiesText(count)} без описи старше срока (${bytes}) ${count === 1 ? "ждёт" : "ждут"} трёх проверенных копий новее себя и ${count === 1 ? "удалится сама" : "удалятся сами"}: ночные копии снимаются уже с описью, обычно это около трёх ночей.`,
  oldestOverdue: (days: number): string => `Самой старой копии на сервере ${daysText(days)} — дольше срока хранения. Она держится как одна из трёх последних годных копий, по отметке «держать» или как копия без описи, ждущая трёх проверенных; удалённое людьми остаётся в ней, пока не появятся свежие годные копии или пока отметку не снимут.`,
  oldest: (days: number): string => `Самой старой копии на сервере ${daysText(days)}.`,
  stale: (freshDays: number, age: number | null): string => `Нет годной копии моложе ${daysGen(freshDays)}${age === null ? " — годных копий на сервере нет совсем" : ` — самой свежей ${daysText(age)}`}. Снимите копию.`,
  unknownCount: (count: number): string => `У ${formatCount(count)} ${pluralRu(count, ["копии", "копий", "копий"])} возраст не известен — чистка ${count === 1 ? "её" : "их"} не трогает. Решите вручную, ${count === 1 ? "нужна ли она" : "нужны ли они"}.`,
  failedCount: (count: number): string => `Не удалось удалить ${copiesText(count)} — ${count === 1 ? "она по-прежнему занимает" : "они по-прежнему занимают"} место. Проверьте на сервере права на каталог копий.`,
  unreadableCount: (count: number): string => `В каталоге копий не прочитать ${formatCount(count)} ${pluralRu(count, ["запись", "записи", "записей"])} — чистка ${count === 1 ? "её" : "их"} не трогает, и план чистки неполный. Проверьте на сервере права на каталог копий и диск, по регламенту.`,
  markedCount: (count: number): string => `${copiesText(count)} ${count === 1 ? "помечена" : "помечены"} «держать» — чистка ${count === 1 ? "её" : "их"} не удаляет. Снимите отметку, когда копия станет не нужна.`,
  skippedOverdue: (count: number, retention: number): string => `Из не тронутых чисткой ${copiesText(count)} ${count === 1 ? "лежит" : "лежат"} дольше ${daysGen(retention)} — в ${count === 1 ? "ней" : "них"} остаётся удалённое людьми. Удалите ${count === 1 ? "её" : "их"} на сервере вручную, по регламенту.`,
  migrationOverdue: (retention: number): string => `Следы переезда баз на новую установку лежат дольше ${daysGen(retention)}. В них полная копия баз открытым текстом — удалите их вручную после сверки переезда, по регламенту.`,
  dailyFailed: (at: string, reason: string): string => `Ночная копия ${at} ${DAILY_SKIP[reason] ?? DAILY_SKIP.dump_failed}. Копию нужно снять заново.`,
  todayAt: (value1: string | number): string => `сегодня в ${value1}`,
  yesterdayAt: (value1: string | number): string => `вчера в ${value1}`,
  at: (value1: string | number, value2: string | number): string => `${value1} в ${value2}`,
  couldNotReadBackupInformationOpenThe: "Сведения о резервных копиях сейчас не прочитались — откройте отчёт позже.",
  oldBackupsHaveNotBeenPrunedYet: "Чистка старых копий ещё не запускалась. Она идёт после каждой копии, при выкладке и раз в сутки ночью.",
  theBackupRetentionPeriodInTheDatabase: "Срок хранения копий в базе не задан или задан неверно, поэтому старые копии не удаляются. Задайте его заново в настройках, раздел «Хранилище».",
  backupPruningIsHeldByAMarker: "Чистка старых копий придержана отметкой на сервере — пока её не снимут, ничего не удаляется. Так бывает при первой чистке на установке (выкладка, копия, ночь или человек — пока нет state/backup-prune.reviewed) или на время восстановления: посмотрите план чистки, решите по копиям без возраста и снимите отметку по регламенту.",
  pruningHasNotRunForOverTwo: "Чистка не запускалась больше двух суток — похоже, ночное расписание на сервере не работает. Проверьте его по регламенту.",
  latestValidBackup: (value1: string | number): string => `Самая свежая годная копия — ${value1}.`,
  leftUntouchedLinksBackupsOwnedBySomeone: (value1: string | number): string => `Не тронуто ${value1}: ссылки, копии другого владельца и копии службы резервного копирования — их эта чистка не удаляет.`,
  databaseMigrationLeftoversRemainOnTheServer: "На сервере ещё лежат следы переезда баз на новую установку — их удаляют вручную после сверки, чистка их не трогает.",
  nightlyBackupCreated: (value1: string | number): string => `Ночная копия снята ${value1}.`,
  theNightlyBackupIsUnencryptedNoBackup: "Ночная копия не зашифрована: на сервере не задан ключ шифрования копий. Её прочтёт любой, у кого есть доступ к диску сервера или к его снимкам. Задайте ключ по регламенту.",
  noNightlyBackupHasBeenCreatedFor: "Ночная копия не снималась больше двух суток — проверьте ночное расписание на сервере.",
  noNightlyBackupHasBeenCreatedYet: "Ночная копия ещё не снималась. Включено ли ночное расписание, сервер не сообщил — если к утру копии не будет, проверьте его по регламенту.",
  unknownAge: "Возраст не известен",
  couldNotDelete: "Не удалось удалить",
  unreadable: "Не читается",
  markedKeep: "Помечены «держать»",
  awaitingThreeVerifiedBackups: "Ждут трёх проверенных",
  untouched: "Не тронуто",
};

export const BY_TEXT: Messages<typeof en.BY_TEXT> = { "db-dump": "сразу после снятия копии", deploy: "при выкладке", daily: "ночью по расписанию", manual: "вручную" };

export const TIMER_OFF: Messages<typeof en.TIMER_OFF> = {
  disabled: "Ночное расписание копий на сервере выключено — ночной копии и ночной чистки нет. Включите его по регламенту (следующая выкладка включит его и сама).",
  missing: "Ночное расписание копий на сервере не поставлено — ночной копии и ночной чистки нет. Его ставит выкладка; проверьте её вывод по регламенту.",
};

export const DAILY_SKIP: Messages<typeof en.DAILY_SKIP> = {
  deploy_busy: "не снималась: выкладка шла дольше часа",
  disk_low: "не снималась: места на диске не хватило бы — освободите место на сервере",
  dump_failed: "не получилась — причина в журнале сервера",
};
