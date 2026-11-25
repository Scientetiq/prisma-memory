import { models as t } from "@/messages/m-models";

export default function LoadingModels() { return <p role="status" aria-live="polite">{t.working}</p>; }
