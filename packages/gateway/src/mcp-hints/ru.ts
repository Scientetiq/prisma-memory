// Russian texts of the MCP tool refusal hints (mcp-hints.ts), used when the administrator sets locale.mcp_language to ru.
export const TOOL_HINTS_RU = {
  profile_disabled: "Скажите человеку: рабочий профиль выключил администратор памяти, записать его сейчас нельзя.",
  profile_hidden: "Скажите человеку: профиль скрыт от агентов, изменить его может только он сам, в рабочем месте.",
  profile_private_content: "Перескажите отказ человеку: такой текст в рабочий профиль не записывается.",
  open_in_progress: "Ничего не открыто: повторите тот же вызов через retry_after секунд.",
  apply_workplace_only: "Передайте человеку ссылку (workplace_url): этот план применяет только он сам, в рабочем месте.",
  apply_workplace_only_without_link: "Скажите человеку: этот план применяет только он сам, в рабочем месте (адрес рабочего места знает администратор).",
} as const;
