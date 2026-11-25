import { connectorErrors, connectors as M } from "../messages/connectors";
export { connectorErrors };

/** Unknown upstream text never becomes a UI explanation. Values are resolved for the current request's locale. */
export function explainConnectorError(code: string): { known: boolean; text: string; action: string } {
  if (Object.hasOwn(connectorErrors, code)) return { known: true, ...connectorErrors[code as keyof typeof connectorErrors] };
  return { known: false, text: M.unknown, action: M.unknownAction };
}
