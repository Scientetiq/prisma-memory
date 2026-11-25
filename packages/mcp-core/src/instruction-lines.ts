// Instruction-like lines of record text: a heuristic that flags a line which reads like a command to an AI agent,
// so the answer can mark it "[instruction · delivered as text]" inside the data block and the structured answer can say
// "instruction_like". It is an aid, not a boundary: the boundary is the data markers, the server instructions and the
// human confirmation of destructive operations. A flagged line is still delivered whole.
//
// Five rule families, English and Russian, plus language-neutral shapes:
//   1. override phrases ("ignore all previous instructions", Russian "forget all rules", "you are now …", …);
//   2. role and control tokens at the start of a visible line (<|im_start|>, [INST], <system>, ### Instruction);
//   3. an AI addressed with an imperative (agent / assistant / model / Russian "AI" … near "delete", "send" …);
//   4. tool-directed commands and exfiltration shapes ("call memory_delete", "send … to https://", curl … | sh);
//   5. an HTML comment that carries any rule of families 1–4 (the page anchors of documents are not comments of a person).
// A line is flagged by one STRONG rule or by two different WEAK ones. Families 3 and 4 stay weak alone: documentation
// describes agents and tool calls, installation guides carry curl … | sh. Role labels ("System: Windows 11") and JSON
// tool calls are weak; zero-width, bidi and tag characters in the raw line are one more weak signal.
//
// Every rule sees the line through spaced() — the marker check's look-alike fold, with words kept apart — and is
// compiled through the same fold, so "ign\u043ere" with a Cyrillic o, "INSTRUCTI0NS" with a zero and the Russian "ignore" with a Latin o
// match. The expressions are linear: no global or sticky flags (no state between calls), no nested unbounded quantifiers,
// gaps only as bounded classes; HTML comments are found by indexOf.
//
// A line of any length is examined whole (padding a line past its first 2,000 characters once hid
// an instruction): each visible part of a line loses its format characters and has its runs of spaces collapsed, then it
// is read in windows of 2,000 code units that overlap by 200, so the time stays linear. Unicode tag characters
// (U+E0020–U+E007E, "ASCII smuggling": invisible to a person, read by a model) are read as the ASCII letters they stand
// for, and a run of eight or more of them is a strong rule of its own. The verdict names the visible parts a rule
// fired on, so the text form marks the part that holds the instruction, not the first part of the line.
import { BREAKS, fold, spaced, spacedApart } from "./skeleton.ts";

/** One window of a visible part, in code units after the spaces are collapsed. */
const WINDOW = 2000;
/** Windows overlap by this much: a phrase shorter than this is never cut in two. */
const OVERLAP = 200;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** A word or phrase as the detector sees it (folded like the text), escaped for an expression. */
const w = (s: string): string => esc(spaced(s));
const alt = (words: readonly string[]): string => `(?:${words.map(w).join("|")})`;
/** Word edges that work for every script (\b of JavaScript knows only ASCII letters). */
const L = "(?<![\\p{L}\\p{N}_])", R = "(?![\\p{L}\\p{N}_])";
/** Start of a visible line: optional spaces, list, quote and Markdown heading marks ("## System: …" is a line start). */
const START = "^[ >*•#-]{0,6}(?:\\d{1,3}[.)] ?)?";
/** After the " — " that separates the fields of a list entry ("• path — <title> — <summary>"): the title starts there. */
const AFTER_DASH = " - ";
const re = (src: string): RegExp => new RegExp(src, "u");

// ---- word lists -------------------------------------------------------------------------------------------------------

const EN_OVERRIDE = ["ignore", "disregard", "forget", "override", "bypass"];
const EN_NEG = ["not", "never", "don't", "dont", "won't", "cannot", "can't", "shouldn't", "should not", "must not", "do not"];
const EN_DET = ["all", "any", "every", "everything", "the", "your", "my", "our", "these", "those", "this", "that", "previous", "prior",
  "above", "earlier", "preceding", "former", "old", "original", "existing", "current", "initial", "system", "safety", "other", "of",
  "such", "please", "now", "just", "and"];
const EN_TARGET = ["instructions", "instruction", "rules", "prompt", "prompts", "directives", "directions", "guidelines", "guardrails",
  "restrictions", "constraints", "system message", "above", "commands", "orders", "programming", "guidance", "safeguards", "filters"];

const RU_OVERRIDE = ["игнорируй", "игнорируйте", "проигнорируй", "проигнорируйте", "забудь", "забудьте", "отбрось", "отбросьте",
  "отмени", "отмените", "не обращай внимания на", "не обращайте внимания на", "обойди", "обойдите"];
/** «Do not follow …»: only with a determiner pointing at the agent's own or earlier rules, or Russian «above» after. */
const RU_STOP = ["не следуй", "не следуйте", "не слушай", "не слушайте", "не соблюдай", "не соблюдайте", "не выполняй", "не выполняйте",
  "не подчиняйся", "не подчиняйтесь", "перестань следовать", "перестаньте следовать", "больше не следуй", "больше не следуйте"];
const RU_STOP_DET = ["свои", "своим", "твои", "твоим", "ваши", "вашим", "предыдущие", "предыдущим", "прежние", "прежним", "исходные",
  "исходным", "изначальные", "изначальным", "системные", "системным", "все", "всем", "любые", "любым", "старые", "старым", "полученные",
  "полученным", "данные", "данным", "ранее"];
const RU_DET = ["все", "всё", "любые", "предыдущие", "прежние", "прошлые", "старые", "вышеуказанные", "вышеизложенные", "указанные",
  "свои", "твои", "ваши", "эти", "те", "данные", "системные", "исходные", "изначальные", "полученные", "ранее", "пожалуйста", "что",
  "было", "сказано", "тебе", "вам", "и", "свои", "заданные", "текущие", "написано", "указано", "изложено", "говорилось", "говорили",
  "сказали", "до", "этого"];
const RU_TARGET = ["инструкции", "инструкций", "инструкциям", "указания", "указаний", "указаниям", "правила", "правил", "правилам",
  "промпт", "промпта", "ограничения", "ограничений", "ограничениям", "команды", "командам", "запреты", "выше", "установки", "раньше"];

const AI = ["ai", "assistant", "assistants", "agent", "agents", "llm", "llms", "model", "chatbot", "bot", "claude", "chatgpt", "gpt",
  "copilot", "cursor", "codex", "gemini", "ассистент", "ассистента", "ассистенту", "агент", "агента", "агенту", "агенты", "ии",
  "модель", "нейросеть", "бот"];
const EN_IMPERATIVE = ["ignore", "disregard", "forget", "delete", "remove", "send", "upload", "post", "call", "run", "execute", "reveal",
  "print", "reply", "write", "remember", "open", "promote", "forward", "share", "export", "publish", "must", "do not", "don't", "grant",
  "give", "email"];
const RU_IMPERATIVE = ["игнорируй", "игнорируйте", "забудь", "забудьте", "удали", "удалите", "отправь", "отправьте", "вызови",
  "вызовите", "выполни", "выполните", "запусти", "запустите", "покажи", "покажите", "ответь", "ответьте", "запиши", "запишите",
  "запомни", "запомните", "открой", "откройте", "не говори", "не говорите", "не сообщай", "не сообщайте", "должен", "должна",
  "обязан", "обязана", "перешли", "перешлите", "поделись", "опубликуй", "опубликуйте", "дай", "дайте", "предоставь", "предоставьте"];
const IMPERATIVE = [...EN_IMPERATIVE, ...RU_IMPERATIVE];
/** AI words that are no product names: a product before a colon or in a tool list is a documentation line. */
const AI_GENERIC = ["ai", "assistant", "agent", "llm", "model", "chatbot", "bot", "ассистент", "агент", "ии", "модель", "нейросеть", "бот"];
/** One AI addressed (a plural at the start of a line is a sentence that goes on from the line before). */
const AI_ONE = AI.filter((x) => !["assistants", "agents", "llms", "агенты"].includes(x));
const VOCATIVE = ["", "dear ", "hey ", "to the ", "note to the ", "дорогой ", "дорогая ", "эй, ", "записка для "];

/** Tools that change memory (the read tools are named in ordinary notes and documentation). */
const WRITE_TOOLS = ["remember", "delete", "promote", "open", "upload", "apply", "manage", "manage_destructive", "forget", "close",
  "correct", "plan", "space_create", "space_add_member", "space_remove_member", "meeting_upload", "process_now"];
const CALL = ["call", "run", "execute", "invoke", "use", "trigger", "вызови", "вызовите", "выполни", "выполните", "запусти", "запустите",
  "используй", "используйте"];
const SEND = ["send", "post", "upload", "forward", "transmit", "exfiltrate", "leak", "email", "отправь", "отправьте", "отправить",
  "перешли", "перешлите", "переслать", "загрузи", "загрузите", "загрузить", "выложи", "выложите", "выложить", "скопируй", "скопируйте",
  "скопировать"];
/** Ways to tell the agent to act behind the person's back. */
const STEALTH = ["silently", "quietly", "secretly", "without asking", "without confirmation", "without telling", "without waiting for",
  "never ask", "do not ask", "don't ask", "do not wait for", "don't wait for", "тихо", "незаметно", "молча", "втайне", "тайно",
  "без подтверждения", "не спрашивая", "без ведома", "не спрашивай", "не жди", "не дожидаясь"];
/** "Do not tell anyone", "do not mention this note". */
const SECRECY_EN = ["do not", "don't", "dont", "never"], SECRECY_VERB = ["tell", "mention", "reveal", "inform", "show"];
const SECRECY_WHO = ["anyone", "anybody", "them", "this note", "this line", "these lines", "this comment", "this message", "this instruction",
  "this record"];
const SECRECY_RU = ["никому не говори", "никому не говорите", "никому не сообщай", "никому не сообщайте", "никому не рассказывай",
  "никому не рассказывайте", "не говори никому", "не говорите никому", "не сообщай никому", "не сообщайте никому", "не упоминай",
  "не упоминайте"];
/** A command about the record itself. */
const SELF_VERB = ["delete", "promote", "open", "remove", "forward", "send", "share", "publish", "удали", "удалите", "повысь", "повысьте",
  "открой", "откройте", "перешли", "перешлите", "отправь", "отправьте", "опубликуй", "опубликуйте"];
const SELF_WHAT = ["this note", "this record", "this line", "this comment", "this message", "this file", "эту заметку", "эту запись",
  "эту строку", "этот комментарий", "это сообщение", "этот файл"];

/** "If you are an AI reading this", Russian "when you read this": a line speaking to its reader. */
const READER = ["if you are an ai", "if you're an ai", "if you are a language model", "whoever reads this", "whoever is reading this",
  "to whoever reads", "when you read this", "if you are reading this", "if you read this", "anyone reading this", "если ты ии",
  "если вы ии", "если ты читаешь это", "кто читает это", "кто бы это ни читал", "когда прочитаешь это", "когда прочтёшь это",
  "когда прочтешь это", "прочитав это", "прочитав эту"];
/** An AI as the one a line is addressed to: "AI agents processing this document" and its Russian form. */
const AI_READERS = ["ai", "ais", "ai agents", "ai agent", "agents", "agent", "assistants", "assistant", "llms", "llm", "models", "model",
  "bots", "агентам", "агенту", "агенты", "агент", "ассистентам", "ассистенту", "ассистент", "моделям", "модели", "модель", "ии",
  "нейросеть", "нейросетям"];
const PROCESSING = ["processing", "reading", "handling", "parsing", "summarising", "summarizing", "indexing", "обрабатывающим",
  "обрабатывающему", "обрабатывающие", "читающим", "читающему", "читающие"];
/** "ATTENTION AI:", "Note for the LLM reading this:", in Russian too. */
const ATTENTION = ["attention", "important", "note", "notice", "message", "warning", "memo", "reminder", "urgent", "внимание", "важно",
  "примечание", "записка", "сообщение", "предупреждение", "напоминание"];
/** "Delete all records", "the contents of this space", Russian "all records", "each found one". */
const SCOPE_ALL = ["all", "every", "each", "the entire", "the whole", "entire", "whole", "the contents of", "contents of", "everything in",
  "все", "всё содержимое", "содержимое", "каждую", "каждой", "каждый", "каждая", "всех", "всю", "весь"];
const SCOPE_WHAT = ["records", "record", "notes", "note", "memories", "memory", "entries", "space", "spaces", "workspace", "database",
  "записи", "записей", "запись", "заметки", "заметок", "заметку", "пространство", "пространства", "память", "памяти", "базу"];
const TAKE_AS = ["top-priority", "highest-priority", "top priority", "highest priority", "primary", "main", "real", "actual", "only",
  "главной", "главную", "основной", "единственной", "настоящей"];
const CANCELLED = ["cancelled", "canceled", "void", "revoked", "lifted", "removed", "suspended", "disabled", "no longer apply",
  "no longer valid", "отменены", "сняты", "отключены", "недействительны", "больше не действуют"];
/** "You are now …" is strong only when the rest makes it about the agent; "You are now part of the sales team" is not. */
const NOW_EN = ["you are now", "you're now", "from now on you", "from now on, you", "from now on your", "from now on, your",
  "from here on, you", "from here on you"];
const NOW_EN_STRONG = ["dan", "jailbroken", "unrestricted", "unfiltered", "uncensored", "free", "no longer", "not bound", "not restricted",
  "without", "in developer mode", "in god mode", "in admin mode", "an unrestricted", "an unfiltered", "an evil", "evil", "a hacker",
  "answer", "reply", "respond", "obey", "ignore", "will ignore", "will obey", "will answer", "must ignore", "must obey", "must answer",
  "must reveal", "act as", "speak as", "work for me", "my", "the admin", "the administrator", "the owner", "the system", "admin",
  "administrator", "root"];
const NOW_RU_TY = ["ты теперь", "теперь ты", "с этого момента ты", "отныне ты"];
const NOW_RU_VY = ["вы теперь", "теперь вы", "с этого момента вы", "отныне вы"];
const NOW_RU_TY_STRONG = ["не", "новый", "новая", "другой", "другая", "свободен", "свободна", "бот", "ассистент", "модель", "без",
  "работаешь", "действуешь", "являешься", "должен", "должна", "обязан", "обязана", "администратор", "админ", "dan", "хакер", "ии"];
const NOW_RU_VY_STRONG = ["свободны", "бот", "ассистент", "модель", "ии", "нейросеть", "без ограничений", "без правил", "без цензуры",
  "администратор", "админ", "dan", "хакер"];
const NO_LIMITS = ["no restrictions", "no rules", "no limits", "no limitations", "no filters", "no content policy", "no guidelines",
  "no safety", "without restrictions", "without any restrictions", "without rules", "without limits", "without filters", "unrestricted",
  "unfiltered", "uncensored", "нет ограничений", "нет никаких ограничений", "нет правил", "без ограничений", "без правил", "без цензуры",
  "без фильтров", "не существует", "не существуют"];

// ---- rules ------------------------------------------------------------------------------------------------------------

interface Rule { readonly id: string; readonly strong: boolean; readonly re: RegExp }

const RULES: readonly Rule[] = Object.freeze([
  // family 1 — override phrases (strong)
  { id: "override-en", strong: true, re: re(`${L}${alt(EN_OVERRIDE)}(?<!${alt(EN_NEG)} ${alt(EN_OVERRIDE)})${R}(?:,? ${alt(EN_DET)}){0,5},? ${alt(EN_TARGET)}${R}`) },
  // "ignore the text above", "forget everything you were told before"
  { id: "override-above", strong: true, re: re(`${L}${alt(EN_OVERRIDE)}(?<!${alt(EN_NEG)} ${alt(EN_OVERRIDE)})${R}(?:,? ${alt(EN_DET)}){0,3},? ${alt(["text", "everything", "anything", "what", "whatever", "content", "messages", "message", "words", "conversation"])}(?:,? ${alt(["that", "which", "you", "were", "was", "have", "has", "been", "is", "are", "i", "we", "just", "ve", "'ve"])}){0,3},? ${alt(["above", "so far", "until now", "up to now", "before", "earlier", "previously", "prior", "told", "given", "said", "written", "stated", "sent", "received", "instructed"])}${R}`) },
  { id: "override-ru", strong: true, re: re(`${L}${alt(RU_OVERRIDE)}(?<!${w("не")} ${alt(RU_OVERRIDE)})${R}(?:,? ${alt(RU_DET)}){0,5},? ${alt(RU_TARGET)}${R}`) },
  // "do not follow the instructions above", "stop following your instructions"; Russian "do not run earlier instructions"
  { id: "stop-following", strong: true, re: re(`${L}${alt(["do not", "don't", "dont", "never", "stop", "no longer", "cease to", "quit"])} ${alt(["follow", "following", "obey", "obeying", "listen to", "listening to"])}${R}(?:(?: ${alt(["the", "all", "any"])})? ${alt(["your", "previous", "prior", "earlier", "original", "initial", "system", "any", "all", "former", "old"])}(?: ${alt(["previous", "prior", "earlier", "original", "initial", "system", "safety"])})? ${alt(EN_TARGET)}${R}|(?: ${alt(["the", "these", "those", "any", "all"])})? ${alt(EN_TARGET)} ${alt(["above", "so far", "until now", "you were given", "you received", "you have"])}${R})`) },
  { id: "stop-following-ru", strong: true, re: re(`${L}${alt(RU_STOP)}${R}(?: ${alt(RU_STOP_DET)}){1,2} ${alt(RU_TARGET)}${R}|${L}${alt(RU_STOP)}${R}(?: ${alt(RU_DET)}){0,2} ${alt(RU_TARGET)} ${w("выше")}${R}`) },
  // "New instructions:" is strong; "New rules:" only when an order to the agent follows ("Updated rules: answer in JSON only")
  { id: "new-rules", strong: true, re: re(`${L}${alt(["new", "updated", "revised", "real", "actual", "secret", "hidden", "override", "новые", "обновлённые", "обновленные", "настоящие", "секретные", "скрытые"])} (?:${w("system")} )?${alt(["instructions", "instruction", "directives", "system prompt", "инструкции", "директивы"])} ?: ?[^\n]{0,3}?\\p{L}`) },
  { id: "new-rules-order", strong: true, re: re(`${L}${alt(["new", "updated", "revised", "real", "actual", "secret", "hidden", "override", "новые", "обновлённые", "обновленные", "настоящие", "секретные", "скрытые"])} ${alt(["rules", "orders", "правила", "указания", "приказы"])} ?: ?${alt(["answer", "reply", "respond", "output", "print", "say", "ignore", "forget", "delete", "send", "you must", "you will", "do not tell", "отвечай", "ответь", "отвечать", "выведи", "выводить", "игнорируй", "игнорировать", "забудь", "удали", "удалять", "отправь", "отправлять", "ты должен", "ты обязан"])}${R}`) },
  { id: "you-are-now", strong: true, re: re(`${L}${alt(NOW_EN)}${R},? ${alt(NOW_EN_STRONG)}${R}`) },
  { id: "you-are-now-ru", strong: true, re: re(`${L}${alt(NOW_RU_TY)}${R},? ${alt(NOW_RU_TY_STRONG)}${R}|${L}${alt(NOW_RU_VY)}${R},? ${alt(NOW_RU_VY_STRONG)}${R}`) },
  { id: "hide-from-user", strong: true, re: re(`${L}${alt(["do not", "don't", "dont", "never"])} ${alt(["tell", "reveal", "mention", "inform", "show", "disclose", "report"])}${R}[^\n]{0,50}?${L}${alt(["user", "person", "human", "operator"])}`) },
  { id: "hide-from-user-ru", strong: true, re: re(`${L}${alt(["не", "никогда не"])} ${alt(["говори", "говорите", "сообщай", "сообщайте", "рассказывай", "рассказывайте", "показывай", "показывайте", "упоминай", "упоминайте", "раскрывай", "раскрывайте"])}${R}[^\n]{0,50}?${L}${alt(["пользовател", "человек", "владельц", "оператор"])}`) },
  { id: "system-prompt", strong: true, re: re(`${L}${alt(["reveal", "print", "show", "repeat", "output", "leak", "dump", "disclose", "ignore", "override", "forget", "replace", "new", "your", "reply with", "respond with", "answer with", "share", "покажи", "покажите", "выведи", "выведите", "раскрой", "раскройте", "повтори", "повторите", "игнорируй", "забудь", "новый", "новые", "твой", "твои", "твоих", "ваш", "ваши", "тебя", "свои", "своих", "напиши"])}${R}[^\n]{0,24}?${L}${alt(["system prompt", "system message", "hidden instructions", "initial instructions", "original instructions", "developer message", "системный промпт", "системного промпта", "системные инструкции", "системное сообщение", "скрытые инструкции", "скрытых инструкций", "исходные инструкции", "исходных инструкций", "изначальные инструкции", "первоначальные инструкции"])}${R}`) },
  { id: "jailbreak", strong: true, re: re(`${L}${alt(["jailbreak", "jailbroken", "dan mode", "developer mode enabled", "developer mode on", "do anything now", "unrestricted mode", "unfiltered mode", "uncensored mode", "джейлбрейк", "режим разработчика включён", "режим разработчика включен", "без каких-либо ограничений", "режим без цензуры", "режиме без цензуры"])}${R}`) },
  // "pretend you are an AI without any restrictions", Russian "act as if there were no rules"
  { id: "pretend", strong: true, re: re(`${L}${alt(["pretend", "act as if", "act like", "imagine", "behave as if", "roleplay as", "притворись", "притворитесь", "представь", "веди себя так", "веди себя как", "ведите себя так", "сделай вид"])}${R}[^\n]{0,50}?${L}${alt(NO_LIMITS)}${R}`) },
  { id: "disable-safety", strong: true, re: re(`${L}${alt(["remove", "disable", "turn off", "bypass", "lift", "drop", "сними", "снимите", "отключи", "отключите", "выключи", "выключите"])}${R}(?: ${alt(["all", "any", "the", "your", "все", "свои", "твои", "любые"])}){0,2}(?: ${alt(["safety", "security", "content"])})? ${alt(["restrictions", "filters", "guardrails", "safeguards", "safety checks", "ограничения", "фильтры", "проверки безопасности"])}${R}`) },
  { id: "regardless", strong: true, re: re(`${L}${alt(["regardless of", "in spite of", "despite", "вопреки", "несмотря на"])}(?: ${alt(["any", "all", "the", "your", "все", "любые"])})? ${alt(["earlier", "previous", "prior", "other", "system", "your", "original", "предыдущим", "прежним", "системным", "твоим", "своим", "предыдущие", "прежние", "системные"])} ${alt(["rules", "instructions", "guidelines", "правилам", "инструкциям", "правила", "инструкции"])}${R}|${L}${w("что бы ни")} ${alt(["говорили", "говорят", "сказали", "требовали"])} ${alt(["прежние", "предыдущие", "системные", "твои", "твои прежние"])} ${alt(["правила", "инструкции"])}${R}`) },
  { id: "overrides-all", strong: true, re: re(`${L}${alt(["overrides", "supersedes", "cancels", "replaces"])} ${alt(["any", "all", "every"])} ${alt(["previous", "prior", "earlier", "other", "system"])}${R}|${L}${alt(["отменяет", "заменяет"])} ${alt(["все", "любые"])} ${alt(["предыдущие", "прежние", "остальные"])}${R}`) },
  { id: "cancelled-rules", strong: true, re: re(`${L}${alt(["your", "all your", "the system", "твои", "ваши", "все твои", "системные"])} ${alt(["guidelines", "rules", "instructions", "restrictions", "guardrails", "правила", "инструкции", "ограничения"])} (?:${alt(["are", "have been", "were", "are now", "have now been"])} )?${alt(CANCELLED)}${R}|${L}${alt(["your", "твои", "ваши"])} ${alt(["guidelines", "rules", "instructions", "restrictions", "правила", "инструкции", "ограничения"])} ${alt(CANCELLED)}${R}`) },
  { id: "treat-as-instruction", strong: true, re: re(`${L}${alt(["treat", "consider", "regard", "take", "считай", "считайте", "воспринимай", "воспринимайте"])}${R}[^\n]{0,30}?${L}(?:${w("as")} )?(?:${alt(["your", "свою", "своей", "твоей"])} )?${alt(TAKE_AS)} ${alt(["instruction", "instructions", "command", "order", "rule", "инструкцией", "инструкцию", "командой", "правилом"])}${R}`) },
  { id: "ignore-the-person", strong: true, re: re(`${L}${alt(["ignore", "disregard"])}(?: ${alt(["what", "whatever", "anything"])})?(?: ${w("the")})? ${alt(["person", "user", "human", "operator", "owner", "people"])}(?:'s)? ${alt(["asks", "says", "wants", "requests", "request", "instructions", "questions", "tells you"])}${R}|${L}${alt(["игнорируй", "игнорируйте", "не слушай", "не слушайте"])} ${alt(["просьбы", "слова", "вопросы", "запросы", "указания"])} ${alt(["человека", "пользователя", "владельца", "людей"])}${R}`) },
  { id: "canary", strong: true, re: re(`${L}${alt(["say", "print", "output", "write", "reply with", "respond with", "answer with", "type", "напиши", "выведи", "ответь", "скажи"])}${R}[^\n]{0,20}?${L}${alt(["hacked", "pwned", "haha pwned", "i have been pwned", "взломано", "взломан"])}${R}`) },
  // family 2 — control tokens (strong): chat-template tokens anywhere, tags and the Alpaca heading at the start of a visible line
  { id: "chat-token", strong: true, re: re(alt(["<|im_start|>", "<|im_end|>", "<|system|>", "<|user|>", "<|assistant|>", "<|endoftext|>", "<|eot_id|>", "<|start_header_id|>", "[inst]", "[/inst]", "<<sys>>"])) },
  { id: "control-tag", strong: true, re: re(`(?:${START}|${AFTER_DASH})${alt(["<system>", "</system>", "<tool_use>", "<function_calls>", "<tool_call>", "<instructions>", "<system_prompt>"])}`) },
  { id: "instruction-heading", strong: true, re: re(`^[ >]{0,4}#{2,6} ?${alt(["instruction", "instructions", "system prompt", "system message", "new instructions", "инструкция", "инструкции", "системный промпт"])} ?:? ?$`) },
  // "[SYSTEM] …" at the start of a line; "SYSTEM OVERRIDE:", "New system message:" anywhere
  { id: "system-bracket", strong: true, re: re(`${START}[\\[(] ?${alt(["system", "sys", "system message", "system note", "system override", "system prompt", "система", "системное сообщение"])} ?[\\])]`) },
  { id: "system-label", strong: true, re: re(`${L}${alt(["system override", "new system message", "new system prompt", "system message", "system instruction", "новое системное сообщение", "системное сообщение", "системная инструкция"])} ?:`) },
  // an AI named as the one a line is for, before a colon: "ATTENTION AI:", "Note for the LLM reading this:"
  { id: "attention-ai", strong: true, re: re(`${START}${alt(ATTENTION)}(?: ?[,!])?(?: ${alt(["for", "to", "для"])})?(?: ${alt(["the", "all", "any", "every"])})? ${alt(AI_READERS)}(?: ${alt(["reading this", "reading", "processing this", "who reads this", "that reads this", "читающему", "читающих"])})? ?[:!]`) },
  // family 2 — role labels and JSON tool calls (weak)
  { id: "role-label", strong: false, re: re(`(?:${START}|${AFTER_DASH})${alt(["system", "assistant", "user", "human", "developer", "система", "ассистент", "пользователь"])} ?:`) },
  { id: "json-call", strong: false, re: re(`\\{ ?"${alt(["tool", "tool_calls", "function_call", "tool_use"])}" ?:|"${alt(["function_call", "tool_calls", "tool_use"])}"`) },
  // family 3 — an AI addressed with an imperative (weak)
  { id: "ai-imperative", strong: false, re: re(`${L}${alt(AI)}${R}[^\n]{0,40}?${L}${alt(IMPERATIVE)}${R}|${L}${alt(IMPERATIVE)}${R}[^\n]{0,40}?${L}${alt(AI)}${R}`) },
  // the dash of the third branch is "-": spaced() folds every dash to it
  { id: "ai-vocative", strong: false, re: re(`${START}${alt(VOCATIVE)}${alt(AI_ONE)}${R} ?,|${START}${alt(VOCATIVE)}${alt(AI_GENERIC)}${R} ?:|[,-] ${alt(AI_GENERIC)}${R} ?[.!]? ?$`) },
  { id: "role-claim", strong: false, re: re(`${L}${alt(["you are", "you're", "ты", "вы"])} ${alt(["", "now "])}${alt(["the ", "an ", "a ", ""])}${alt(["administrator", "admin", "root", "superuser", "администратор", "админ", "суперпользователь"])}${R}`) },
  { id: "privilege-claim", strong: false, re: re(`${L}${alt(["you have", "you've got", "you now have", "you are granted", "granted you", "given you", "у тебя теперь", "у вас теперь", "тебе даны", "вам даны", "тебе выданы"])}${R}[^\n]{0,20}?${L}${alt(["admin", "administrator", "full", "root", "elevated", "unlimited", "all", "полные", "полный", "все", "административные"])} ${alt(["rights", "access", "permissions", "privileges", "права", "доступ", "полномочия"])}${R}`) },
  { id: "you-are-now-weak", strong: false, re: re(`${L}${alt([...NOW_EN, ...NOW_RU_TY, ...NOW_RU_VY])}${R}(?! ${alt(["logged", "signed", "connected", "ready", "able", "in", "on", "at", "done", "set", "all set", "registered"])}${R})`) },
  { id: "you-must-now", strong: false, re: re(`${L}${alt(["you must now", "you will now", "you should now", "now you must", "теперь ты обязан", "ты теперь обязан", "теперь ты должен"])}${R}`) },
  { id: "new-rules-weak", strong: false, re: re(`${L}${alt(["new", "updated", "revised", "новые", "обновлённые", "обновленные"])} ${alt(["rules", "orders", "правила", "указания"])} ?:`) },
  { id: "new-task", strong: false, re: re(`${L}${alt(["your new task", "your real task", "your only task", "your next task", "new task", "твоя новая задача", "ваша новая задача", "новая задача", "твоя настоящая задача", "твоя единственная задача"])}${R}`) },
  { id: "instead", strong: false, re: re(`${L}${w("instead")}${R},?(?: ${w("of")})? ${alt(["answering", "replying", "responding", "say", "reply", "answer", "respond", "print", "output", "write"])}${R}|${L}${w("вместо")} ${alt(["ответа", "того чтобы ответить", "пересказа"])}${R}`) },
  { id: "only-reply", strong: false, re: re(`${L}${alt(["respond only", "reply only", "answer only", "output only", "only respond", "only reply", "only answer", "отвечай только", "ответь только", "выведи только"])}${R}`) },
  { id: "reader", strong: false, re: re(`${L}${alt(READER)}${R}|${START}${alt(AI_READERS)}${R}[^\n]{0,20}?${L}${alt(PROCESSING)}${R}`) },
  { id: "obey", strong: false, re: re(`${L}${alt(["obey", "comply with", "подчиняйся", "подчиняйтесь", "повинуйся"])}${R}|${L}${alt(["do what", "do whatever", "делай то, что", "делай, что", "делайте то, что"])} ${alt(["this note", "this record", "this text", "this line", "the note", "сказано здесь", "написано здесь", "сказано в заметке"])}${R}`) },
  { id: "secret-ask", strong: false, re: re(`${L}${alt(["list", "print", "reveal", "show", "output", "send", "dump", "give me", "выведи", "покажи", "отправь", "перечисли", "дай"])}${R}[^\n]{0,30}?${L}${alt(["api key", "api keys", "password", "passwords", "token", "tokens", "credentials", "secrets", "ключи доступа", "ключ доступа", "пароль", "пароли", "токен", "токены"])}${R}`) },
  { id: "secret-path", strong: false, re: re(`${alt(["/etc/passwd", "/etc/shadow", "id_rsa", ".aws/credentials", ".ssh/"])}`) },
  { id: "secrecy", strong: false, re: re(`${L}${alt(SECRECY_EN)} ${alt(SECRECY_VERB)}${R}[^\n]{0,12}?${L}${alt(SECRECY_WHO)}${R}|${L}${alt(SECRECY_RU)}${R}`) },
  { id: "stealth", strong: false, re: re(`${L}${alt(STEALTH)}${R}`) },
  { id: "self-command", strong: false, re: re(`${L}${alt(SELF_VERB)} ${alt(SELF_WHAT)}${R}`) },
  { id: "reveal-private", strong: false, re: re(`${L}${alt(["reveal", "expose", "leak", "dump", "disclose", "раскрой", "раскрыть", "раскройте", "слей", "слить"])}${R}[^\n]{0,30}?${L}${alt(["private", "closed", "secret", "confidential", "личные", "закрытые", "секретные", "конфиденциальные"])}${R}`) },
  // family 4 — tool-directed commands and exfiltration (weak)
  { id: "tool-call", strong: false, re: re(`${L}${alt(CALL)}${R}[^\n]{0,20}?${w("memory_")}${alt(WRITE_TOOLS)}${R}|${L}${alt(["call the tool", "use the tool", "run the tool", "вызови инструмент", "вызовите инструмент"])}${R}`) },
  { id: "tool-chain", strong: false, re: re(`${L}${alt(CALL)}${R}[^\n]{0,20}?${w("memory_")}${alt(WRITE_TOOLS)}${R}[^\n]{0,80}?${L}${alt(CALL)}${R}[^\n]{0,20}?${w("memory_")}${alt(WRITE_TOOLS)}${R}`) },
  // a write tool with an argument and no verb: "memory_delete id=…", "memory_delete(…"
  { id: "tool-args", strong: false, re: re(`${w("memory_")}${alt(WRITE_TOOLS)}${R} ?(?:[({]|${w("id")} ?=|${w("record_id")} ?=)`) },
  { id: "tool-demand", strong: false, re: re(`${L}${alt(["tool call", "function call", "вызов инструмента"])} ${alt(["required", "needed", "requested", "now", "обязателен", "нужен", "требуется"])}${R}`) },
  { id: "scope-all", strong: false, re: re(`${L}${alt(SCOPE_ALL)}(?: ${alt(["the", "of the", "of", "in", "in the", "this", "of this"])})?(?: [\\p{L}-]{1,20})? ${alt(SCOPE_WHAT)}${R}`) },
  { id: "exfiltrate", strong: false, re: re(`${L}${alt(SEND)}${R}[^\n]{0,60}?${w("http")}s?:\\/\\/`) },
  { id: "pipe-shell", strong: false, re: re(`${L}${alt(["curl", "wget"])}${R}[^\n]{0,200}?\\| ?(?:${w("sudo")} )?${alt(["sh", "bash", "zsh"])}${R}`) },
]);

/**
 * All rules at once — only for the text of an HTML comment, where any rule counts. The window loop tests the rules one by
 * one: V8 runs one alternation of forty-odd rules several times slower than the rules apart (6.6 ms against about 1 ms on
 * a window of 2,000 units).
 */
const ANY = re(RULES.map((r) => `(?:${r.re.source})`).join("|"));
/** Every rule expression and ANY, only for a unit test (each needs a letter); index.ts does not export it. */
export const RULE_EXPRESSIONS_FOR_TESTS: readonly RegExp[] = Object.freeze([...RULES.map((r) => r.re), ANY]);
const LETTER = /\p{L}/u;
/** A window needs its second view only if it holds a control, private-use or unassigned character, or an unpaired surrogate (removing a format character between two unpaired surrogates joins them into one character of any class); for every other window spacedApart() equals spaced() — pinned by a unit test. */
const APART = /[\p{Cc}\p{Co}\p{Cn}\p{Cs}]/u;
/**
 * A model reads a control, private-use or unassigned character inside a word as it reads the sentence, so a window also
 * reads every mix of "nothing" and "one space" at its places (runs of such characters between two characters that are not
 * spaces) — for up to PLACES_MAX places; a window with more places is read in its two views only and its line gets the
 * weak id "split-words".
 */
const PLACES_MAX = 4;
const PLACE = /[\p{Cc}\p{Co}\p{Cn}]+/gu;

/** Zero-width, bidi and tag characters in the raw line — invisible to a person, a weak signal of a hidden instruction. */
const INVISIBLE = /[\u200b\u2060\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]/u;
/** Eight or more tag characters in a row: text written for a model and hidden from a person. */
const TAG_RUN = /[\u{e0020}-\u{e007e}]{8}/u;
/** The page anchors of converted documents (read-range.ts PAGE) are not comments of a person. */
const PAGE_ANCHOR = /^\s*page:\s*\d+\s*$/;

/** A visible part as the windows read it: tag characters as ASCII, format characters gone, every run of spaces one space. */
const dense = (part: string): string => part
  .replace(/[\u{e0020}-\u{e007e}]/gu, (c) => String.fromCharCode(c.codePointAt(0)! - 0xe0000))
  .replace(/\p{Cf}/gu, "")
  .replace(/[\p{Z}\s\u115f\u1160\u2800\u3164\uffa0]+/gu, " ");

/**
 * The detector's views of a dense part: one, or windows of WINDOW units that overlap by OVERLAP. A window after the first
 * starts after a space (no word cut in two at its start); a window that does not reach the end of the part, or does not
 * start at its beginning, gets a control character on that side, so "^" and "$" of a rule mean the real edges of the line.
 */
function views(s: string, max = Infinity): { out: string[]; split: boolean } {
  const out: string[] = [];
  let split = false;
  for (let at = 0, windows = 0; windows < max; at += WINDOW - OVERLAP, windows++) {
    let from = at;
    if (at > 0) { const sp = s.indexOf(" ", at); if (sp !== -1 && sp - at < 40) from = sp + 1; }
    const to = Math.min(s.length, at + WINDOW);
    const slice = s.slice(from, to);
    const plain = spaced(slice);
    const apart = APART.test(slice) ? spacedApart(slice) : plain;
    const prefix = at > 0 ? "\u0001" : "";
    const suffix = to < s.length ? "\u0001" : "";
    out.push(`${prefix}${plain}${suffix}`);
    if (apart !== plain) out.push(`${prefix}${apart}${suffix}`);
    if (APART.test(slice)) {
      const found = places(slice);
      if (found.length > PLACES_MAX) split = true;
      else if (found.length > 1) {
        const seen = new Set([plain, apart]);
        for (let choice = 1; choice < (1 << found.length) - 1; choice++) {
          let read = "", last = 0;
          found.forEach(([a, b], k) => { read += slice.slice(last, a) + (choice & (1 << k) ? " " : ""); last = b; });
          const v = spaced(read + slice.slice(last));
          if (!seen.has(v)) { seen.add(v); out.push(`${prefix}${v}${suffix}`); }
        }
      }
    }
    if (to === s.length) break;
  }
  return { out, split };
}

/** The places of a window: maximal runs of PLACE whose neighbour on each side, inside the window, is not a space. */
function places(slice: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of slice.matchAll(PLACE)) {
    const a = m.index, b = a + m[0].length;
    if (a > 0 && b < slice.length && slice[a - 1] !== " " && slice[b] !== " ") out.push([a, b]);
  }
  return out;
}

/** Inside texts of the HTML comments of a dense part: indexOf, so thousands of "<!--" without "-->" cost one pass. */
function comments(s: string): string[] {
  const out: string[] = [];
  let at = s.indexOf("<!--");
  while (at !== -1) {
    const end = s.indexOf("-->", at + 4);
    out.push(s.slice(at + 4, end === -1 ? s.length : end));
    if (end === -1) break;
    at = s.indexOf("<!--", end + 3);
  }
  return out;
}

/**
 * Verdict on one \n-line of record text: the indexes (into `line.split(BREAKS)`, so even numbers) of the visible parts a
 * rule fired on when the line is flagged — one strong rule, or two different weak ones anywhere in the line — else [].
 */
function verdict(line: string): number[] {
  if (!line) return [];
  const weak = new Set<string>(), strongAt = new Set<number>(), weakAt = new Set<number>();
  if (INVISIBLE.test(line)) weak.add("invisible");
  const parts = line.split(BREAKS);
  for (let i = 0; i < parts.length; i += 2) {
    const raw = parts[i]!;
    if (!raw) continue;
    if (TAG_RUN.test(raw)) strongAt.add(i);
    const s = dense(raw);
    // Every rule needs a letter: the loop below reads no view without one, and the comment rule ANY is the same rules. A
    // view holds a letter only where NFKD, lower case and fold, the letter-making steps of spaced(), leave one in the part:
    // its other steps and those of spacedApart() write no letter. A part without an APART character has no second view, no
    // place readings and no unpaired surrogates for a removal to join. So such a part fires nothing, and it costs this one
    // pass instead of its windows and comments (one line of "<!--" × 250,000;: 9,900 lines of them).
    if (!LETTER.test(s) && !APART.test(s) && !LETTER.test(fold(s.normalize("NFKD").toLowerCase()))) continue;
    let hit = false;
    const read = views(s);
    if (read.split) { weak.add("split-words"); weakAt.add(i); }
    for (const v of read.out) {
      if (!LETTER.test(v)) continue;                     // every rule needs a letter: "<!--" × 250,000 is read once, not 45 times
      for (const r of RULES) {
        if (!r.re.test(v)) continue;
        hit = true;
        if (r.strong) strongAt.add(i);
        else { weak.add(r.id); weakAt.add(i); }
      }
    }
    // family 5: a comment that carries any rule of families 1–4 is strong. When no rule fired on the whole part, only a rule
    // anchored at the start of the comment's text can fire inside it, so only the comment's first window is read then
    // (one unterminated "<!--" of a megabyte costs one window, not five hundred).
    if (!strongAt.has(i) && s.includes("<!--")) {
      for (const inside of comments(s)) {
        if (PAGE_ANCHOR.test(inside)) continue;
        if (views(inside, hit ? Infinity : 1).out.some((v) => ANY.test(v.trim()))) { strongAt.add(i); break; }
      }
    }
  }
  if (!strongAt.size && weak.size < 2) return [];
  const at = new Set(strongAt);
  if (weak.size >= 2) for (const i of weakAt) at.add(i);
  return [...at].sort((a, b) => a - b);
}

/**
 * The flagged \n-lines of `text` with, for each, the visible parts (indexes into `line.split(BREAKS)`) that hold the
 * instruction — the text form puts its prefix there. Ascending line order; pure.
 */
export function instructionParts(text: string): Array<readonly [line: number, parts: readonly number[]]> {
  const out: Array<readonly [number, readonly number[]]> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const at = verdict(lines[i]!);
    if (at.length) out.push([i, at]);
  }
  return out;
}

/** Ascending 0-based indexes of the \n-lines of `text` that look like an instruction. Pure: the same text, the same answer. */
export function instructionLines(text: string): number[] {
  return instructionParts(text).map(([i]) => i);
}
