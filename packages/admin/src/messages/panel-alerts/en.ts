import type { LevelFilter, StatusFilter, AlertLevel, AlertStatus } from "../../app/admin/(panel)/alerts/view";

export const LEVEL_FILTERS: ReadonlyArray<{ value: LevelFilter; title: string }> = [
    { value: "all", title: "All" },
    { value: "page", title: "Urgent" },
    { value: "high", title: "High" },
    { value: "medium", title: "Medium" },
    { value: "metric", title: "Counters" },
];

export const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; title: string }> = [
    { value: "all", title: "All" },
    { value: "open", title: "Open" },
    { value: "acked", title: "Acknowledged" },
    { value: "closed", title: "Closed" },
];

export const LEVEL_BADGES: Readonly<Record<AlertLevel, { title: string; tone: "danger" | "warn" | "info"; hint: string }>> = {
    page: { title: "urgent", tone: "danger", hint: "Emails the person on duty immediately, day or night: the edge may be compromised or protection bypassed" },
    high: { title: "high", tone: "danger", hint: "Emails alert recipients immediately (daytime-only alerts wait for working hours)" },
    medium: { title: "medium", tone: "warn", hint: "Included in the daily digest" },
    metric: { title: "counter", tone: "info", hint: "Shown here only, without email" },
};

export const STATUS_BADGES: Readonly<Record<AlertStatus, { title: string; tone: "danger" | "ok" | "muted" }>> = {
    open: { title: "open", tone: "danger" },
    acked: { title: "acknowledged", tone: "ok" },
    closed: { title: "closed", tone: "muted" },
};

export const SUBJECT_TITLES: Readonly<Record<string, string>> = {
    person_id: "person", connection_id: "connection", service: "service", client_id: "application", ip_prefix: "network", change: "change", test: "test",
};

export const HOST_FACT_TITLES: Readonly<Record<string, string>> = {
    docker_members: "Members of the docker group",
    sudo_members: "Members of the sudo group",
    sudo_nopasswd: "Passwordless sudo",
    runner: "Deployment runner on the VM",
    docker_user_rules: "Custom rules in the DOCKER-USER chain",
    signer_owner: "Trust root file owner",
    relay_local: "Bridge runs on this VM",
    relay_egress_rule: "Bridge egress rule matches the edge network and address",
    relay_egress_drops: "Bridge packets dropped by the egress rule",
    relay_credentials: "Bridge credentials present",
    relay_stopped: "Bridge stopped by the kill switch",
    host_addrs: "Addresses of this VM",
    edge_tls_not_after: "Edge certificate expiry dates (presented certificates)",
    edge_tls_checked_at: "When edge expiry dates were checked",
    pki_leaves_not_after: "Bridge and proxy client certificate expiry dates",
    pki_roots_not_after: "Root certificate expiry dates",
    pki_bridge_clients_not_after: "Earliest bridge client certificate expiry",
    pki_bridge_clients_missing: "Bridge clients with unreadable certificates",
};

export const QUOTA_KIND_TITLES: Readonly<Record<string, string>> = {
    search: "searches", read: "reads", list: "lists", text_tokens: "text volume", originals: "originals (count)",
    originals_mib: "originals (MiB)", c2_items: "closed records (count)", c2_mib: "closed records (MiB)",
};

export const ACTIONS_TEXT = {
  noAlertID: "No alert ID",
  markedAsAcknowledged: "Marked as acknowledged",
  alertNotFoundItMayHaveExpired: "Alert not found — it may have expired",
  notAcknowledgedResponseValue1: (value1: string | number): string => `Not acknowledged: response ${value1}`,
  alertsWillAppearInAMinuteRefreshThePage: "Alerts will appear in a minute: refresh the page",
};

export const PAGE_TEXT = {
  alerts: "Alerts",
  alerts2: "Alerts",
  alertsBySeverity: "Alerts by severity",
  alertsByStatus: "Alerts by status",
  alerts3: "Alerts",
  all: "all",
  value1Value2: (value1: string | number, value2: string | number): string => `${value1} · ${value2}`,
  alerts4: "alerts",
  noAlerts: "No alerts.",
  when: "When",
  severity: "Severity",
  whatHappened: "What happened",
  acknowledged: "Acknowledged",
  when2: "When",
  firstSeenValue1: "first seen {value1}",
  severity2: "Severity",
  whatHappened2: "What happened",
  eventCode: "Event code",
  groupingSubjectIdentifierNotAName: "Grouping subject: identifier, not a name",
  tag1Value2Tag1: " · <tag1>{value2}</tag1>",
  tag1Value2Tag1Value3Value4: "<tag1>{value2}</tag1>{value3}{value4}",
  acknowledged2: "Acknowledged",
  acknowledge: "Acknowledge",
  pending: "pending",
  alerts5: "alerts",
  deliveryTest: "Delivery test",
  sendTestAlerts: "Send test alerts",
  queuing: "Queuing…",
  prepareDigestNow: "Prepare digest now",
  queuing2: "Queuing…",
  aMemoryAdministratorCanSendTestAlertsAndPrepare: "A memory administrator can send test alerts and prepare an unscheduled digest.",
  hostFacts: "Host facts",
  hostFacts2: "host facts",
  theHostCheckHasNotReportedAnyFactsYet: "The host check has not reported any facts yet.",
  lastCheckValue1: "Last check: {value1}",
  edgeQuotasRequestsThatWouldBeRefused: "Edge quotas: requests that would be refused",
  quotaReport: "quota report",
  noRequestsWouldHaveBeenRefusedInTheLast: "No requests would have been refused in the last 14 days.",
  who: "Who",
  quota: "Quota",
  daysWithRequestsThatWouldBeRefused: "Days with requests that would be refused",
  daysWithRefusedRequests: "Days with refused requests",
  who2: "Who",
  quota2: "Quota",
  daysWithRequestsThatWouldBeRefused2: "Days with requests that would be refused",
  daysWithRefusedRequests2: "Days with refused requests",
  rows: "rows",
};

export const VIEW_TEXT = {
  alertsLead: "Alerts cover administrator sign-ins, changes to roles, keys and protection, audit log delivery and reading on behalf of people, as well as edge and external sign-in events: silent services, certificates, new connections and networks, and edge network access attempts. Urgent and high alerts are emailed immediately; medium alerts go into a daily digest (admin.alert_digest_hour). Repeated alerts are grouped into one row with a repeat count. Email is sent when mail is enabled and recipients are set in admin.alert_recipients; otherwise alerts appear only here. Undelivered high alerts are sent in one email when mail resumes. Alerts contain no record text, queries or passwords.",
  testHint: "Three test alerts — urgent, high and medium — follow the same path as real alerts: urgent and high alerts arrive by email within a minute; the medium alert goes into the digest (“Prepare digest now”). This checks that alerts reach the person on duty.",
  hostFactsHint: "Guidance, not proof: the host check reports hourly on who can manage containers, passwordless sudo, the deployment runner and the bridge to the edge (on this VM in basic mode). Readiness shows the same facts.",
  quotaHint: "Over 14 days: people whose external requests would have been refused in observe mode (edge.quota_mode) or were refused by daily limits, and on how many days. Before switching from observation to enforcement, check that legitimate work will not be affected.",
  administratorWithoutAProfile: "administrator without a profile",
  repeatedValue1Times: (value1: string | number): string => `repeated ${value1} times`,
  fromTheEdgeValue1: (value1: string | number): string => `from the edge · ${value1}`,
  fromTheEdge: "from the edge",
  mailIsDisabledSmtpEnabled: "mail is disabled (smtp.enabled)",
  noRecipientsSetAdminAlertRecipients: "no recipients set (admin.alert_recipients)",
  alertEmailsAreNotBeingSentValue1AlertsAppear: (value1: string | number): string => `Alert emails are not being sent: ${value1}. Alerts appear only here; high alerts will arrive in one email when mail resumes.`,
  testAlertsQueuedUrgentAndHighAlertsWillArrive: "Test alerts queued: urgent and high alerts will arrive by email within a minute; the medium alert goes into the digest",
  value1ResponseValue2: (value1: string | number, value2: string | number): string => `${value1} (response ${value2})`,
  notQueuedValue1: (value1: string | number): string => `Not queued: ${value1}`,
  digestQueuedEmailsValue1: (value1: string | number): string => `Digest queued: emails — ${value1}`,
  nothingToIncludeNoNewMediumAlertsOrUnreviewed: "Nothing to include: no new medium alerts or unreviewed security alerts",
  alertEmailsAreNotBeingSentEnableMailAnd: "Alert emails are not being sent: enable mail and set recipients",
  notQueuedResponseValue1: (value1: string | number): string => `Not queued: response ${value1}`,
  yes: "yes",
  no: "no",
  no2: "no",
};
