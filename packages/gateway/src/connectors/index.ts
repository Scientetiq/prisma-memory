// Connectors in the gateway: the delivery of staged items into memory with changes, deletions at the
// source and the connector's daily quota. The hooks routes and the admin API live beside it in
// this folder.
export { connectorCaller, connectorClientLabel, CONNECTOR_CALLER_OPS, runAs, type ConnectorRow } from "./caller.ts";
export { deliveryTarget, type Gate, type GateReason } from "./gates.ts";
export { readStaged, StagedReadError } from "./staging.ts";
export { documentPlan, documentVersionsAvailable, onChangeOf, versionRefusal, type DocumentPlan, type OnChange } from "./changes.ts";
export { onDeleteOf, type OnDelete } from "./deletes.ts";
export { connectorDailyLimit, connectorDailyUsage, ConnectorQuotaError, takeConnectorDaily, type ConnectorDailyLimit } from "./quotas.ts";
export { claimItem, connectorMeetingId, deliverOnce, DELIVERY_LADDER_MIN, DELIVERY_MAX_ATTEMPTS, DELIVERY_PARALLEL, DELIVERY_POLL_MS, requeueHeld, startConnectorDelivery,
         stopConnectorDelivery, wakeDelivery } from "./deliver.ts";
export { HOOK_LIMITS, hookSnapshotSize, invalidateHookConnectors, registerConnectorHooks, type HookFaultPoint, type HookOptions } from "./hooks.ts";
