import { text } from "../messages/greeting";

export interface NamedPerson { login: string; display_name?: string | null; given_name?: string | null }

const FIRST_NAMES = new Set(("александр алексей анатолий андрей антон аркадий арсений артем артемий артур богдан борис вадим валентин "
  + "валерий василий вениамин виктор виталий владимир владислав всеволод вячеслав гавриил геннадий георгий герман глеб григорий давид "
  + "даниил данила демид денис дмитрий евгений егор елисей ефим захар иван игорь илья иннокентий иосиф кирилл константин лев леонид лука "
  + "макар максим марк матвей мирон михаил назар никита николай олег павел петр платон роберт родион роман ростислав руслан савва "
  + "святослав семен сергей станислав степан тарас тимофей тимур тихон федор феликс филипп эдуард эльдар эрик юрий яков ян ярослав "
  + "айдар азат ильдар ринат рустам марат камиль дамир тагир ренат ильнур альберт рамиль фарид азамат амир данияр ислам мурат нурлан "
  + "рашид ришат салават шамиль эмиль адам али булат ильяс айрат "
  + "алена алина алиса алла альбина анастасия ангелина анна антонина арина валентина валерия варвара василиса вера вероника виктория "
  + "виолетта галина дарья диана ева евгения екатерина елена елизавета жанна зарина зинаида злата зоя инна ирина камила карина кира "
  + "клавдия кристина ксения лариса лидия лилия любовь людмила маргарита марина мария милана надежда наталья наталия нина оксана олеся "
  + "ольга полина раиса регина римма светлана софья софия таисия тамара татьяна ульяна элина эльвира эмилия юлия яна ярослава "
  + "гульнара динара лейла айгуль алсу альфия гузель наиля эльмира "
  + "эвелина каролина аделина сабина фаина дина руфина устин мартин демьян лукьян").split(" "));

const known = (w: string): boolean => FIRST_NAMES.has(w.toLowerCase().replace(/ё/g, "е"));
const PATRONYMIC = /(?:ич|вна|чна|оглы|кызы|гызы|улы|уулу)$/;
const patronymic = (w: string): boolean => w.length >= 5 && PATRONYMIC.test(w.toLowerCase()) && /[а-яё]/i.test(w);
const TURKIC = new Set(["оглы", "кызы", "гызы", "улы", "уулу"]);
const SURNAME = /(?:ов|ев|ёв|ин|ын|ова|ева|ёва|ина|ына|ский|цкий|ская|цкая|ой|ко|ук|юк|их|ых|ич|ян|дзе|швили)$/i;
const surname = (w: string): boolean => w.length >= 3 && SURNAME.test(w) && !known(w);
const initial = (w: string): boolean => /^\p{L}$/u.test(w) || /^\p{L}{1,2}\./u.test(w);
const WORD = /^\p{L}{2,}(?:[-'’]\p{L}+)*$/u;
const CYR = /[А-ЯЁа-яё]/;
const oneLine = (s: string | null | undefined): string => (s ?? "").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();

function tidy(w: string): string {
  if (!/^[А-ЯЁа-яё'’-]+$/.test(w) || (w !== w.toUpperCase() && w !== w.toLowerCase())) return w;
  return w.toLowerCase().replace(/(^|[-'’])([а-яё])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

export function firstNameFromDisplay(display: string | null | undefined): string | null {
  const text = oneLine(display);
  if (!text) return null;
  if (!CYR.test(text)) {
    const comma = text.indexOf(",");
    const first = (comma >= 0 ? text.slice(comma + 1) : text).trim().split(" ")[0] ?? "";
    return WORD.test(first) ? first : null;
  }
  let t = text.replace(/[,;]/g, " ").split(" ").filter(Boolean);
  if (t.length >= 4 && TURKIC.has(t[t.length - 1]!.toLowerCase())) t = t.slice(0, -2);
  const mixed = text !== text.toLowerCase() && text !== text.toUpperCase();
  if (mixed && t.some((w) => /^\p{Ll}/u.test(w) && !TURKIC.has(w))) return null;
  let pick: string | undefined;
  if (t.length === 1) pick = t[0];
  else if (t.length === 2) {
    const [a, b] = [t[0]!, t[1]!];
    if (initial(a) || initial(b)) pick = undefined;
    else if (known(a) && !known(b)) pick = a;
    else if (known(b)) pick = b;
    else if (surname(b) && !surname(a)) pick = a;
    else if (surname(a) && !surname(b)) pick = b;
  } else if (t.length === 3) {
    if (patronymic(t[2]!) && !patronymic(t[1]!)) pick = t[1];
    else if (patronymic(t[1]!)) pick = t[0];
    else pick = known(t[1]!) ? t[1] : known(t[0]!) ? t[0] : undefined;
  } else if (patronymic(t[t.length - 1]!)) {
    pick = !known(t[1]!) && (known(t[2]!) || (surname(t[1]!) && !surname(t[2]!))) ? t[2] : t[1];
  }
  return pick && WORD.test(pick) ? tidy(pick) : null;
}

function givenFirst(given: string | null | undefined): string | null {
  const g = oneLine(given).slice(0, 100);
  if (!/\p{L}/u.test(g)) return null;
  const t = g.split(" ");
  if (t.length >= 3 && t.slice(1).some(patronymic) && !(known(t[0]!) && patronymic(t[t.length - 1]!))) return firstNameFromDisplay(g) ?? tidy(t[0]!);
  return tidy(t.length >= 2 && patronymic(t[t.length - 1]!) ? t[0]! : g);
}

export function greetingName(p: NamedPerson): string {
  const display = oneLine(p.display_name), login = oneLine(p.login);
  return givenFirst(p.given_name) ?? firstNameFromDisplay(display) ?? (display || login.split("@")[0] || login || text.colleague);
}
