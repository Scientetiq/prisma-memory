// Descriptions of the ldap.* settings (sign-in through the company directory), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-ldap", {
  enabled: {
    en: "Sign-in to the workspace with the company account (LDAP directory, Active Directory). Switch on when the controllers, the service account, the base DN and the access group are filled in; run “Test connection” first",
    ru: "Вход в рабочее место учётной записью компании (AD). Включается, когда заполнены контроллеры, служебная учётная запись, base DN и группа доступа; «Проверить соединение» — до включения",
  },
  servers: {
    en: "Directory controllers: host names (dc1.example.com, or example.com — then every address of the name is checked) or IP addresses. The port is a separate field",
    ru: "Контроллеры каталога: имена (dc1.example.com или example.com — тогда проверяются все адреса имени) или IP-адреса. Порт — отдельным полем",
  },
  port: {
    en: "Directory port; 0 — by mode: 636 for LDAPS, 389 for StartTLS and for no encryption",
    ru: "Порт каталога; 0 — по режиму: 636 для LDAPS, 389 для StartTLS и без шифрования",
  },
  tls_mode: {
    en: "Encryption: ldaps (TLS from the first byte), starttls (TLS over 389) or none — no encryption, passwords travel in clear text (only together with insecure_ack)",
    ru: "Шифрование: ldaps (TLS с первого байта), starttls (TLS поверх 389) или none — без шифрования, пароли идут открытым текстом (только вместе с insecure_ack)",
  },
  insecure_ack: {
    en: "The administrator understands that without encryption people's passwords travel over the network in clear text. Without this mark the mode none is not saved",
    ru: "Администратор понимает, что без шифрования пароли людей идут по сети открытым текстом. Без этой отметки режим none не сохраняется",
  },
  ca_cert: {
    en: "Root certificate of the directory (PEM, a chain is fine): the controller's certificate is verified against it. Empty — the built-in root list of Node.js (a corporate CA is usually not in it)",
    ru: "Корневой сертификат каталога (PEM, можно цепочкой): им проверяется сертификат контроллера. Пусто — встроенный список корневых сертификатов Node.js (корпоративный CA в нём обычно отсутствует)",
  },
  tls_server_name: {
    en: "Name for the certificate check when the controllers are given as IP addresses (for example when the domain name does not resolve from the memory server): example.com or dc1.example.com",
    ru: "Имя для проверки сертификата, когда контроллеры заданы IP-адресами (например, если имя домена не разрешается с сервера памяти): example.com или dc1.example.com",
  },
  bind_dn: {
    en: "DN of the memory's service account in the directory (read-only): it looks the person up before the password is checked",
    ru: "DN служебной учётной записи памяти в каталоге (только чтение): ею ищется человек перед проверкой пароля",
  },
  bind_password: {
    en: "Password of the service account: stored encrypted, never returned to the panel",
    ru: "Пароль служебной учётной записи: хранится зашифрованным, в панель не возвращается",
  },
  base_dn: {
    en: "Where to look for people: DC=example,DC=com or OU=…,DC=example,DC=com",
    ru: "Где искать людей: DC=example,DC=com или OU=…,DC=example,DC=com",
  },
  user_filter: {
    en: "Search filter for a person: {account} — the short account name, {upn} — the name as typed (jsmith@example.com). The substitutions are escaped; if more than one entry is found, the sign-in is refused",
    ru: "Фильтр поиска человека: {account} — короткое имя учётной записи, {upn} — имя как введено (jsmith@example.com). Подстановки экранируются; найдено больше одной записи — вход отклоняется",
  },
  login_groups: {
    en: "Groups that give access to the memory: a DN or a name (CN). A member gets a person card at the first sign-in; without a group nobody signs in. A group gives sign-in only — roles are assigned by the administrator",
    ru: "Группы доступа к памяти: DN или имя (CN). Членам группы при первом входе создаётся карточка; без группы не входит никто. Группа даёт только вход — роли назначает администратор",
  },
  nested_groups: {
    en: "Count nested groups (the transitive membership rule of Active Directory) — only for groups given by DN. Off — direct membership (memberOf) is required",
    ru: "Учитывать вложенные группы (правило транзитивного членства AD) — только для групп, заданных DN. Выключено — нужно прямое членство (memberOf)",
  },
  domains: {
    en: "Domains allowed in the sign-in name (example.com, corp.test, EXAMPLE for EXAMPLE\\jsmith); empty — any domain, the person is found by the filter",
    ru: "Допустимые домены в имени входа (example.com, corp.test, EXAMPLE для EXAMPLE\\jsmith); пусто — любой домен, человек ищется по фильтру",
  },
  attributes: {
    en: "Names of the directory attributes: short name, e-mail (becomes the login in the memory), full name, department, groups, stable identifier (objectGUID — the link to the person card), employee number, job title (directory search), given name (how the workspace addresses the person; refreshed at every sign-in)",
    ru: "Имена атрибутов каталога: короткое имя, почта (становится логином в памяти), ФИО, подразделение, группы, устойчивый идентификатор (objectGUID — связь с карточкой), табельный номер, должность (поиск по каталогу), имя (обращение в рабочем месте; обновляется при каждом входе)",
  },
  connect_timeout_sec: {
    en: "Timeout of a connection to a controller, seconds (1–60): each address is waited for this long when availability is checked",
    ru: "Тайм-аут соединения с контроллером, секунд (1–60): столько ждётся каждый адрес при проверке доступности",
  },
  timeout_sec: {
    en: "Timeout of a directory operation (bind, search), seconds (1–120)",
    ru: "Тайм-аут операции каталога (bind, поиск), секунд (1–120)",
  },
  max_failures_per_ip: {
    en: "Failed sign-ins from one address within the last ldap.failure_window_minutes minutes after which sign-in from it is suspended (answer 429)",
    ru: "Неудачных входов с одного адреса за последние минуты окна ldap.failure_window_minutes, после которых вход с него приостанавливается (ответ 429)",
  },
  max_failures_per_login: {
    en: "Failed sign-ins in a row for one account (the count resets when ldap.failure_window_minutes have passed since the last failure) — keep it BELOW the directory's lockout threshold with a reserve for the person (the rule is in the description of the window), otherwise guessing through the memory locks the account in the domain. While the directory's threshold is unknown — 2. One account has one count, in whatever form the name is typed (short name, e-mail, name with a domain): it is counted by the directory entry found; an attempt the directory did not answer counts too; a gateway restart does not reset the count",
    ru: "Неудачных входов подряд на одну учётную запись (счёт сбрасывается, когда после последней неудачи прошло окно ldap.failure_window_minutes) — держите НИЖЕ порога блокировки AD с запасом самому человеку (правило — в описании окна), иначе перебор через память запирает учётную запись в домене. Пока порог AD не известен — 2. Одна учётная запись — один счёт, в какой бы форме ни вводили имя (короткое имя, почта, имя с доменом): считается по найденной записи каталога; попытка, на которую каталог не ответил, тоже в счёте; перезапуск шлюза счёт не обнуляет",
  },
  failure_window_minutes: {
    en: "Window of failed directory sign-ins, minutes (5–1440). Per account, failures are counted in a row, the way Active Directory counts them: the count resets when the window has passed since the last failure; per address — within the last minutes of the window. Set the window no shorter than the window after which the directory resets its bad-password counter, and the failures per account (max_failures_per_login) to at most T − R, where T is the directory's lockout threshold and R = max(2, T/3 rounded up) is the reserve of attempts for the person: threshold 5 — at most 3, threshold 10 — at most 6. While the directory's threshold and window are unknown — 2 failures and 30 minutes. Takes effect from the next attempt, without a restart; changing the window does not erase failures already recorded",
    ru: "Окно неудачных входов через каталог, минут (5–1440). На учётную запись неудачи считаются подряд, как их считает AD: счёт сбрасывается, когда после последней неудачи прошло окно; с адреса — за последние минуты окна. Ставьте окно не короче окна, после которого AD сбрасывает счётчик неверных паролей, а неудач на учётную запись (max_failures_per_login) — не больше T − R, где T — порог блокировки AD, R = max(2, T/3 с округлением вверх) — запас попыток самому человеку: порог 5 — не больше 3, порог 10 — не больше 6. Пока порог и окно AD не известны — 2 неудачи и 30 минут. Действует со следующей попытки, без перезапуска; смена окна уже записанных неудач не стирает",
  },
  group_sync_minutes: {
    en: "How often the gateway verifies the membership of directory groups bound to spaces, in minutes (0–1440): a person who joined a group becomes a member, a person who left it loses the membership. 0 — only by the button (\"Sync groups now\" in the panel, \"Refresh now\" for the owner) and at a person's sign-in; then group membership also never expires (ldap.group_stale_hours does not apply) and Readiness warns. A failed sync shows in the report and in health; membership that is not verified for ldap.group_stale_hours is removed until the directory answers",
    ru: "Как часто шлюз сверяет членство групп каталога, привязанных к пространствам, в минутах (0–1440): вошёл в группу — стал участником, вышел — участие снято. 0 — только кнопкой («Сверить группы сейчас» в панели, «Обновить сейчас» у владельца) и при входе человека; тогда и членство по группам не истекает (ldap.group_stale_hours не действует), а «Готовность» предупреждает. Сбой сверки виден в отчёте и health; членство, не подтверждённое дольше ldap.group_stale_hours, снимается, пока каталог не ответит",
  },
  group_max_members: {
    en: "Largest directory group that can be bound to a space (1–5000): a larger one is refused; a group that outgrew the limit after binding is not reconciled — its membership freezes, with a line in the morning report",
    ru: "Наибольший размер группы каталога, которую можно привязать к пространству (1–5000): больше — привязка отклоняется; группа, выросшая сверх предела после привязки, не сверяется — состав замораживается, строка в утреннем отчёте",
  },
  project_groups_base: {
    en: "Where to look for groups for spaces: the DN of a directory branch (OU=Projects,DC=example,DC=com). Empty — any group under ldap.base_dn; a group outside the branch cannot be bound",
    ru: "Где искать группы для пространств: DN ветки каталога (OU=Проекты,DC=example,DC=com). Пусто — любая группа под ldap.base_dn; группа вне ветки не привязывается",
  },
});
