// Four databases, four sets of tables. The application creates connections by role (gateway/worker), not this package.
export * as control from "./schema/control";
export * as records from "./schema/records";   // one schema for memory_open and memory_closed
export * as audit from "./schema/audit";
export * as edge from "./schema/edge";      // edge database edge-pg: a copy of the published data and the login schema
export * from "./custom-types";
