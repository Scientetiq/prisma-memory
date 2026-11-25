// Descriptions of the storage.* settings (object storage and backups), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-storage", {
  s3_endpoint: {
    en: "Address of the S3-compatible storage that keeps original files",
    ru: "Адрес S3-совместимого хранилища оригиналов",
  },
  s3_endpoint_closed: {
    en: "S3 address for the closed bucket; empty — the same as s3_endpoint. Needed when closed records live in a separate storage; open records always use s3_endpoint",
    ru: "Адрес S3 для закрытого бакета; пусто — тот же, что s3_endpoint. Нужен, когда закрытый класс лежит в отдельном хранилище (запасной путь деплоя): открытый класс всегда берёт s3_endpoint",
  },
  s3_region: {
    en: "Region name sent to the S3 storage (us-east-1 suits most S3-compatible servers)",
    ru: "Имя региона, которое передаётся хранилищу S3 (us-east-1 подходит большинству S3-совместимых серверов)",
  },
  bucket_open: {
    en: "Bucket for original files of open records",
    ru: "Бакет оригиналов открытого класса",
  },
  bucket_closed: {
    en: "Bucket for original files of closed records (separate credentials)",
    ru: "Бакет оригиналов закрытого класса (отдельные учётные данные)",
  },
  access_key_open: {
    en: "Access key of the open bucket (stored encrypted)",
    ru: "Ключ доступа открытого бакета (хранится зашифрованным)",
  },
  secret_key_open: {
    en: "Secret key of the open bucket (stored encrypted)",
    ru: "Секретный ключ открытого бакета (хранится зашифрованным)",
  },
  access_key_closed: {
    en: "Access key of the closed bucket (stored encrypted)",
    ru: "Ключ доступа закрытого бакета (хранится зашифрованным)",
  },
  secret_key_closed: {
    en: "Secret key of the closed bucket (stored encrypted)",
    ru: "Секретный ключ закрытого бакета (хранится зашифрованным)",
  },
  inbox_prefix: {
    en: "Key prefix of incoming objects for documents accepted by object_key (upload button, converter): keys outside the prefix are refused",
    ru: "Префикс ключей входящих объектов для приёма документов по object_key (кнопка, конвертер): ключи вне префикса не принимаются",
  },
  backup_retention_days: {
    en: "How many days database backups are kept on the server (7–3650): older backups are deleted after a new backup, on deployment and every night, and what people deleted leaves the backups with them. The three latest consistent backups always stay; when there is no fresh consistent backup, nothing is deleted. To keep everything — 3650",
    ru: "Сколько дней хранить резервные копии баз на сервере (7–3650): копии старше срока удаляются после новой копии, при выкладке и каждую ночь, а с ними из копий уходит и удалённое людьми. Три последние согласованные копии остаются всегда; если свежей согласованной копии нет, ничего не удаляется. Чтобы не удалять совсем — 3650",
  },
});
